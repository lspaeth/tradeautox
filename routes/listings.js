const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const db = require('../db');
const upload = require('../lib/upload');
const { requireMember, requireMemberOrAdmin } = require('../lib/auth');
const { createListingFromRequest, collectPhotos, publishDraftIfReady, photoMinimumMessage, MIN_PHOTOS, daysOnSiteLabel, PAYMENT_METHODS } = require('../lib/listings');
const { decodeVin, isValidVin, cleanVin } = require('../lib/vin');
const { rowsToObjects } = require('../lib/csv');

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

// Browse / search — members and admin.
// Search types (tab row, modeled on GM DealerWorld): Zip Code (default, the
// existing filters), ID (one dealer's inventory by member number), Trade
// Partners (the viewer's saved partners; dealer sessions only, not admin).
router.get('/', requireMemberOrAdmin, (req, res) => {
  const { make, max_price, radius, zip, search_type, member_number } = req.query;
  const { cleanZip, isValidZip, distanceMiles } = require('../lib/geo');
  const { currentDealer, BOARD_ACCESS_STATUSES } = require('../lib/auth');
  const viewer = currentDealer(req);
  const isDealer = !!viewer && !req.session.admin;

  let searchType = ['zip', 'id', 'partners'].includes(search_type) ? search_type : 'zip';
  if (searchType === 'partners' && !isDealer) searchType = 'zip';

  // "Trade partners only" toggle: an on/off filter that narrows whatever the
  // user is currently viewing to listings from their saved trade partners.
  // Dealer sessions only — admins and logged-out visitors never see it.
  const partnersOnly = req.query.partners_only === '1' && isDealer;
  let partnerIds = null;
  if (isDealer && (partnersOnly || searchType === 'partners')) {
    partnerIds = db.listTradePartners(viewer.id).map((p) => p.id);
  }

  const baseFilters = { make: (make || '').trim(), maxPrice: max_price || null };
  // When the toggle is ON, the partner filter applies on top of every search
  // type (searchListings treats an empty dealerIds list as "match nothing").
  const partnerFilter = partnersOnly ? { dealerIds: partnerIds } : {};
  let listings;
  let idDealer = null;
  let idLookup = null;
  let partnerCount = 0;

  if (searchType === 'id') {
    idLookup = (member_number || '').trim();
    const n = parseInt(idLookup, 10);
    const d = n ? db.getDealerByMemberNumber(n) : null;
    if (d && d.status === 'approved' && BOARD_ACCESS_STATUSES.includes(d.membership_status)) {
      idDealer = d;
      listings = db.searchListings({ ...baseFilters, ...partnerFilter, memberNumber: n });
    } else {
      listings = [];
    }
  } else if (searchType === 'partners') {
    partnerCount = partnerIds.length;
    listings = db.searchListings({ ...baseFilters, dealerIds: partnerIds });
  } else {
    listings = db.searchListings({ ...baseFilters, ...partnerFilter });
  }

  // Radius filter: distance from the viewer's ZIP (or a typed ZIP) to each seller's ZIP.
  const centerZip = isValidZip(zip) ? cleanZip(zip) : (viewer && isValidZip(viewer.zip) ? viewer.zip : null);
  const radiusNum = [25, 50, 100, 250].includes(Number(radius)) ? Number(radius) : null;
  listings = listings.map((l) => ({
    ...l,
    distance: centerZip ? distanceMiles(centerZip, l.seller_zip) : null,
    daysOnSite: daysOnSiteLabel(l.created_at),
    pendingSale: l.pending_method ? PAYMENT_METHODS[l.pending_method] || l.pending_method : null,
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
  // Keep make / max_price / partners_only when switching tabs.
  const keep = [];
  if (make) keep.push('make=' + encodeURIComponent(make));
  if (max_price) keep.push('max_price=' + encodeURIComponent(max_price));
  if (partnersOnly) keep.push('partners_only=1');
  const keepQS = keep.length ? '&' + keep.join('&') : '';
  // Toggle link: same view, partners_only flipped. Preserves every filter.
  const tq = [];
  if (search_type) tq.push('search_type=' + encodeURIComponent(search_type));
  if (make) tq.push('make=' + encodeURIComponent(make));
  if (max_price) tq.push('max_price=' + encodeURIComponent(max_price));
  if (radius) tq.push('radius=' + encodeURIComponent(radius));
  if (zip) tq.push('zip=' + encodeURIComponent(zip));
  if (member_number) tq.push('member_number=' + encodeURIComponent(member_number));
  if (!partnersOnly) tq.push('partners_only=1');
  const toggleQS = tq.join('&');
  res.render('listings', {
    listings,
    radiusNoZip,
    centerZip,
    searchType,
    isDealer,
    keepQS,
    toggleQS,
    partnersOnly,
    idDealer,
    idLookup,
    partnerCount,
    filters: { make: make || '', max_price: max_price || '', radius: radius || '', zip: zip || '', member_number: member_number || '' },
  });
});

// New listing form
router.get('/new', requireMember, (req, res) => {
  res.render('listing-new', { error: null, formAction: '/listings', heading: 'Sell a vehicle', isAdmin: false });
});

// ---- Bulk import (fleet sellers: CSV of vehicles + ZIP of photos) ----

const BULK_MAX_ROWS = 200;
const BULK_MAX_PHOTOS_PER_CAR = 20; // matches the single-listing photo cap
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const SAMPLE_CSV = [
  'vin,price,mileage,color,title_status,description',
  '1HGCM82633A004352,8500,132000,Silver,Clean,"One owner, new tires"',
  '',
].join('\r\n');

router.get('/bulk/sample.csv', requireMember, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="tradeautox-bulk-sample.csv"');
  res.send(SAMPLE_CSV);
});

router.get('/bulk', requireMember, (req, res) => {
  res.render('bulk-import', { error: null, report: null });
});

// Index a photo ZIP by VIN: filenames must begin with the vehicle's VIN
// (e.g. 1HGCM82633A004352_1.jpg). Returns Map<vin, [{name, data}]> sorted
// by filename. Entries that aren't images, or whose name doesn't start
// with a valid VIN, are ignored.
function indexZipPhotos(buffer) {
  const byVin = new Map();
  const zip = new AdmZip(buffer);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.name);
    if (!IMAGE_EXTS.has(path.extname(base).toLowerCase())) continue;
    const vin = base.slice(0, 17).toUpperCase();
    if (!isValidVin(vin)) continue;
    if (!byVin.has(vin)) byVin.set(vin, []);
    byVin.get(vin).push({ name: base, data: entry.getData() });
  }
  for (const photos of byVin.values()) photos.sort((a, b) => a.name.localeCompare(b.name));
  return byVin;
}

