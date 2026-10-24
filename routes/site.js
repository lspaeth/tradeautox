const express = require('express');
const router = express.Router();
const db = require('../db');

// /version answers with no-store so it can never be mistaken for a cached page.
// The commit comes from Railway, which injects RAILWAY_GIT_COMMIT_SHA into every
// deployment; server.js copies it into app.locals.buildCommit.
router.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    commit: req.app.locals.buildCommit || 'unknown',
    branch: process.env.RAILWAY_GIT_BRANCH || null,
  });
});

router.get('/', (req, res) => {
  // Hero card is wired to a real board listing. Only public-safe fields reach the
  // template: no price (public price box reads "Approved dealers only"), no seller
  // name, contact, or VIN. If the board has no active listing, no card renders.
  let featured = null;
  try {
    const row = db.getFeaturedListing();
    if (row) {
      featured = {
        year: row.year,
        make: row.make,
        model: row.model,
        trim: row.trim || null,
        mileage: row.mileage || null,
        photo: row.photo || null,
        verified: !!row.verification_report,
        is_demo: row.dealer_email === db.DEMO_DEALER_EMAIL,
      };
    }
  } catch (e) { featured = null; }
  res.render('index', { featured });
});

router.get('/about', (req, res) => {
  res.render('about', { title: 'About Us' });
});

router.get('/terms', (req, res) => {
  res.render('terms');
});

router.get('/privacy', (req, res) => {
  res.render('privacy');
});

module.exports = router;
