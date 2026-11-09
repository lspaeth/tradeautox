// Wants (wish list): a dealer saves a search — make, model, year range,
// max price, radius around their own ZIP — and when a matching listing goes
// live they get an in-app alert + email, the same two channels as live
// auction alerts. Wants stay private: only the owning dealer ever sees
// them, and the seller is never told who is hunting for their car.
const db = require('../db');
const { distanceMiles } = require('./geo');
const { sendMail, wantMatchEmail } = require('./mail');

// One-line human label for a Want, used on the dashboard.
function wantLabel(want) {
  const years = want.year_min && want.year_max ? `${want.year_min}–${want.year_max}`
    : want.year_min ? `${want.year_min} or newer`
    : want.year_max ? `${want.year_max} or older` : '';
  const bits = [years, want.make, want.model].filter(Boolean).join(' ');
  const price = want.max_price ? `up to $${Number(want.max_price).toLocaleString('en-US')}` : '';
  const radius = want.radius_miles ? `within ${want.radius_miles} mi` : 'anywhere';
  return [bits, price, radius].filter(Boolean).join(' · ');
}

// Make/model match mirrors the board search: case-insensitive substring.
// Year and price bounds are open when the Want leaves them blank.
function listingMatchesWant(listing, want) {
  const make = String(listing.make || '').toLowerCase();
  const model = String(listing.model || '').toLowerCase();
  if (!make.includes(String(want.make || '').toLowerCase().trim())) return false;
  if (want.model && !model.includes(String(want.model).toLowerCase().trim())) return false;
  if (want.year_min && listing.year < want.year_min) return false;
  if (want.year_max && listing.year > want.year_max) return false;
  if (want.max_price && listing.price > want.max_price) return false;
  return true;
}

// Ping every dealer whose Want matches this listing — once per dealer per
// listing, even when two of their Wants match. Skips the seller's own Wants
// and dealers who aren't approved, active members. Radius is measured from
// the seller's ZIP to the wanter's ZIP (same math as auction alerts); a Want
// with no radius matches anywhere, and one whose distance can't be computed
// is skipped when a radius is set. Fire-and-forget: mail failures are
// logged, never thrown, so a listing can never fail to publish over email.
function notifyWantMatches(listingId) {
  try {
    const listing = db.getListing(listingId);
    if (!listing || listing.status !== 'active') return;
    const seller = db.getDealerById(listing.dealer_id);
    if (!seller || !seller.zip) return;
    const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
    const notified = new Set();
    for (const want of db.listWantsWithDealers()) {
      if (want.dealer_id === listing.dealer_id) continue;
      if (notified.has(want.dealer_id)) continue;
      if (want.dealer_status !== 'approved') continue;
      if (!['active', 'past_due'].includes(want.membership_status)) continue;
      if (!listingMatchesWant(listing, want)) continue;
      let dist = null;
      if (want.radius_miles) {
        dist = distanceMiles(seller.zip, want.dealer_zip);
        if (dist == null || dist > want.radius_miles) continue;
      }
      notified.add(want.dealer_id);
      db.createNotification(want.dealer_id, 'want_match', listing.id,
        `Want match${dist != null ? ` ${dist} mi away` : ''}: ${vehicle} — $${Number(listing.price).toLocaleString('en-US')} · ${listing.dealership_name}`);
      sendMail({ to: want.dealer_email, ...wantMatchEmail({ contact_name: want.contact_name }, listing, want, dist) })
        .catch((e) => console.error('[mail] want match failed:', e.message));
    }
  } catch (e) {
    console.error('[wants] notify failed:', e.message);
  }
}

module.exports = { wantLabel, listingMatchesWant, notifyWantMatches };