// Write one extracted photo into the uploads dir under a generated name
// (same scheme as lib/upload.js) and return the multer-style { filename }
// the listing creator expects.
function saveBulkPhoto(photo) {
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(photo.name).toLowerCase();
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(dir, filename), photo.data);
  return { filename };
}

router.post('/bulk', requireMember, (req, res) => {
  upload.bulkUpload(req, res, async (uploadErr) => {
    const render = (error, report) => res.render('bulk-import', { error, report });
    if (uploadErr) return res.status(400).render('bulk-import', { error: upload.friendlyUploadError(uploadErr), report: null });
    try {
      const csvFile = req.files && req.files.csv_file && req.files.csv_file[0];
      if (!csvFile) return render('Please choose the CSV file of vehicles to import.', null);
      const zipFile = req.files && req.files.photos_zip && req.files.photos_zip[0];

      const { headers, records } = rowsToObjects(csvFile.buffer.toString('utf8'));
      if (!headers.includes('vin')) {
        return render('That CSV has no "vin" column. The first row must be a header row with at least a vin column — see the format below and the sample file.', null);
      }
      if (!records.length) return render('That CSV has a header row but no vehicles in it.', null);

      let photosByVin = new Map();
      if (zipFile) {
        try {
          photosByVin = indexZipPhotos(zipFile.buffer);
        } catch (e) {
          return render('That photo file could not be read as a ZIP. Export your photos as a standard .zip and try again.', null);
        }
      }

      const report = { created: [], skipped: [], errors: [], notes: [] };
      if (records.length > BULK_MAX_ROWS) {
        report.notes.push(`Your file had ${records.length} vehicles — the per-import limit is ${BULK_MAX_ROWS}, so only the first ${BULK_MAX_ROWS} were processed.`);
      }

      for (const row of records.slice(0, BULK_MAX_ROWS)) {
        const rowLabel = `Row ${row._row}`;
        const rawVin = (row.vin || '').trim();
        const vin = cleanVin(rawVin);
        if (!isValidVin(vin)) {
          report.errors.push({ row: rowLabel, vin: rawVin || '(blank)', message: `Bad VIN — "${rawVin || '(blank)'}" is not a 17-character VIN (letters I, O and Q are never used in VINs). Listing not created.` });
          continue;
        }
        const price = parseInt(String(row.price || '').replace(/[^0-9]/g, ''), 10);
        if (!price || price <= 0) {
          report.errors.push({ row: rowLabel, vin, message: 'Missing or invalid price — every listing needs an asking price. Listing not created.' });
          continue;
        }
        if (db.getDealerListingByVin(req.dealer.id, vin)) {
          report.skipped.push({ row: rowLabel, vin, message: 'Skipped — you already have a live or draft listing with this VIN.' });
          continue;
        }
        const decoded = await decodeVin(vin);
        if (decoded.error || !decoded.spec) {
          report.errors.push({ row: rowLabel, vin, message: 'VIN decode failed — NHTSA could not decode this VIN, so no specs could be filled in. Listing not created; check the VIN and try again.' });
          continue;
        }
        const spec = decoded.spec;
        const matched = (photosByVin.get(vin) || []).slice(0, BULK_MAX_PHOTOS_PER_CAR);
        try {
          const savedPhotos = matched.map(saveBulkPhoto);
          const created = createListingFromRequest(req.dealer.id, {
            vin,
            make: spec.make,
            model: spec.model,
            year: spec.year,
            trim: spec.trim || '',
            body_style: spec.body_style || '',
            drivetrain: spec.drivetrain || '',
            engine: spec.engine || '',
            transmission: spec.transmission || '',
            fuel: spec.fuel || '',
            doors: spec.doors || '',
            mileage: (row.mileage || '').trim(),
            price: String(price),
            color: (row.color || '').trim(),
            title_status: (row.title_status || '').trim(),
            description: (row.description || '').trim(),
          }, { photos: savedPhotos }, { enforcePhotoMinimum: 'total' });
          report.created.push({
            row: rowLabel, vin, id: created.id,
            label: `${spec.year} ${spec.make} ${spec.model}${spec.trim ? ' ' + spec.trim : ''}`,
            photoCount: savedPhotos.length,
            noPhotos: savedPhotos.length === 0,
            draft: created.status === 'draft',
          });
        } catch (err) {
          console.error(err);
          report.errors.push({ row: rowLabel, vin, message: err.message || 'Something went wrong saving this listing.' });
        }
      }

      if (zipFile && photosByVin.size) {
        const usedVins = new Set(report.created.map((c) => c.vin));
        const unmatched = [...photosByVin.keys()].filter((v) => !usedVins.has(v));
        // Photos for VINs whose rows failed/skipped also land here — fine, the note is informational.
        const orphan = unmatched.filter((v) => !records.some((r) => cleanVin(r.vin || '') === v));
        if (orphan.length) {
          report.notes.push(`${orphan.length} VIN${orphan.length === 1 ? '' : 's'} in the photo ZIP had no matching row in the CSV, so those photos were not used: ${orphan.join(', ')}.`);
        }
      }
      if (!zipFile && report.created.length) {
        report.notes.push('No photo ZIP was uploaded, so the listings above were saved as drafts — add at least 15 photos (5 exterior, 5 interior) from your dashboard to put them on the board.');
      }
      if (report.created.some((c) => c.draft)) {
        const n = report.created.filter((c) => c.draft).length;
        report.notes.push(`${n} listing${n === 1 ? '' : 's'} saved as draft${n === 1 ? '' : 's'} — fewer than 15 photos matched. Add photos from your dashboard to publish ${n === 1 ? 'it' : 'them'}.`);
      }

      return render(null, report);
    } catch (err) {
      console.error(err);
      return res.status(500).render('bulk-import', { error: 'Something went wrong running that import. No harm done — check the file and try again.', report: null });
    }
  });
});

