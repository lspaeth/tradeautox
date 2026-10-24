const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const db = require('../db');
const upload = require('../lib/upload');
const { requireMember, requireMemberOrAdmin } = require('../lib/auth');
const { createListingFromRequest, daysOnSiteLabel } = require('../lib/listings');
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
    daysOnSite: daysOnSiteLabel(l.created_at),
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

// ---- Bulk import (fleet sellers: CSV of vehicles + ZIP of photos) ----

const BULK_MAX_ROWS = 200;
const BULK_MAX_PHOTOS_PER_CAR = 8; // matches the single-listing photo cap
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
    if (uploadErr) return res.status(400).render('bulk-import', { error: uploadErr.message || 'Upload failed.', report: null });
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
        if (db.getActiveListingByVin(req.dealer.id, vin)) {
          report.skipped.push({ row: rowLabel, vin, message: 'Skipped — you already have an active listing with this VIN.' });
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
          const listingId = createListingFromRequest(req.dealer.id, {
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
          }, { photos: savedPhotos });
          report.created.push({
            row: rowLabel, vin, id: listingId,
            label: `${spec.year} ${spec.make} ${spec.model}${spec.trim ? ' ' + spec.trim : ''}`,
            photoCount: savedPhotos.length,
            noPhotos: savedPhotos.length === 0,
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
        report.notes.push('No photo ZIP was uploaded, so the listings above were created without photos. You can add photos later from each listing if you like.');
      }

      return render(null, report);
    } catch (err) {
      console.error(err);
      return res.status(500).render('bulk-import', { error: 'Something went wrong running that import. No harm done — check the file and try again.', report: null });
    }
  });
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
  listing.daysOnSite = daysOnSiteLabel(listing.created_at);
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
