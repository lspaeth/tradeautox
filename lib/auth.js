const db = require('../db');

function currentDealer(req) {
  return req.session.dealerId ? db.getDealerById(req.session.dealerId) : null;
}

function requireLogin(req, res, next) {
  if (!req.session.dealerId) return res.redirect('/login');
  next();
}

// Approved dealer with an active paid membership.
function requireMember(req, res, next) {
  const dealer = currentDealer(req);
  if (!dealer) return res.redirect('/login');
  if (dealer.status !== 'approved' || dealer.membership_status !== 'active') {
    return res.redirect('/dashboard');
  }
  req.dealer = dealer;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

// Approved dealer with an active paid membership, or the admin (for demos/support).
function requireMemberOrAdmin(req, res, next) {
  if (req.session.admin) return next();
  return requireMember(req, res, next);
}

module.exports = { currentDealer, requireLogin, requireMember, requireAdmin, requireMemberOrAdmin };
