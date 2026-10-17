const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const upload = require('../lib/upload');
const { requireLogin } = require('../lib/auth');

const router = express.Router();

router.get('/signup', (req, res) => {
  if (req.session.dealerId) return res.redirect('/dashboard');
  res.render('signup', { error: null });
});

router.post('/signup', upload.single('license_photo'), async (req, res) => {
  try {
    const { dealership_name, contact_name, email, password, phone, license_number, accept_terms } = req.body;
    if (!dealership_name || !contact_name || !email || !password || !license_number) {
      return res.status(400).render('signup', { error: 'Please fill in all required fields.' });
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
  req.session.dealerId = dealer.id;
  res.redirect('/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
