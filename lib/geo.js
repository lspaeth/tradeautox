// ZIP-code geography for radius search and live-auction alerts.
// Uses the `zipcodes` dataset (US ZIP centroids). All distances in miles.
const zipcodes = require('zipcodes');

function cleanZip(zip) {
  const z = String(zip || '').trim().slice(0, 5);
  return /^\d{5}$/.test(z) ? z : null;
}

function isValidZip(zip) {
  const z = cleanZip(zip);
  return !!z && !!zipcodes.lookup(z);
}

// Distance in whole miles between two ZIPs, or null when either is unknown.
function distanceMiles(zipA, zipB) {
  const a = cleanZip(zipA);
  const b = cleanZip(zipB);
  if (!a || !b) return null;
  if (a === b) return 0;
  const d = zipcodes.distance(a, b);
  return typeof d === 'number' && !Number.isNaN(d) ? Math.round(d) : null;
}

module.exports = { cleanZip, isValidZip, distanceMiles };
