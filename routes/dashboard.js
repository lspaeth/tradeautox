const express = require('express');
const db = require('../db');
const { requireLogin } = require('../lib/auth');
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
    notice: req.query.notice || null,
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

module.exports = router;
