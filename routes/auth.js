const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const db = require('../db');
const upload = require('../lib/upload');
const { requireLogin } = require('../lib/auth');
const { idleNotice } = require('../lib/idle');
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
    req.session.dealerId = info.lastInsertRowid;
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).render('signup', { error: 'Something went wrong. Please try again.', form_ts: Date.now() });
  }
});

router.get('/login', (req, res) => {
  if (req.session.dealerId) return res.redirect('/dashboard');
  res.render('login', { error: null, notice: req.query.notice || null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = (email || '').trim().toLowerCase();
  // Owner login first — the dealers table is unchanged by employee logins.
  const dealer = db.getDealerByEmail(cleanEmail);
  if (dealer && (await bcrypt.compare(password || '', dealer.password_hash))) {
    if (dealer.status === 'rejected') {
      return res.status(403).render('login', { error: 'This account was not approved. Contact support.', notice: null });
    }
    if (dealer.status === 'suspended') {
      return res.status(403).render('login', { error: 'This account has been suspended. Contact support.', notice: null });
    }
    req.session.dealerId = dealer.id;
    req.session.dealerRole = 'owner';
    req.session.lastActivity = Date.now();
    if (dealer.must_change_password) {
      return res.redirect('/change-password?notice=' + encodeURIComponent('You are using a temporary password. Please set a new one.'));
    }
    return res.redirect('/dashboard');
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
      req.session.dealerId = org.id;
      req.session.dealerUserId = user.id;
      req.session.dealerRole = 'user';
      req.session.lastActivity = Date.now();
      if (user.must_change_password) {
        return res.redirect('/change-password?notice=' + encodeURIComponent('You are using a temporary password. Please set a new one.'));
      }
      return res.redirect('/dashboard');
    }
  }
  return res.status(401).render('login', { error: 'Invalid email or password.', notice: null });
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
    return res.redirect('/dashboard?notice=' + encodeURIComponent('Password updated.'));
  }
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer || !(await bcrypt.compare(current_password || '', dealer.password_hash))) {
    return res.status(401).render('change-password', { error: 'Current password is incorrect.', notice: null });
  }
  db.setDealerPassword(dealer.id, await bcrypt.hash(new_password, 12));
  db.setMustChangePassword(dealer.id, 0);
  res.redirect('/dashboard?notice=' + encodeURIComponent('Password updated.'));
});

module.exports = router;
