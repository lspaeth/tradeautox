const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const db = require('../db');
const upload = require('../lib/upload');
const { requireLogin } = require('../lib/auth');
const { idleNotice } = require('../lib/idle');
const { TERMS_VERSION, TERMS_WHAT_CHANGED } = require('../lib/terms');
const { lockoutMessage } = require('../lib/lockout');
const activity = require('../lib/activity');
const { parseAamva, evaluateScan } = require('../lib/aamva');

const router = express.Router();

router.get('/signup', (req, res) => {
  if (req.session.dealerId) return res.redirect('/dashboard');
  // Referral link: /signup?ref=<member ID>. Anything that isn't a plain
  // number is ignored — a bad ref must never error a signup.
  const ref = /^\d+$/.test(String(req.query.ref || '')) ? String(req.query.ref) : '';
  res.render('signup', { error: null, form_ts: Date.now(), ref });
});

router.post('/signup', upload.single('license_photo'), async (req, res) => {
  try {
    // ---- invisible anti-spam: honeypot + time trap ----
    // Dumb bots fill every field and/or submit instantly. Never tip them
    // off: no error, no dealer row, no email — just the exact same 302 a
    // legit signup gets, plus a one-line server log.
    const spamTrap = (() => {
      const hp = typeof req.body.website === 'string' ? req.body.website.trim() : '';
      if (hp) return 'honeypot';
      const ts = parseInt(req.body.form_ts, 10);
      if (!Number.isFinite(ts) || ts > Date.now()) return 'time-trap';
      if (Date.now() - ts < 4000) return 'time-trap';
      return null;
    })();
    if (spamTrap) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.log(`[spam] blocked signup (${spamTrap})`);
      return res.redirect('/dashboard');
    }
    const { dealership_name, contact_name, email, password, phone, license_number, accept_terms, zip, address, city, state, dealer_type,
      ein, legal_name, dba, company_type, auction_access_id } = req.body;
    if (!dealership_name || !contact_name || !email || !password || !license_number) {
      return res.status(400).render('signup', { error: 'Please fill in all required fields.', form_ts: Date.now() });
    }
    // ---- AuctionACCESS-style business verification (all required except
    // DBA-when-same-as-legal and the AuctionACCESS ID itself) ----
    // DBA blank = same as the legal name; stored NULL so the admin view can
    // say so plainly instead of showing a duplicated name.
    const COMPANY_TYPES = ['Sole Proprietor', 'Corporation', 'Partnership', 'LLC'];
    if (!legal_name || !legal_name.trim()) {
      return res.status(400).render('signup', { error: 'Please enter the legal business name.', form_ts: Date.now() });
    }
    const einDigits = String(ein || '').replace(/\D/g, '');
    if (einDigits.length !== 9) {
      return res.status(400).render('signup', { error: 'Please enter a valid 9-digit EIN (for example 12-3456789).', form_ts: Date.now() });
    }
    if (!COMPANY_TYPES.includes(company_type)) {
      return res.status(400).render('signup', { error: 'Please choose a company type.', form_ts: Date.now() });
    }
    if (dealer_type !== 'franchise' && dealer_type !== 'other') {
      return res.status(400).render('signup', { error: 'Please choose your dealer type.', form_ts: Date.now() });
    }
    const phoneDigits = String(phone || '').replace(/\D/g, '');
    if (phoneDigits.length < 7) {
      return res.status(400).render('signup', { error: 'Please enter a business phone number.', form_ts: Date.now() });
    }
    if (!address || !address.trim()) {
      return res.status(400).render('signup', { error: 'Please enter the dealership street address.', form_ts: Date.now() });
    }
    const { cleanZip, isValidZip } = require('../lib/geo');
    if (!isValidZip(zip)) {
      return res.status(400).render('signup', { error: 'Please enter a valid 5-digit dealership ZIP code.', form_ts: Date.now() });
    }
    if (!accept_terms) {
      return res.status(400).render('signup', { error: 'You must accept the Terms of Service to join.', form_ts: Date.now() });
    }
    if (password.length < 8) {
      return res.status(400).render('signup', { error: 'Password must be at least 8 characters.', form_ts: Date.now() });
    }
    if (db.getDealerByEmail(email.trim().toLowerCase()) || db.getDealerUserByEmail(email.trim().toLowerCase())) {
      return res.status(400).render('signup', { error: 'An account with that email already exists.', form_ts: Date.now() });
    }
    // Driver's-license scan (optional): the browser decoded the DL barcode
    // and submitted only its text payload (base64 — plain form fields get
    // their CR/LFs normalized, which would corrupt the payload's byte
    // offsets). The license image never left the applicant's phone. Parse +
    // check server-side; a missing or unreadable payload simply means
    // "not scanned" and never blocks signup.
    let dlFields = {};
    const dlPayloadB64 = typeof req.body.dl_payload === 'string' ? req.body.dl_payload.trim() : '';
    const dlPayload = dlPayloadB64
      ? Buffer.from(dlPayloadB64, 'base64').toString('latin1')
      : '';
    if (dlPayload) {
      const parsed = parseAamva(dlPayload);
      if (parsed) {
        const checks = evaluateScan(parsed, contact_name);
        dlFields = {
          dl_scanned_at: new Date().toISOString(),
          dl_name: parsed.fullName,
          dl_dob: parsed.dob,
          dl_expires: parsed.expires,
          dl_number: parsed.licenseNumber,
          dl_address: parsed.address,
          dl_city: parsed.city,
          dl_state: parsed.state,
          dl_zip: parsed.zip,
          dl_name_match: checks.nameMatch,
          dl_expired: checks.expired === null ? null : (checks.expired ? 1 : 0),
        };
      }
    }
    const password_hash = await bcrypt.hash(password, 12);
    // ---- Referral: ?ref=<member ID> (or the ID typed on the form). Resolve
    // it to a real dealer; anything else is ignored silently — a bad ref
    // must never error a signup. Self-referral can't happen: the email
    // check above guarantees the applicant isn't an existing dealer, and
    // the demo dealer can't refer anyone.
    let referredByDealerId = null;
    const refNum = /^\d+$/.test(String(req.body.ref || '').trim())
      ? parseInt(String(req.body.ref).trim(), 10) : null;
    if (refNum) {
      const referrer = db.getDealerByMemberNumber(refNum);
      if (referrer && referrer.email !== db.DEMO_DEALER_EMAIL) {
        referredByDealerId = referrer.id;
      }
    }
    const info = db.createDealer({
      dealership_name: dealership_name.trim(),
      contact_name: contact_name.trim(),
      email: email.trim().toLowerCase(),
      password_hash,
      phone: (phone || '').trim(),
      license_number: license_number.trim(),
      license_photo_path: req.file ? `/uploads/${req.file.filename}` : null,
      terms_accepted_at: new Date().toISOString(),
      terms_version: TERMS_VERSION,
      email_verified: 0,
      zip: cleanZip(zip),
      address: (address || '').trim(),
      city: (city || '').trim(),
      state: (state || '').trim(),
      dealer_type,
      referred_by_dealer_id: referredByDealerId,
      ein: einDigits.slice(0, 2) + '-' + einDigits.slice(2),
      legal_name: legal_name.trim(),
      dba: (dba || '').trim() || null,
      company_type,
      // Optional supporting evidence only: an AuctionACCESS ID means the
      // dealer already passed AutoTec's vetting, which can speed approval —
      // but there is no public API to check it, so it never substitutes for
      // the license, EIN, or any other check above.
      auction_access_id: (auction_access_id || '').trim() || null,
      ...dlFields,
    });
    // Record the referral row (the reward-tracking record). Never let a
    // referral failure break a signup — the dealer row is already saved.
    if (referredByDealerId) {
      try {
        db.createReferral(referredByDealerId, info.lastInsertRowid);
      } catch (err) {
        console.error('[referral] could not record referral:', err.message);
      }
    }
    // ---- Email verification: the dealer proves the address works before
    // they can sign in. No auto-login here — the link in the email signs
    // them in. Existing dealers are grandfathered verified (see db.js).
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    db.setEmailVerifyToken(info.lastInsertRowid, verifyToken, verifyExpires);
    const newDealer = db.getDealerById(info.lastInsertRowid);
    const { sendMail, verificationEmail } = require('../lib/mail');
    const msg = verificationEmail(newDealer, verifyToken);
    sendMail({ to: newDealer.email, ...msg }).catch((err) =>
      console.error('[verify] verification email failed:', err.message));
    res.render('verify-email-sent', { email: newDealer.email });
  } catch (err) {
    console.error(err);
    res.status(500).render('signup', { error: 'Something went wrong. Please try again.', form_ts: Date.now() });
  }
});

