const express = require('express');
const db = require('../db');
const { requireLogin, BOARD_ACCESS_STATUSES } = require('../lib/auth');
const { stripeConfigured } = require('../lib/stripe');
const { cleanZip, isValidZip, distanceMiles } = require('../lib/geo');
const { daysOnSiteLabel, PAYMENT_METHODS } = require('../lib/listings');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) { req.session.destroy(() => res.redirect('/login')); return; }
  const listings = db.getDealerListings(dealer.id)
    .map((l) => {
      const intent = l.status === 'active' ? db.getPurchaseIntent(l.id) : null;
      return {
        ...l,
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
    notice: req.query.notice || null,
    error: req.query.error || null,
    stripeConfigured: stripeConfigured() && !!process.env.STRIPE_PRICE_ID,
  });
  // Shown once as new; clear the unread flag after rendering.
  if (notifications.length) db.markNotificationsRead(dealer.id);
});

router.post('/zip', requireLogin, (req, res) => {
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
