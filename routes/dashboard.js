const express = require('express');
const db = require('../db');
const { requireLogin } = require('../lib/auth');
const { stripeConfigured } = require('../lib/stripe');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer) { req.session.destroy(() => res.redirect('/login')); return; }
  const listings = db.getDealerListings(dealer.id);
  res.render('dashboard', {
    dealer,
    listings,
    stripeConfigured: stripeConfigured() && !!process.env.STRIPE_PRICE_ID,
  });
});

module.exports = router;
