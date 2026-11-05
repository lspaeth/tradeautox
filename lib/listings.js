// Shared vehicle-listing creation, used by the dealer flow and the admin demo flow.
const db = require('../db');

// Photo rule: every listing that goes on the board carries 15–20 photos,
// at least 5 exterior and 5 interior. Bulk imports only know photo totals
// (ZIP filenames carry no inside/outside info), so bulk enforces the total
// only — see the `enforcePhotoMinimum` modes below.
const MIN_PHOTOS = 15;
const MIN_EXTERIOR_PHOTOS = 5;
const MIN_INTERIOR_PHOTOS = 5;
const MAX_PHOTOS = 20;

const SPEC_FIELDS = ['trim', 'body_style', 'drivetrain', 'engine', 'transmission', 'fuel', 'doors'];

function cleanStr(v) {
  return String(v == null ? '' : v).trim();
}

// Normalize multer's req.files into [{ filename, category }]. The two form
// boxes are 'photos_exterior' / 'photos_interior'; 'photos' is the legacy
// single box (uncategorized — bulk imports and pre-rule forms).
function collectPhotos(files) {
  const out = [];
  for (const f of (files && files.photos_exterior) || []) out.push({ filename: f.filename, category: 'exterior' });
  for (const f of (files && files.photos_interior) || []) out.push({ filename: f.filename, category: 'interior' });
  for (const f of (files && files.photos) || []) out.push({ filename: f.filename, category: null });
  return out;
}

function countPhotos(collected) {
  return {
    total: collected.length,
    exterior: collected.filter((p) => p.category === 'exterior').length,
    interior: collected.filter((p) => p.category === 'interior').length,
  };
}

// Split rule (single form, auction form, finishing a draft): 15+ total with
// at least 5 on each side. Uncategorized photos count toward the total only.
function meetsSplitMinimum(counts) {
  return counts.total >= MIN_PHOTOS
    && counts.exterior >= MIN_EXTERIOR_PHOTOS
    && counts.interior >= MIN_INTERIOR_PHOTOS;
}

// Total-only rule (bulk import): the ZIP can't say inside from outside.
function meetsTotalMinimum(counts) {
  return counts.total >= MIN_PHOTOS;
}

function photoShortfall(counts) {
  const bits = [];
  if (counts.total < MIN_PHOTOS) bits.push(`${MIN_PHOTOS - counts.total} more photo${MIN_PHOTOS - counts.total === 1 ? '' : 's'} (need ${MIN_PHOTOS} total)`);
  if (counts.exterior < MIN_EXTERIOR_PHOTOS) bits.push(`at least ${MIN_EXTERIOR_PHOTOS - counts.exterior} more exterior`);
  if (counts.interior < MIN_INTERIOR_PHOTOS) bits.push(`at least ${MIN_INTERIOR_PHOTOS - counts.interior} more interior`);
  return bits;
}

function photoMinimumMessage(counts) {
  return `This listing needs ${photoShortfall(counts).join(', ')} to go on the board — it was saved as a draft.`;
}

// Validates body fields, creates the listing + photos, returns
// { id, status, photoCounts }. Throws an Error with a user-facing message
// when validation fails.
// options.enforcePhotoMinimum: false (default — admin demo flow, unchanged),
// 'split' (single listing form + finishing a draft), or 'total' (bulk import).
// When enforced and the photos fall short, the listing is still created —
// as a DRAFT, never on the board — so the dealer can finish it later.
function createListingFromRequest(dealerId, body, files, options = {}) {
  const { make, model, year, vin, mileage, price, description } = body;
  if (!cleanStr(make) || !cleanStr(model) || !cleanStr(year) || !cleanStr(price)) {
    throw new Error('Make, model, year, and asking price are required.');
  }
  const yearNum = parseInt(year, 10);
  const priceNum = parseInt(String(price).replace(/[^0-9]/g, ''), 10);
  if (!yearNum || yearNum < 1900 || yearNum > 2100 || !priceNum || priceNum <= 0) {
    throw new Error('Please enter a valid year and price.');
  }
  const spec = {};
  for (const f of SPEC_FIELDS) spec[f] = cleanStr(body[f]) || null;
  const photos = collectPhotos(files);
  const photoCounts = countPhotos(photos);
  let status = 'active';
  if (options.enforcePhotoMinimum === 'split' && !meetsSplitMinimum(photoCounts)) status = 'draft';
  if (options.enforcePhotoMinimum === 'total' && !meetsTotalMinimum(photoCounts)) status = 'draft';
  const info = db.createListing({
    dealer_id: dealerId,
    make: cleanStr(make),
    model: cleanStr(model),
    year: yearNum,
    vin: cleanStr(vin).toUpperCase(),
    mileage: mileage ? parseInt(String(mileage).replace(/[^0-9]/g, ''), 10) || null : null,
    price: priceNum,
    description: cleanStr(description),
    color: cleanStr(body.color) || null,
    title_status: cleanStr(body.title_status) || null,
    verification_report: files && files.verification_report ? `/uploads/${files.verification_report[0].filename}` : null,
    status,
    ...spec,
  });
  const listingId = info.lastInsertRowid;
  for (const p of photos) {
    db.addListingPhoto(listingId, `/uploads/${p.filename}`, p.category);
  }
  return { id: listingId, status, photoCounts };
}

// A draft goes live the moment its stored photos meet the split rule
// (15+ total, 5+ exterior, 5+ interior). Returns true when it published.
function publishDraftIfReady(listingId) {
  const listing = db.getListing(listingId);
  if (!listing || listing.status !== 'draft') return false;
  if (!meetsSplitMinimum(db.getListingPhotoCounts(listingId))) return false;
  db.setListingStatusById(listingId, 'active');
  return true;
}

// Days on site, from the listing's created_at. created_at is stored as UTC
// "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now')), so parse it as UTC — parsing
// it as local time would shift the count near midnight.
function daysOnSite(createdAt) {
  if (!createdAt) return null;
  const t = Date.parse(String(createdAt).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function daysOnSiteLabel(createdAt) {
  const d = daysOnSite(createdAt);
  if (d == null) return null;
  if (d === 0) return 'New today';
  return d === 1 ? '1 day on site' : `${d} days on site`;
}

// Buy-flow payment choices. No floorplan option by design: the buyer picks
// wire or check on pickup, and the deal sheet carries both parties' contact
// details so the deal closes directly between them.
const PAYMENT_METHODS = { wire: 'Wire transfer', check: 'Check upon pickup' };

module.exports = {
  createListingFromRequest, publishDraftIfReady, collectPhotos, countPhotos,
  meetsSplitMinimum, meetsTotalMinimum, photoMinimumMessage, photoShortfall,
  MIN_PHOTOS, MIN_EXTERIOR_PHOTOS, MIN_INTERIOR_PHOTOS, MAX_PHOTOS,
  SPEC_FIELDS, daysOnSite, daysOnSiteLabel, PAYMENT_METHODS,
};