// Create listing — 15–20 photos (at least 5 exterior + 5 interior) to go
// live. Short of that, the listing still saves — as a draft, off the board
// — and the dealer lands on the add-photos page to finish it.
router.post('/', requireMember, (req, res) => {
  upload.listingUpload(req, res, (uploadErr) => {
    const renderForm = (msg) => res.status(400).render('listing-new', {
      error: msg, formAction: '/listings', heading: 'Sell a vehicle', isAdmin: false,
    });
    if (uploadErr) return renderForm(upload.friendlyUploadError(uploadErr));
    try {
      const created = createListingFromRequest(req.dealer.id, req.body, req.files, { enforcePhotoMinimum: 'split' });
      if (created.status === 'draft') {
        return res.redirect(`/listings/${created.id}/add-photos?notice=` + encodeURIComponent(photoMinimumMessage(created.photoCounts)));
      }
      res.redirect(`/listings/${created.id}`);
    } catch (err) {
      console.error(err);
      renderForm(err.message || 'Something went wrong saving your listing.');
    }
  });
});

// Add photos to a listing — finish a draft, or top up a live one.
// A draft goes live the moment it holds 15+ photos (5+ exterior, 5+ interior).
router.get('/:id/add-photos', requireMember, (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing || listing.dealer_id !== req.dealer.id) return res.status(404).render('404');
  const counts = db.getListingPhotoCounts(listing.id);
  res.render('listing-add-photos', {
    listing, photos: db.getListingPhotos(listing.id), counts,
    error: null, notice: req.query.notice || null,
  });
});

