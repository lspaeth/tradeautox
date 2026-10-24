const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const upload = require('../lib/upload');
const { requireLogin } = require('../lib/auth');
const { parseAamva, evaluateScan } = require('../lib/aamva');

const router = express.Router();

router.get('/signup', (req, res) => {
  if (req.session.dealerId) return res.redirect('/dashboard');
  res.render('signup', { error: null });
});

router.post('/signup', upload.single('license_photo'), async (req, res) => {
  try {
    const { dealership_name, contact_name, email, password, phone, license_number, accept_terms, zip, address, city, state } = req.body;
    if (!dealership_name || !contact_name || !email || !password || !license_number) {
      return res.status(400).render('signup', { error: 'Please fill in all required fields.' });
    }
    const { cleanZip, isValidZip } = require('../lib/geo');
    if (!isValidZip(zip)) {
      return res.status(400).render('signup', { error: 'Please enter a valid 5-digit dealership ZIP code.' });
    }
    if (!accept_terms) {
      return res.status(400).render('signup', { error: 'You must accept the Terms of Service to join.' });
    }
    if (password.length < 8) {
      return res.status(400).render('signup', { error: 'Password must be at least 8 characters.' });
    }
    if (db.getDealerByEmail(email.trim().toLowerCase())) {
      return res.status(400).render('signup', { error: 'An account with that email already exists.' });
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
      ...dlFields,
    });
    req.session.dealerId = info.lastInsertRowid;
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).render('signup', { error: 'Something went wrong. Please try again.' });
  }
});

router.get('/login', (req, res) => {
  if (req.session.dealerId) return res.redirect('/dashboard');
  res.render('login', { error: null, notice: req.query.notice || null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const dealer = db.getDealerByEmail((email || '').trim().toLowerCase());
  if (!dealer || !(await bcrypt.compare(password || '', dealer.password_hash))) {
    return res.status(401).render('login', { error: 'Invalid email or password.', notice: null });
  }
  if (dealer.status === 'rejected') {
    return res.status(403).render('login', { error: 'This account was not approved. Contact support.', notice: null });
  }
  if (dealer.status === 'suspended') {
    return res.status(403).render('login', { error: 'This account has been suspended. Contact support.', notice: null });
  }
  req.session.dealerId = dealer.id;
  if (dealer.must_change_password) {
    return res.redirect('/change-password?notice=' + encodeURIComponent('You are using a temporary password. Please set a new one.'));
  }
  res.redirect('/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
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
  res.render('change-password', { error: null, notice: req.query.notice || null });
});

router.post('/change-password', requireLogin, async (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  const { current_password, new_password } = req.body;
  if (!dealer || !(await bcrypt.compare(current_password || '', dealer.password_hash))) {
    return res.status(401).render('change-password', { error: 'Current password is incorrect.', notice: null });
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('change-password', { error: 'New password must be at least 8 characters.', notice: null });
  }
  db.setDealerPassword(dealer.id, await bcrypt.hash(new_password, 12));
  db.setMustChangePassword(dealer.id, 0);
  res.redirect('/dashboard?notice=' + encodeURIComponent('Password updated.'));
});

module.exports = router;
