const express = require('express');
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
  });
});

router.post('/dealers/:id/approve', requireAdmin, (req, res) => {
  db.setDealerStatus(req.params.id, 'approved');
  res.redirect('/admin');
});

router.post('/dealers/:id/reject', requireAdmin, (req, res) => {
  db.setDealerStatus(req.params.id, 'rejected');
  res.redirect('/admin');
});

module.exports = router;
