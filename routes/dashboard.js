const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requireOwner, isOwnerSession, currentDealerUser, canSell, canBuy, accessLevel, accessLevelLabel, isValidAccessLevel, BOARD_ACCESS_STATUSES } = require('../lib/auth');
const { stripeConfigured } = require('../lib/stripe');
const { cleanZip, isValidZip, distanceMiles } = require('../lib/geo');
const { daysOnSiteLabel, PAYMENT_METHODS } = require('../lib/listings');
const { wantLabel } = require('../lib/wants');

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
        staleNudged: !!l.stale_nudged_at,
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
  // Referrals: the link is tied to the member ID, so only dealers who have
  // one (approved) can refer. Counts are earned vs still pending payment.
  const baseUrl = (process.env.BASE_URL || 'https://www.tradeautox.com').replace(/\/$/, '');
  const referralLink = dealer.member_number ? `${baseUrl}/signup?ref=${dealer.member_number}` : null;
  const myReferrals = dealer.member_number ? db.listReferralsByReferrer(dealer.id) : [];
  const referralCounts = {
    earned: myReferrals.filter((r) => r.status === 'earned').length,
    pending: myReferrals.filter((r) => r.status !== 'earned').length,
  };
  res.render('dashboard', {
    dealer,
    listings,
    notifications,
    myAuctions,
    liveNearMe,
    tradePartners: db.listTradePartners(dealer.id),
    wants: db.listWants(dealer.id).map((w) => ({ ...w, label: wantLabel(w) })),
    referralLink,
    myReferrals,
    referralCounts,
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

// Save a Want (wish list): make + optional model, year range, max price,
// radius around the dealer's own ZIP. Max 10 per dealer. When a matching
// vehicle lists, the dealer gets an in-app alert + email; Wants are private
// and never shown to anyone else.
router.post('/wants', requireLogin, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) return res.redirect('/login');
  const fail = (msg) => res.redirect('/dashboard?error=' + encodeURIComponent(msg));
  const make = (req.body.make || '').trim();
  const model = (req.body.model || '').trim();
  const yearMin = parseInt(req.body.year_min, 10) || null;
  const yearMax = parseInt(req.body.year_max, 10) || null;
  const maxPrice = parseInt(String(req.body.max_price || '').replace(/[^0-9]/g, ''), 10) || null;
  const radiusRaw = (req.body.radius_miles || '').trim();
  const radiusMiles = radiusRaw === '' ? null
    : ([25, 50, 100, 250].includes(Number(radiusRaw)) ? Number(radiusRaw) : null);
  if (!make) return fail('Enter a make for your Want (e.g. Chevrolet).');
  if (yearMin && (yearMin < 1900 || yearMin > 2100)) return fail('Enter a valid earliest year.');
  if (yearMax && (yearMax < 1900 || yearMax > 2100)) return fail('Enter a valid latest year.');
  if (yearMin && yearMax && yearMin > yearMax) return fail("The earliest year can't be after the latest year.");
  if (maxPrice && maxPrice <= 0) return fail('Enter a valid max price.');
  if (radiusRaw !== '' && radiusMiles == null) return fail('Pick a valid radius for your Want.');
  if (db.countWants(dealer.id) >= 10) return fail('You already have 10 Wants — remove one before adding another.');
  db.createWant(dealer.id, { make, model, yearMin, yearMax, maxPrice, radiusMiles });
  res.redirect('/dashboard?notice=' + encodeURIComponent(
    `Want saved — we'll ping you when a ${make}${model ? ' ' + model : ''} lists${radiusMiles ? ` within ${radiusMiles} miles` : ''}.`));
});

// Remove a Want.
router.post('/wants/:id/remove', requireLogin, (req, res) => {
  db.deleteWant(req.session.dealerId, req.params.id);
  res.redirect('/dashboard?notice=' + encodeURIComponent('Want removed.'));
});

module.exports = router;