// ---- email verification ----
// The link from the signup email. Verifies the address, then signs the
// dealer straight in — their application is in the approval queue.
router.get('/verify-email', (req, res) => {
  const token = String(req.query.token || '');
  const dealer = token ? db.getDealerByVerifyToken(token) : null;
  if (!dealer || !dealer.email_verify_expires || new Date(dealer.email_verify_expires).getTime() <= Date.now()) {
    return res.status(400).render('resend-verification', {
      error: 'That verification link is expired or already used — request a new one below.',
      notice: null,
    });
  }
  db.setDealerEmailVerified(dealer.id);
  activity.log('email_verified', { dealerId: dealer.id, email: dealer.email });
  req.session.dealerId = dealer.id;
  req.session.dealerRole = 'owner';
  req.session.lastActivity = Date.now();
  res.redirect('/dashboard?notice=' + encodeURIComponent('Email verified — your application is in the approval queue. We\u2019ll email you when it\u2019s approved.'));
});

// Request a fresh verification link (expired link, or the first email
// never arrived). Never reveals whether the email has an account.
router.get('/resend-verification', (req, res) => {
  res.render('resend-verification', { error: null, notice: null });
});

router.post('/resend-verification', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const dealer = email ? db.getDealerByEmail(email) : null;
  if (dealer && !dealer.email_verified) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    db.setEmailVerifyToken(dealer.id, token, expires);
    const { sendMail, verificationEmail } = require('../lib/mail');
    const msg = verificationEmail(dealer, token);
    sendMail({ to: dealer.email, ...msg }).catch((err) =>
      console.error('[verify] resend failed:', err.message));
  }
  res.render('resend-verification', {
    error: null,
    notice: 'If that email has an unverified TradeAutoX application, a new verification link is on its way.',
  });
});

