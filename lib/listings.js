// Shared vehicle-listing creation, used by the dealer flow and the admin demo flow.
const db = require('../db');

const SPEC_FIELDS = ['trim', 'body_style', 'drivetrain', 'engine', 'transmission', 'fuel', 'doors'];

function cleanStr(v) {
  return String(v == null ? '' : v).trim();
}

// Validates body fields, creates the listing + photos, returns the listing id.
// Throws an Error with a user-facing message when validation fails.
function createListingFromRequest(dealerId, body, files) {
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
  const info = db.createListing({
    dealer_id: dealerId,
    make: cleanStr(make),
    model: cleanStr(model),
    year: yearNum,
    vin: cleanStr(vin).toUpperCase(),
    mileage: mileage ? parseInt(String(mileage).replace(/[^0-9]/g, ''), 10) || null : null,
    price: priceNum,
    description: cleanStr(description),
    verification_report: files && files.verification_report ? `/uploads/${files.verification_report[0].filename}` : null,
    ...spec,
  });
  const listingId = info.lastInsertRowid;
  for (const f of (files && files.photos) || []) {
    db.addListingPhoto(listingId, `/uploads/${f.filename}`);
  }
  return listingId;
}

module.exports = { createListingFromRequest, SPEC_FIELDS };