router.post('/:id/photos', requireMember, (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing || listing.dealer_id !== req.dealer.id) return res.status(404).render('404');
  upload.addPhotosUpload(req, res, (uploadErr) => {
    const counts = () => db.getListingPhotoCounts(listing.id);
    const renderPage = (msg, notice) => res.status(uploadErr ? 400 : 200).render('listing-add-photos', {
      listing, photos: db.getListingPhotos(listing.id), counts: counts(),
      error: msg || null, notice: notice || null,
    });
    if (uploadErr) return renderPage(upload.friendlyUploadError(uploadErr));
    try {
      const added = collectPhotos(req.files);
      if (!added.length) return renderPage('Choose at least one photo to add.');
      for (const p of added) db.addListingPhoto(listing.id, `/uploads/${p.filename}`, p.category);
      const now = counts();
      if (listing.status === 'draft') {
        if (publishDraftIfReady(listing.id)) {
          return res.redirect(`/listings/${listing.id}?notice=` + encodeURIComponent('Published — your listing is now live on the board.'));
        }
        return res.redirect(`/listings/${listing.id}/add-photos?notice=` + encodeURIComponent(
          `${photoMinimumMessage(now)} Right now: ${now.total} of ${MIN_PHOTOS} photos (${now.exterior} exterior, ${now.interior} interior).`));
      }
      return res.redirect(`/listings/${listing.id}?notice=` + encodeURIComponent(`${added.length} photo${added.length === 1 ? '' : 's'} added.`));
    } catch (err) {
      console.error(err);
      renderPage('Something went wrong adding those photos.');
    }
  });
});

