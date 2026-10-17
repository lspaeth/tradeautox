const express = require('express');
const db = require('../db');
const upload = require('../lib/upload');
const { requireMember } = require('../lib/auth');

const router = express.Router();

// Browse / search — members only
router.get('/', requireMember, (req, res) => {
  const { make, max_price } = req.query;
  const listings = db.searchListings({ make: (make || '').trim(), maxPrice: max_price || null });
  res.render('listings', { listings, filters: { make: make || '', max_price: max_price || '' } });
});

// New listing form
router.get('/new', requireMember, (req, res) => {
  res.render('listing-new', { error: null });
});

// Create listing (up to 8 photos + optional verification report)
router.post('/', requireMember, upload.listingUpload, (req, res) => {
  try {
    const { make, model, year, vin, mileage, price, description } = req.body;
    if (!make || !model || !year || !price) {
      return res.status(400).render('listing-new', { error: 'Make, model, year, and asking price are required.' });
    }
    const yearNum = parseInt(year, 10);
    const priceNum = parseInt(String(price).replace(/[^0-9]/g, ''), 10);
    if (!yearNum || yearNum < 1900 || yearNum > 2100 || !priceNum || priceNum <= 0) {
      return res.status(400).render('listing-new', { error: 'Please enter a valid year and price.' });
    }
    const info = db.createListing({
      dealer_id: req.dealer.id,
      make: make.trim(),
      model: model.trim(),
      year: yearNum,
      vin: (vin || '').trim().toUpperCase(),
      mileage: mileage ? parseInt(String(mileage).replace(/[^0-9]/g, ''), 10) || null : null,
      price: priceNum,
      description: (description || '').trim(),
      verification_report: req.files && req.files.verification_report ? `/uploads/${req.files.verification_report[0].filename}` : null,
    });
    for (const f of (req.files && req.files.photos) || []) {
      db.addListingPhoto(info.lastInsertRowid, `/uploads/${f.filename}`);
    }
    res.redirect(`/listings/${info.lastInsertRowid}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('listing-new', { error: 'Something went wrong saving your listing.' });
  }
});

// Listing detail
router.get('/:id', requireMember, (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).render('404');
  const photos = db.getListingPhotos(listing.id);
  res.render('listing-detail', { listing, photos });
});

// Mark sold / remove (owner only)
router.post('/:id/status', requireMember, (req, res) => {
  const { status } = req.body;
  if (!['sold', 'removed'].includes(status)) return res.redirect('/dashboard');
  db.setListingStatus(req.params.id, req.dealer.id, status);
  res.redirect('/dashboard');
});

module.exports = router;