router.get('/login', (req, res) => {
  if (req.session.dealerId) return res.redirect('/dashboard');
  res.render('login', { error: null, notice: req.query.notice || null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = (email || '').trim().toLowerCase();
  // Lockout first: a locked account never burns CPU on password guesses.
  // The message never reveals whether the email has an account.
  const lockedUntil = db.isLoginLocked(cleanEmail, 'dealer');
  if (lockedUntil) {
    return res.status(429).render('login', { error: lockoutMessage(lockedUntil), notice: null });
  }
  const fail = () => res.status(401).render('login', { error: 'Invalid email or password.', notice: null });
  // Owner login first — the dealers table is unchanged by employee logins.
  const dealer = db.getDealerByEmail(cleanEmail);
  if (dealer && (await bcrypt.compare(password || '', dealer.password_hash))) {
    if (dealer.status === 'rejected') {
      return res.status(403).render('login', { error: 'This account was not approved. Contact support.', notice: null });
    }
    if (dealer.status === 'suspended') {
      return res.status(403).render('login', { error: 'This account has been suspended. Contact support.', notice: null });
    }
    if (!dealer.email_verified) {
      return res.status(403).render('login', { error: 'Please verify your email first — we sent a link to ' + dealer.email + '. Didn\u2019t get it? Request a new one below.', notice: null });
    }
    db.clearLoginAttempts(cleanEmail, 'dealer');
    activity.log('dealer_login', { dealerId: dealer.id, email: dealer.email });
    req.session.dealerId = dealer.id;
    req.session.dealerRole = 'owner';
    req.session.lastActivity = Date.now();
    if (dealer.must_change_password) {
      return res.redirect('/change-password?notice=' + encodeURIComponent('You are using a temporary password. Please set a new one.'));
    }
    if (dealer.terms_version !== TERMS_VERSION) {
      return res.redirect('/terms/accept');
    }
    return res.redirect('/dashboard');
  }
  if (dealer) {
    // Real dealer, wrong password — counts toward the lockout.
    const r = db.recordLoginFailure(cleanEmail, 'dealer');
    activity.log('dealer_login_failed', { dealerId: dealer.id, email: cleanEmail });
    if (r.newlyLocked) activity.log('dealer_login_locked', { dealerId: dealer.id, email: cleanEmail });
    return fail();
  }
  // Employee login: same dealership, own email + password. Only when the
  // owner switched employee logins on, and only while the employee is active.
  const user = db.getDealerUserByEmail(cleanEmail);
  if (user && user.active && (await bcrypt.compare(password || '', user.password_hash))) {
    const org = db.getDealerById(user.dealer_id);
    if (org && org.employee_logins_enabled) {
      if (org.status === 'rejected') {
        return res.status(403).render('login', { error: 'This account was not approved. Contact support.', notice: null });
      }
      if (org.status === 'suspended') {
        return res.status(403).render('login', { error: 'This account has been suspended. Contact support.', notice: null });
      }
      if (!org.email_verified) {
        return res.status(403).render('login', { error: 'Please verify your email first — the dealership\u2019s email needs confirming before anyone can sign in.', notice: null });
      }
      db.clearLoginAttempts(cleanEmail, 'dealer');
      activity.log('dealer_login', { dealerId: org.id, email: cleanEmail, detail: `Employee ${user.name} signed in` });
      req.session.dealerId = org.id;
      req.session.dealerUserId = user.id;
      req.session.dealerRole = 'user';
      req.session.lastActivity = Date.now();
      if (user.must_change_password) {
        return res.redirect('/change-password?notice=' + encodeURIComponent('You are using a temporary password. Please set a new one.'));
      }
      if (org.terms_version !== TERMS_VERSION) {
        return res.redirect('/terms/accept');
      }
      return res.redirect('/dashboard');
    }
  }
  if (user && user.active) {
    // Real employee, wrong password — counts toward the lockout.
    const r = db.recordLoginFailure(cleanEmail, 'dealer');
    activity.log('dealer_login_failed', { dealerId: user.dealer_id, email: cleanEmail });
    if (r.newlyLocked) activity.log('dealer_login_locked', { dealerId: user.dealer_id, email: cleanEmail });
  }
  // Unknown email: the same message as a wrong password — never reveal
  // whether the email has an account.
  return fail();
});

// ---- updated Terms acceptance ----
// A dealer whose recorded Terms version is older than the current one
// lands here on login (and on any later page load, via the middleware in
// lib/auth). One tap records the acceptance with a timestamp.
router.get('/terms/accept', requireLogin, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) return res.redirect('/login');
  if (dealer.terms_version === TERMS_VERSION) return res.redirect('/dashboard');
  res.render('terms-accept', { dealer, whatChanged: TERMS_WHAT_CHANGED, termsVersion: TERMS_VERSION });
});