// Listing detail — members and admin
router.get('/:id', requireMemberOrAdmin, (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).render('404');
  listing.daysOnSite = daysOnSiteLabel(listing.created_at);
  const photos = db.getListingPhotos(listing.id);
  const canManage = !!req.session.admin || req.session.dealerId === listing.dealer_id;
  const rawIntent = db.getPurchaseIntent(listing.id);
  const intent = rawIntent
    ? { ...rawIntent,
        methodLabel: PAYMENT_METHODS[rawIntent.method] || rawIntent.method,
        intentDays: Math.max(0, Math.floor((Date.now() - new Date(rawIntent.created_at + 'Z').getTime()) / 86400000)) }
    : null;
  const viewerIsBuyer = !!(req.session.dealerId && intent && intent.buyer_dealer_id === req.session.dealerId);
  res.render('listing-detail', {
    listing, photos, canManage, intent, viewerIsBuyer,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// Buy: a member dealer picks a payment method (wire or check on pickup).
// Records the intent, then emails the printable deal sheet to BOTH buyer and
// seller. No money moves through TradeAutoX — the deal closes directly
// between them, and the seller marks the listing sold.
router.post('/:id/buy', requireMember, async (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).render('404');
  const method = req.body.method;
  if (!['wire', 'check'].includes(method)) {
    return res.redirect(`/listings/${listing.id}?error=` + encodeURIComponent('Pick a payment method: wire or check upon pickup.'));
  }
  if (listing.dealer_id === req.dealer.id) {
    return res.redirect(`/listings/${listing.id}?error=` + encodeURIComponent('You cannot buy your own listing.'));
  }
  if (db.getPurchaseIntent(listing.id)) {
    return res.redirect(`/listings/${listing.id}?error=` + encodeURIComponent('This vehicle already has a pending sale.'));
  }
  db.createPurchaseIntent(listing.id, req.dealer.id, method);
  const seller = db.getDealerById(listing.dealer_id);
  const { sendMail, dealSheetEmail } = require('../lib/mail');
  const msg = dealSheetEmail({ seller, buyer: req.dealer, listing, method });
  for (const to of [seller.email, req.dealer.email]) {
    sendMail({ to, ...msg }).catch((err) =>
      console.error(`[buy] deal sheet email to ${to} failed:`, err.message));
  }
  res.redirect(`/listings/${listing.id}?notice=` + encodeURIComponent('Done — deal sheet emailed to you and the seller.'));
});

// Seller (or admin) cancels a pending sale — e.g. the buyer never followed
// through, or the 3-day buyer-silence rule in §5 applies. The listing opens
// back up; nothing is marked sold. The buyer gets a notice email.
router.post('/:id/cancel-intent', (req, res) => {
  const listing = db.getListing(req.params.id);
  if (!listing) return res.status(404).render('404');
  const isOwner = req.session.dealerId === listing.dealer_id;
  if (!isOwner && !req.session.admin) return res.redirect(`/listings/${listing.id}`);
  const intent = db.getPurchaseIntent(listing.id);
  db.deletePurchaseIntent(listing.id);
  if (intent) {
    const seller = db.getDealerById(listing.dealer_id);
    const buyer = db.getDealerById(intent.buyer_dealer_id);
    if (seller && buyer) {
      const { sendMail, intentCancelledEmail } = require('../lib/mail');
      const msg = intentCancelledEmail({ seller, buyer, listing });
      sendMail({ to: buyer.email, ...msg }).catch((err) =>
        console.error(`[cancel-intent] buyer notice failed:`, err.message));
    }
  }
  res.redirect(`/listings/${listing.id}?notice=` + encodeURIComponent('Pending sale cancelled — the listing is open again.'));
});

// Mark sold / remove (owner only)
router.post('/:id/status', requireMember, (req, res) => {
  const { status } = req.body;
  if (!['sold', 'removed'].includes(status)) return res.redirect('/dashboard');
  db.setListingStatus(req.params.id, req.dealer.id, status);
  res.redirect('/dashboard');
});

module.exports = router;
