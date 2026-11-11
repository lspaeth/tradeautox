const db = require('../db');

// Plain-language labels for the admin panel's Recent activity table.
const KIND_LABELS = {
  dealer_login: 'Dealer signed in',
  dealer_login_failed: 'Dealer sign-in failed',
  dealer_login_locked: 'Dealer sign-in locked (too many wrong tries)',
  admin_login: 'Admin signed in',
  admin_login_failed: 'Admin sign-in failed',
  admin_login_locked: 'Admin sign-in locked (too many wrong tries)',
  password_changed: 'Password changed',
  terms_accepted: 'Accepted updated Terms',
  email_verified: 'Email verified',
  dealer_approved: 'Application approved',
  dealer_rejected: 'Application rejected',
  dealer_suspended: 'Dealer suspended',
  dealer_reactivated: 'Dealer reactivated',
  dealer_removed: 'Dealer removed',
  admin_invite_created: 'Admin invite created',
  admin_removed: 'Admin removed',
};

function log(kind, fields = {}) {
  db.logActivity({ kind, ...fields });
}

function label(kind) { return KIND_LABELS[kind] || kind; }

module.exports = { log, label, KIND_LABELS };