router.post('/terms/accept', requireLogin, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) return res.redirect('/login');
  db.setDealerTermsVersion(dealer.id, TERMS_VERSION);
  activity.log('terms_accepted', { dealerId: dealer.id, email: dealer.email, detail: `Accepted Terms version ${TERMS_VERSION}` });
  res.redirect('/dashboard?notice=' + encodeURIComponent('Thanks — you\u2019re up to date on the Terms.'));
});

router.get('/logout', (req, res) => {
  const idle = req.query.idle;
  req.session.destroy(() => {
    // Idle auto-logout lands back on the login page with the reason shown.
    if (idle) return res.redirect('/login?notice=' + encodeURIComponent(idleNotice()));
    res.redirect('/');
  });
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---- forgot password (admin-assisted: no email service needed) ----
router.get('/forgot-password', (req, res) => {
  if (req.session.dealerId) return res.redirect('/dashboard');
  res.render('forgot-password', { error: null, notice: null });
});

router.post('/forgot-password', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const dealer = email ? db.getDealerByEmail(email) : null;
  // Only approved dealers can request a reset; never reveal whether the email exists.
  if (dealer && dealer.status === 'approved' && !db.hasOpenPasswordReset(dealer.id)) {
    db.createPasswordReset(dealer.id);
  }
  res.render('forgot-password', {
    error: null,
    notice: 'If an account exists for that email, the administrator has been notified. You will receive a temporary password shortly.',
  });
});

// ---- change password ----
router.get('/change-password', requireLogin, (req, res) => {
  let mustChange = false;
  if (req.session.dealerUserId) {
    const u = db.getDealerUserById(req.session.dealerUserId);
    mustChange = !!(u && u.must_change_password);
  } else if (req.session.dealerId) {
    const d = db.getDealerById(req.session.dealerId);
    mustChange = !!(d && d.must_change_password);
  }
  res.render('change-password', { error: null, notice: req.query.notice || null, mustChange });
});

router.post('/change-password', requireLogin, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('change-password', { error: 'New password must be at least 8 characters.', notice: null });
  }
  // Employee sessions change the employee's own password, not the org's.
  if (req.session.dealerUserId) {
    const user = db.getDealerUserById(req.session.dealerUserId);
    if (!user || !(await bcrypt.compare(current_password || '', user.password_hash))) {
      return res.status(401).render('change-password', { error: 'Current password is incorrect.', notice: null });
    }
    db.setDealerUserPassword(user.id, await bcrypt.hash(new_password, 12));
    db.setDealerUserMustChange(user.id, 0);
    activity.log('password_changed', { dealerId: user.dealer_id, email: user.email });
    return res.redirect('/dashboard?notice=' + encodeURIComponent('Password updated.'));
  }
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer || !(await bcrypt.compare(current_password || '', dealer.password_hash))) {
    return res.status(401).render('change-password', { error: 'Current password is incorrect.', notice: null });
  }
  db.setDealerPassword(dealer.id, await bcrypt.hash(new_password, 12));
  db.setMustChangePassword(dealer.id, 0);
  activity.log('password_changed', { dealerId: dealer.id, email: dealer.email });
  res.redirect('/dashboard?notice=' + encodeURIComponent('Password updated.'));
});

module.exports = router;
