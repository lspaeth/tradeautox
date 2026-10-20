const express = require('express');
const db = require('../db');
const upload = require('../lib/upload');
const { requireMember, requireMemberOrAdmin } = require('../lib/auth');
const { createListingFromRequest } = require('../lib/listings');
const { decodeVin } = require('../lib/vin');

const router = express.Router();

// VIN decode API — logged-in dealers and admins (used by the listing form)
router.get('/api/decode-vin', (req, res) => {
  if (!req.session.dealerId && !req.session.admin) {
    return res.status(401).json({ error: 'Login required.' });
  }
  decodeVin(req.query.vin)
    .then((result) => res.json(result))
    .catch(() => res.status(500).json({ error: 'VIN lookup failed — fill in the details manually.' }));
});

// Browse / search — members and admin
router.get('/', requireMemberOrAdmin, (req, res) => {
  const { make, max_price, radius, zip } = req.query;
  const { cleanZip, isValidZip, distanceMiles } = require('../lib/geo');
  const { currentDealer } = require('../lib/auth');
  let listings = db.searchListings({ make: (make || '').trim(), maxPrice: max_price || null });

  // Radius filter: distance from the viewer's ZIP (or a typed ZIP) to each seller's ZIP.
  const viewer = currentDealer(req);
  const centerZip = isValidZip(zip) ? cleanZip(zip) : (viewer && isValidZip(viewer.zip) ? viewer.zip : null);
  const radiusNum = [25, 50, 100, 250].includes(Number(radius)) ? Number(radius) : null;
  listings = listings.map((l) => ({
    ...l,
    distance: centerZip ? distanceMiles(centerZip, l.seller_zip) : null,
  }));
  let radiusNoZip = false;
  if (radiusNum) {
    if (!centerZip) {
      radiusNoZip = true;
    } else {
      listings = listings.filter((l) => l.distance != null && l.distance <= radiusNum)
        .sort((a, b) => a.distance - b.distance);
    }
  }
  res.render('listings', {
    listings,
    radiusNoZip,
    centerZip,
    filters: { make: make || '', max_price: max_price || '', radius: radius || '', zip: zip || '' },
  });
});

// New listing form
router.get('/new', requireMember, (req, res) => {
  res.render('listing-new', { error: null, formAction: '/listings', heading: 'Sell a vehicle', isAdmin: false });
});

// Create listing (up to 8 photos + optional verification report)
router.post('/', requireMember, upload.listingUpload, (req, res) => {
  try {
    const listingId = createListingFromRequest(req.dealer.id, req.body, req.files);
    res.redirect(`/listings/${listingId}`);
  } catch (err) {
    console.error(err);
    res.status(400).render('listing-new', {
      error: err.message || 'Something went wrong saving your listing.',
      formAction: '/listings', heading: 'Sell a vehicle', isAdmin: false,
    });
  }
});

// Listing detail — members and admin
router.get('/:id', requireMemberOrAdmin, (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).render('404');
  const photos = db.getListingPhotos(listing.id);
  const canManage = !!req.session.admin || req.session.dealerId === listing.dealer_id;
  res.render('listing-detail', { listing, photos, canManage });
});

// Mark sold / remove (owner only)
router.post('/:id/status', requireMember, (req, res) => {
  const { status } = req.body;
  if (!['sold', 'removed'].includes(status)) return res.redirect('/dashboard');
  db.setListingStatus(req.params.id, req.dealer.id, status);
  res.redirect('/dashboard');
});

module.exports = router;
