const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requireOwner, isOwnerSession, currentDealerUser, canSell, canBuy, accessLevel, accessLevelLabel, isValidAccessLevel, BOARD_ACCESS_STATUSES } = require('../lib/auth');
const { stripeConfigured } = require('../lib/stripe');
const { cleanZip, isValidZip, distanceMiles } = require('../lib/geo');
const { daysOnSiteLabel, PAYMENT_METHODS } = require('../lib/listings');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) { req.session.destroy(() => res.redirect('/login')); return; }
  const employeeUser = currentDealerUser(req);
  const listings = db.getDealerListings(dealer.id)
    .map((l) => {
      const intent = l.status === 'active' ? db.getPurchaseIntent(l.id) : null;
      return {
        ...l,
        photoCounts: db.getListingPhotoCounts(l.id),
        daysOnSite: daysOnSiteLabel(l.created_at),
        pendingSale: intent ? (PAYMENT_METHODS[intent.method] || intent.method) : null,
        pendingBuyer: intent ? intent.buyer_name : null,
        pendingDays: intent ? Math.max(0, Math.floor((Date.now() - new Date(intent.created_at + 'Z').getTime()) / 86400000)) : null,
      };
    });
  const notifications = db.listUnreadNotifications(dealer.id);
  const myAuctions = db.getDealerAuctions(dealer.id).slice(0, 5);
  const liveNearMe = dealer.zip
    ? db.listAuctions().filter((a) => a.status === 'live' && a.dealer_id !== dealer.id)
        .map((a) => ({ ...a, distance: distanceMiles(dealer.zip, a.seller_zip) }))
        .filter((a) => a.distance != null && a.distance <= a.radius)
    : [];
  res.render('dashboard', {
    dealer,
    listings,
    notifications,
    myAuctions,
    liveNearMe,
    tradePartners: db.listTradePartners(dealer.id),
    isOwner: isOwnerSession(req),
    employeeUser,
    canSell: canSell(req),
    canBuy: canBuy(req),
    employeeAccessLabel: employeeUser ? accessLevelLabel(accessLevel(req)) : null,
    mustChangePassword: employeeUser ? !!employeeUser.must_change_password : !!dealer.must_change_password,
    employees: isOwnerSession(req) ? db.listDealerUsers(dealer.id) : [],
    notice: req.query.notice || null,
    error: req.query.error || null,
    stripeConfigured: stripeConfigured() && !!process.env.STRIPE_PRICE_ID,
  });
  // Shown once as new; clear the unread flag after rendering.
  if (notifications.length) db.markNotificationsRead(dealer.id);
});

router.post('/zip', requireOwner, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) return res.redirect('/login');
  if (!isValidZip(req.body.zip)) {
    return res.redirect('/dashboard?notice=' + encodeURIComponent('Please enter a valid 5-digit ZIP code.'));
  }
  db.setDealerZip(dealer.id, cleanZip(req.body.zip));
  db.setDealerAddress(dealer.id, {
    address: (req.body.address || '').trim(),
    city: (req.body.city || '').trim(),
    state: (req.body.state || '').trim(),
  });
  res.redirect('/dashboard?notice=' + encodeURIComponent('Dealership address saved.'));
});

// ---- Employee logins (owner only) ----
// Toggle: off = the dealership is owner-only, exactly as before; on = the
// Employees section below opens up and employee logins work.
router.post('/employee-logins', requireOwner, (req, res) => {
  const on = req.body.enabled === '1';
  db.setEmployeeLoginsEnabled(req.session.dealerId, on);
  res.redirect('/dashboard?notice=' + encodeURIComponent(
    on ? 'Employee logins are on — add people below and they can sign in with their own email.'
       : 'Employee logins are off — only the owner login works now.'));
});

