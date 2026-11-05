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

// Per-employee access levels. 'sell' = list/upload/mark sold/post auctions
// only; 'buy' = buy/bid only; 'both' = everything employees can do.
// The owner and admin sessions are always 'both'.
const ACCESS_LEVELS = ['sell', 'buy', 'both'];
const ACCESS_LEVEL_LABELS = { sell: 'Sell only', buy: 'Buy only', both: 'Sell + buy' };

function isValidAccessLevel(v) { return ACCESS_LEVELS.includes(v); }

function accessLevelLabel(level) {
  return ACCESS_LEVEL_LABELS[level] || ACCESS_LEVEL_LABELS.both;
}

// The access level of the current session. Re-read from the DB on every
// call, so when the owner changes an employee's level it applies on their
// very next request — no session juggling. Owner sessions (and sessions
// created before access levels existed) are 'both'.
function accessLevel(req) {
  const user = currentDealerUser(req);
  if (!user) return 'both';
  return isValidAccessLevel(user.access_level) ? user.access_level : 'both';
}

function canSell(req) { return accessLevel(req) !== 'buy'; }
function canBuy(req) { return accessLevel(req) !== 'sell'; }

// Sell-side guard: listing create/edit, photo upload, mark sold, auction
// post/accept/cancel. Buy-only employees get a plain-language error.
function requireSell(req, res, next) {
  if (!req.session.dealerId) return res.redirect('/login');
  if (!canSell(req)) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Your login is buy-only — selling actions are switched off for you. Ask the dealership owner to change your access level.'));
  }
  next();
}

// Buy-side guard: purchase intents and auction bids. Sell-only employees
// get a plain-language error.
function requireBuy(req, res, next) {
  if (!req.session.dealerId) return res.redirect('/login');
  if (!canBuy(req)) {
    return res.redirect('/dashboard?error=' + encodeURIComponent('Your login is sell-only — buying and bidding are switched off for you. Ask the dealership owner to change your access level.'));
  }
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

module.exports = { currentDealer, currentDealerUser, isOwnerSession, requireLogin, requireMember, requireAdmin, requireOwner, requireMemberOrAdmin, BOARD_ACCESS_STATUSES, ACCESS_LEVELS, isValidAccessLevel, accessLevel, accessLevelLabel, canSell, canBuy, requireSell, requireBuy };
