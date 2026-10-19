const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    return res.status(500).render('admin-login', { error: 'Admin credentials are not configured on the server.' });
  }
  if (email === adminEmail && password === adminPassword) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.status(401).render('admin-login', { error: 'Invalid admin credentials.' });
});

router.get('/logout', (req, res) => {
  req.session.admin = false;
  res.redirect('/admin/login');
});

router.get('/', requireAdmin, (req, res) => {
  res.render('admin', {
    pending: db.listDealersByStatus('pending'),
    members: db.listAllDealers(),
    resets: db.listOpenPasswordResets(),
  });
});

router.post('/dealers/:id/approve', requireAdmin, (req, res) => {
  db.setDealerStatus(req.params.id, 'approved');
  // Welcome email — fire and forget; approval must not fail if email does.
  const dealer = db.getDealerById(req.params.id);
  if (dealer) {
    const { sendMail, welcomeEmail } = require('../lib/mail');
    const msg = welcomeEmail(dealer);
    sendMail({ to: dealer.email, ...msg }).catch((err) =>
      console.error('[mail] welcome email failed:', err.message));
  }
  res.redirect('/admin');
});

router.post('/dealers/:id/reject', requireAdmin, (req, res) => {
  db.setDealerStatus(req.params.id, 'rejected');
  res.redirect('/admin');
});

// Issue a one-time temporary password for a reset request.
// Shown once on screen — the admin passes it to the dealer directly.
router.post('/resets/:id/issue', requireAdmin, async (req, res) => {
  const reset = db.getPasswordReset(req.params.id);
  if (!reset || reset.used_at) return res.redirect('/admin');
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  const tempPassword = `TAX-${s.slice(0, 4)}-${s.slice(4)}`;
  db.setDealerPassword(reset.dealer_id, await bcrypt.hash(tempPassword, 12));
  db.setMustChangePassword(reset.dealer_id, 1);
  db.markPasswordResetUsed(reset.id);
  res.render('admin-reset-issued', { reset, tempPassword });
});

module.exports = router;
