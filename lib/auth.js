const db = require('../db');

function currentDealer(req) {
  return req.session.dealerId ? db.getDealerById(req.session.dealerId) : null;
}

// The signed-in employee, if this session is an employee login (null for the
// owner — and for sessions created before employee logins existed).
function currentDealerUser(req) {
  return req.session.dealerUserId ? db.getDealerUserById(req.session.dealerUserId) : null;
}

// True when the session belongs to the dealership owner. Employee sessions
// carry dealerUserId; owner sessions never do (including sessions created
// before employee logins existed).
function isOwnerSession(req) {
  return !!req.session.dealerId && !req.session.dealerUserId;
}

function requireLogin(req, res, next) {
  if (!req.session.dealerId) return res.redirect('/login');
  next();
}

// Membership statuses that grant board access. A past_due dealer (card
// failing, Stripe still retrying) keeps FULL access — they're flagged as a
// payment problem for the admin, not locked out. Access ends only when
// Stripe gives up and the membership flips to 'inactive'.
const BOARD_ACCESS_STATUSES = ['active', 'past_due'];

// Approved dealer with a live membership (active, or past_due-but-retrying).
function requireMember(req, res, next) {
  const dealer = currentDealer(req);
  if (!dealer) return res.redirect('/login');
  if (dealer.status !== 'approved' || !BOARD_ACCESS_STATUSES.includes(dealer.membership_status)) {
    return res.redirect('/dashboard');
  }
  req.dealer = dealer;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

// Owner-only: billing, employee management, dealership profile edits.
// Employees trade (list, buy, bid, mark sold) but never touch these.
function requireOwner(req, res, next) {
  const dealer = currentDealer(req);
  if (!dealer) return res.redirect('/login');
  if (!isOwnerSession(req)) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Only the dealership owner can do that.'));
  }
  req.dealer = dealer;
  next();
}

// Approved dealer with an active paid membership, or the admin (for demos/support).
function requireMemberOrAdmin(req, res, next) {
  if (req.session.admin) return next();
  return requireMember(req, res, next);
}

module.exports = { currentDealer, currentDealerUser, isOwnerSession, requireLogin, requireMember, requireAdmin, requireOwner, requireMemberOrAdmin, BOARD_ACCESS_STATUSES };