// Add an employee: name + email + temporary password + access level
// (sell only / buy only / both — defaults to both, i.e. today's behavior).
// First login forces a password change. Email must be unique across all
// dealers and employees.
router.post('/employees', requireOwner, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) return res.redirect('/login');
  const fail = (msg) => res.redirect('/dashboard?error=' + encodeURIComponent(msg));
  if (!dealer.employee_logins_enabled) return fail('Switch employee logins on first.');
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const tempPassword = req.body.temp_password || '';
  const level = isValidAccessLevel(req.body.access_level) ? req.body.access_level : 'both';
  if (!name || !email || !/.+@.+\..+/.test(email)) return fail('Enter the employee\u2019s name and a valid email address.');
  if (tempPassword.length < 8) return fail('Temporary password must be at least 8 characters.');
  if (db.getDealerByEmail(email) || db.getDealerUserByEmail(email)) {
    return fail('That email already has an account — every login needs its own email.');
  }
  db.createDealerUser({
    dealer_id: dealer.id,
    name,
    email,
    password_hash: bcrypt.hashSync(tempPassword, 12),
    access_level: level,
  });
  res.redirect('/dashboard?notice=' + encodeURIComponent(
    `${name} can now sign in with ${email} and the temporary password — they\u2019ll set their own password on first login. Access: ${accessLevelLabel(level)}.`));
});

// Change an employee's access level. Applies on their next request.
router.post('/employees/:id/access', requireOwner, (req, res) => {
  const user = db.getDealerUserById(req.params.id);
  if (!user || user.dealer_id !== req.session.dealerId) return res.redirect('/dashboard');
  const level = req.body.access_level;
  if (!isValidAccessLevel(level)) return res.redirect('/dashboard?error=' + encodeURIComponent('Pick an access level: sell only, buy only, or both.'));
  db.setDealerUserAccessLevel(user.id, user.dealer_id, level);
  res.redirect('/dashboard?notice=' + encodeURIComponent(
    `${user.name} now has ${accessLevelLabel(level).toLowerCase()} access.`));
});

// Deactivate / reactivate one employee. Deactivated employees can't log in;
// their past activity stays under the dealership.
router.post('/employees/:id/toggle', requireOwner, (req, res) => {
  const user = db.getDealerUserById(req.params.id);
  if (!user || user.dealer_id !== req.session.dealerId) return res.redirect('/dashboard');
  db.setDealerUserActive(user.id, user.dealer_id, user.active ? 0 : 1);
  res.redirect('/dashboard?notice=' + encodeURIComponent(
    user.active ? `${user.name} can no longer sign in.` : `${user.name} can sign in again.`));
});

// Trade partners (one-sided follow, v1): add a dealer by member ID.
router.post('/trade-partners', requireLogin, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) return res.redirect('/login');
  const fail = (msg) => res.redirect('/dashboard?error=' + encodeURIComponent(msg));
  const raw = (req.body.member_number || '').trim();
  const n = parseInt(raw, 10);
  if (!n) return fail('Enter a dealer ID to add.');
  const partner = db.getDealerByMemberNumber(n);
  if (!partner) return fail(`No dealer found with ID ${raw}.`);
  if (partner.id === dealer.id) return fail("You can't add yourself as a trade partner.");
  if (partner.status !== 'approved' || !BOARD_ACCESS_STATUSES.includes(partner.membership_status)) {
    return fail(`${partner.dealership_name} (ID ${n}) isn't an approved, active member right now.`);
  }
  if (db.listTradePartners(dealer.id).some((p) => p.id === partner.id)) {
    return fail(`${partner.dealership_name} (ID ${n}) is already one of your trade partners.`);
  }
  db.addTradePartner(dealer.id, partner.id);
  res.redirect('/dashboard?notice=' + encodeURIComponent(`Added ${partner.dealership_name} (ID ${n}) to your trade partners.`));
});

// Remove a trade partner.
router.post('/trade-partners/:partnerId/remove', requireLogin, (req, res) => {
  db.removeTradePartner(req.session.dealerId, req.params.partnerId);
  res.redirect('/dashboard?notice=' + encodeURIComponent('Trade partner removed.'));
});

module.exports = router;
