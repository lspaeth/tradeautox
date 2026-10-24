const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(process.env.DATA_DIR || __dirname, 'tradeautox.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS dealers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealership_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT,
  license_number TEXT NOT NULL,
  license_photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | approved | rejected
  membership_status TEXT NOT NULL DEFAULT 'none',    -- none | active | past_due | inactive
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  terms_accepted_at TEXT,                       -- ISO timestamp of Terms acceptance at signup
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  vin TEXT,
  mileage INTEGER,
  price INTEGER NOT NULL,                            -- whole USD
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',             -- active | sold | removed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listing_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);

-- One row per Buy click: buyer, payment method, when. The listing stays
-- active until the seller marks it sold; this row drives "Sale pending".
CREATE TABLE IF NOT EXISTS purchase_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  method TEXT NOT NULL, -- wire | check
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,  -- seller
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  vin TEXT,
  mileage INTEGER,
  trim TEXT,
  body_style TEXT,
  drivetrain TEXT,
  engine TEXT,
  transmission TEXT,
  fuel TEXT,
  doors TEXT,
  description TEXT,
  target_price INTEGER,                        -- the number the seller needs (seller-only)
  radius INTEGER NOT NULL DEFAULT 50,          -- alert radius in miles
  ends_at TEXT NOT NULL,                       -- ISO timestamp
  status TEXT NOT NULL DEFAULT 'live',         -- live | accepted | ended | cancelled
  winner_bid_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auction_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auction_bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,                     -- whole USD
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- auction_alert | auction_won | auction_sold | auction_outbid
  ref_id INTEGER,                              -- auction id
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
`);

// Best-effort migration for databases created before terms_accepted_at existed.
try {
  db.exec(`ALTER TABLE dealers ADD COLUMN terms_accepted_at TEXT`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
}

// Best-effort migration for databases created before verification_report existed.
try {
  db.exec(`ALTER TABLE listings ADD COLUMN verification_report TEXT`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
}

// Best-effort migration for databases created before must_change_password existed.
try {
  db.exec(`ALTER TABLE dealers ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
}

// Best-effort migrations for VIN-decoded spec columns on listings.
for (const col of ['trim', 'body_style', 'drivetrain', 'engine', 'transmission', 'fuel', 'doors']) {
  try {
    db.exec(`ALTER TABLE listings ADD COLUMN ${col} TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }
}

// Best-effort migration: dealership ZIP (powers radius search + live auction alerts).
try {
  db.exec(`ALTER TABLE dealers ADD COLUMN zip TEXT`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
}

// Best-effort migration: dealership street address (deal sheet emails list the
// address, phone, and point of contact for both buyer and seller).
for (const col of ['address', 'city', 'state']) {
  try {
    db.exec(`ALTER TABLE dealers ADD COLUMN ${col} TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }
}

// Best-effort migrations: color + title status on listings (bulk import columns).
for (const col of ['color', 'title_status']) {
  try {
    db.exec(`ALTER TABLE listings ADD COLUMN ${col} TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }
}

// Best-effort migrations: driver's-license scan check at signup. Only the
// barcode's extracted text fields + computed check results are stored — the
// license image itself is decoded in the applicant's browser and never
// uploaded. dl_scanned_at NULL means the applicant did not scan.
for (const col of [
  'dl_scanned_at TEXT', 'dl_name TEXT', 'dl_dob TEXT', 'dl_expires TEXT',
  'dl_number TEXT', 'dl_address TEXT', 'dl_city TEXT', 'dl_state TEXT',
  'dl_zip TEXT', 'dl_name_match TEXT', 'dl_expired INTEGER',
]) {
  try {
    db.exec(`ALTER TABLE dealers ADD COLUMN ${col}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e.message))) throw e;
  }
}

// ---- dealers ----
const createDealer = (d) => db.prepare(`
  INSERT INTO dealers (dealership_name, contact_name, email, password_hash, phone, license_number, license_photo_path, terms_accepted_at, zip,
    address, city, state,
    dl_scanned_at, dl_name, dl_dob, dl_expires, dl_number, dl_address, dl_city, dl_state, dl_zip, dl_name_match, dl_expired)
  VALUES (@dealership_name, @contact_name, @email, @password_hash, @phone, @license_number, @license_photo_path, @terms_accepted_at, @zip,
    @address, @city, @state,
    @dl_scanned_at, @dl_name, @dl_dob, @dl_expires, @dl_number, @dl_address, @dl_city, @dl_state, @dl_zip, @dl_name_match, @dl_expired)
`).run({
  zip: null, address: null, city: null, state: null,
  dl_scanned_at: null, dl_name: null, dl_dob: null, dl_expires: null,
  dl_number: null, dl_address: null, dl_city: null, dl_state: null,
  dl_zip: null, dl_name_match: null, dl_expired: null,
  ...d,
});

const setDealerZip = (id, zip) =>
  db.prepare(`UPDATE dealers SET zip = ? WHERE id = ?`).run(zip || null, id);

const setDealerAddress = (id, { address, city, state }) =>
  db.prepare(`UPDATE dealers SET address = ?, city = ?, state = ? WHERE id = ?`)
    .run(address || null, city || null, state || null, id);

const getDealerByEmail = (email) => db.prepare(`SELECT * FROM dealers WHERE email = ?`).get(email);
const getDealerById = (id) => db.prepare(`SELECT * FROM dealers WHERE id = ?`).get(id);
const getDealerByStripeCustomer = (cid) => db.prepare(`SELECT * FROM dealers WHERE stripe_customer_id = ?`).get(cid);

const setDealerStatus = (id, status) =>
  db.prepare(`UPDATE dealers SET status = ? WHERE id = ?`).run(status, id);

const setStripeCustomer = (id, customerId) =>
  db.prepare(`UPDATE dealers SET stripe_customer_id = ? WHERE id = ?`).run(customerId, id);

const setMembership = (id, membershipStatus, subscriptionId = null) =>
  db.prepare(`UPDATE dealers SET membership_status = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?`)
    .run(membershipStatus, subscriptionId, id);

const listDealersByStatus = (status) =>
  db.prepare(`SELECT * FROM dealers WHERE status = ? ORDER BY created_at DESC`).all(status);
const listAllDealers = () =>
  db.prepare(`SELECT * FROM dealers ORDER BY created_at DESC`).all();

// Stored /uploads/... paths belonging to a dealer (license photo, listing
// photos + verification reports, auction photos) — collected before a delete
// so the caller can unlink the files; the rows themselves cascade.
const getDealerFilePaths = (id) => {
  const rows = [];
  const dealer = db.prepare(`SELECT license_photo_path FROM dealers WHERE id = ?`).get(id);
  if (dealer && dealer.license_photo_path) rows.push(dealer.license_photo_path);
  rows.push(...db.prepare(
    `SELECT verification_report AS path FROM listings WHERE dealer_id = ? AND verification_report IS NOT NULL`
  ).all(id).map((r) => r.path));
  rows.push(...db.prepare(
    `SELECT p.path FROM listing_photos p JOIN listings l ON l.id = p.listing_id WHERE l.dealer_id = ?`
  ).all(id).map((r) => r.path));
  rows.push(...db.prepare(
    `SELECT p.path FROM auction_photos p JOIN auctions a ON a.id = p.auction_id WHERE a.dealer_id = ?`
  ).all(id).map((r) => r.path));
  return rows;
};

// Hard delete — listings, photos, auctions, bids, notifications and password
// resets all cascade (ON DELETE CASCADE, foreign_keys pragma ON).
const deleteDealer = (id) => db.prepare(`DELETE FROM dealers WHERE id = ?`).run(id);

// ---- listings ----
const createListing = (l) => db.prepare(`
  INSERT INTO listings (dealer_id, make, model, year, vin, mileage, price, description, verification_report,
    trim, body_style, drivetrain, engine, transmission, fuel, doors, color, title_status)
  VALUES (@dealer_id, @make, @model, @year, @vin, @mileage, @price, @description, @verification_report,
    @trim, @body_style, @drivetrain, @engine, @transmission, @fuel, @doors, @color, @title_status)
`).run({ color: null, title_status: null, ...l });

const getActiveListingByVin = (dealerId, vin) =>
  db.prepare(`SELECT id FROM listings WHERE dealer_id = ? AND vin = ? AND status = 'active'`).get(dealerId, vin);

const addListingPhoto = (listingId, p) =>
  db.prepare(`INSERT INTO listing_photos (listing_id, path) VALUES (?, ?)`).run(listingId, p);

const getListing = (id) =>
  db.prepare(`
    SELECT l.*, d.dealership_name, d.contact_name, d.phone, d.email AS dealer_email
    FROM listings l JOIN dealers d ON d.id = l.dealer_id
    WHERE l.id = ?
  `).get(id);

const getListingPhotos = (listingId) =>
  db.prepare(`SELECT * FROM listing_photos WHERE listing_id = ? ORDER BY id`).all(listingId);

function searchListings({ make, maxPrice }) {
  let sql = `
    SELECT l.*, d.dealership_name, d.zip AS seller_zip,
      (SELECT method FROM purchase_intents WHERE listing_id = l.id LIMIT 1) AS pending_method
    FROM listings l JOIN dealers d ON d.id = l.dealer_id
    WHERE l.status = 'active' AND d.status = 'approved' AND d.membership_status IN ('active', 'past_due')`;
  const params = [];
  if (make) { sql += ` AND lower(l.make) LIKE ?`; params.push(`%${make.toLowerCase()}%`); }
  if (maxPrice) { sql += ` AND l.price <= ?`; params.push(Number(maxPrice)); }
  sql += ` ORDER BY l.created_at DESC`;
  return db.prepare(sql).all(...params);
}

const getDealerListings = (dealerId) =>
  db.prepare(`SELECT * FROM listings WHERE dealer_id = ? ORDER BY created_at DESC`).all(dealerId);

// ---- purchase intents (Buy flow) ----
const createPurchaseIntent = (listingId, buyerDealerId, method) =>
  db.prepare(`INSERT INTO purchase_intents (listing_id, buyer_dealer_id, method) VALUES (?, ?, ?)`).run(listingId, buyerDealerId, method);

const getPurchaseIntent = (listingId) =>
  db.prepare(`
    SELECT pi.*, d.dealership_name AS buyer_name, d.contact_name AS buyer_contact,
      d.phone AS buyer_phone, d.email AS buyer_email
    FROM purchase_intents pi JOIN dealers d ON d.id = pi.buyer_dealer_id
    WHERE pi.listing_id = ?
  `).get(listingId);

const deletePurchaseIntent = (listingId) =>
  db.prepare(`DELETE FROM purchase_intents WHERE listing_id = ?`).run(listingId);

// Public landing hero: newest active board listing, real dealers first, demo dealer
// only as a fallback. The route strips this to public-safe fields (no price, no
// seller identity) before rendering.
const getFeaturedListing = () =>
  db.prepare(`
    SELECT l.*, d.email AS dealer_email,
      (SELECT path FROM listing_photos WHERE listing_id = l.id ORDER BY id LIMIT 1) AS photo
    FROM listings l JOIN dealers d ON d.id = l.dealer_id
    WHERE l.status = 'active' AND d.status = 'approved' AND d.membership_status IN ('active', 'past_due')
    ORDER BY (d.email = ?) ASC, l.created_at DESC
    LIMIT 1
  `).get(DEMO_DEALER_EMAIL);

const setListingStatus = (id, dealerId, status) =>
  db.prepare(`UPDATE listings SET status = ? WHERE id = ? AND dealer_id = ?`).run(status, id, dealerId);

// Admin use: no dealer constraint.
const setListingStatusById = (id, status) =>
  db.prepare(`UPDATE listings SET status = ? WHERE id = ?`).run(status, id);

// ---- password resets (admin-assisted: dealer requests, admin issues temp password) ----
const createPasswordReset = (dealerId) =>
  db.prepare(`INSERT INTO password_resets (dealer_id) VALUES (?)`).run(dealerId);

const hasOpenPasswordReset = (dealerId) =>
  !!db.prepare(`SELECT 1 FROM password_resets WHERE dealer_id = ? AND used_at IS NULL`).get(dealerId);

const listOpenPasswordResets = () =>
  db.prepare(`
    SELECT r.id, r.created_at, d.dealership_name, d.contact_name, d.email
    FROM password_resets r JOIN dealers d ON d.id = r.dealer_id
    WHERE r.used_at IS NULL ORDER BY r.created_at`).all();

const getPasswordReset = (id) =>
  db.prepare(`
    SELECT r.*, d.dealership_name, d.contact_name, d.email
    FROM password_resets r JOIN dealers d ON d.id = r.dealer_id
    WHERE r.id = ?`).get(id);

const markPasswordResetUsed = (id) =>
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ?`).run(id);

const setDealerPassword = (id, passwordHash) =>
  db.prepare(`UPDATE dealers SET password_hash = ? WHERE id = ?`).run(passwordHash, id);

const setMustChangePassword = (id, val) =>
  db.prepare(`UPDATE dealers SET must_change_password = ? WHERE id = ?`).run(val ? 1 : 0, id);

// ---- live auctions ----
const createAuction = (a) => db.prepare(`
  INSERT INTO auctions (dealer_id, make, model, year, vin, mileage, trim, body_style, drivetrain,
    engine, transmission, fuel, doors, description, target_price, radius, ends_at, status, created_at)
  VALUES (@dealer_id, @make, @model, @year, @vin, @mileage, @trim, @body_style, @drivetrain,
    @engine, @transmission, @fuel, @doors, @description, @target_price, @radius, @ends_at, 'live', @created_at)
`).run(a);

const addAuctionPhoto = (auctionId, p) =>
  db.prepare(`INSERT INTO auction_photos (auction_id, path) VALUES (?, ?)`).run(auctionId, p);

const getAuctionPhotos = (auctionId) =>
  db.prepare(`SELECT * FROM auction_photos WHERE auction_id = ? ORDER BY id`).all(auctionId);

// Effective status: a 'live' auction past its end time reads as 'ended'.
function withEffectiveStatus(a) {
  if (a && a.status === 'live' && new Date(a.ends_at).getTime() <= Date.now()) {
    return { ...a, status: 'ended' };
  }
  return a;
}

const getAuction = (id) => {
  const a = db.prepare(`
    SELECT a.*, d.dealership_name, d.contact_name, d.phone, d.email AS dealer_email, d.zip AS seller_zip
    FROM auctions a JOIN dealers d ON d.id = a.dealer_id
    WHERE a.id = ?
  `).get(id);
  return withEffectiveStatus(a);
};

const listAuctions = () =>
  db.prepare(`
    SELECT a.*, d.dealership_name, d.zip AS seller_zip,
      (SELECT MAX(amount) FROM auction_bids WHERE auction_id = a.id) AS high_bid,
      (SELECT COUNT(*) FROM auction_bids WHERE auction_id = a.id) AS bid_count
    FROM auctions a JOIN dealers d ON d.id = a.dealer_id
    ORDER BY a.created_at DESC
  `).all().map(withEffectiveStatus);

const getDealerAuctions = (dealerId) =>
  db.prepare(`SELECT * FROM auctions WHERE dealer_id = ? ORDER BY created_at DESC`).all(dealerId)
    .map(withEffectiveStatus);

const getAuctionBids = (auctionId) =>
  db.prepare(`
    SELECT b.*, d.dealership_name
    FROM auction_bids b JOIN dealers d ON d.id = b.dealer_id
    WHERE b.auction_id = ? ORDER BY b.amount DESC, b.created_at ASC
  `).all(auctionId);

const getHighBid = (auctionId) =>
  db.prepare(`
    SELECT b.*, d.dealership_name, d.contact_name, d.phone, d.email AS dealer_email
    FROM auction_bids b JOIN dealers d ON d.id = b.dealer_id
    WHERE b.auction_id = ? ORDER BY b.amount DESC, b.created_at ASC LIMIT 1
  `).get(auctionId);

const placeBid = (auctionId, dealerId, amount) =>
  db.prepare(`INSERT INTO auction_bids (auction_id, dealer_id, amount, created_at) VALUES (?, ?, ?, ?)`)
    .run(auctionId, dealerId, amount, new Date().toISOString());

const extendAuction = (id, endsAtIso) =>
  db.prepare(`UPDATE auctions SET ends_at = ? WHERE id = ?`).run(endsAtIso, id);

const setAuctionStatus = (id, status) =>
  db.prepare(`UPDATE auctions SET status = ? WHERE id = ?`).run(status, id);

const acceptAuctionBid = (id, bidId) =>
  db.prepare(`UPDATE auctions SET status = 'accepted', winner_bid_id = ? WHERE id = ?`).run(bidId, id);

const getBidById = (id) =>
  db.prepare(`
    SELECT b.*, d.dealership_name, d.contact_name, d.phone, d.email AS dealer_email
    FROM auction_bids b JOIN dealers d ON d.id = b.dealer_id
    WHERE b.id = ?
  `).get(id);

// Approved dealers with a live membership (auction alert + bidding pool).
// past_due dealers are included: a failing card flags them for the admin but
// they keep trading until Stripe gives up and the membership goes inactive.
const listActiveDealers = () =>
  db.prepare(`SELECT * FROM dealers WHERE status = 'approved' AND membership_status IN ('active', 'past_due')`).all();

// ---- notifications ----
const createNotification = (dealerId, kind, refId, message) =>
  db.prepare(`INSERT INTO notifications (dealer_id, kind, ref_id, message, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(dealerId, kind, refId, message, new Date().toISOString());

const listUnreadNotifications = (dealerId) =>
  db.prepare(`SELECT * FROM notifications WHERE dealer_id = ? AND read_at IS NULL ORDER BY created_at DESC`).all(dealerId);

const markNotificationsRead = (dealerId) =>
  db.prepare(`UPDATE notifications SET read_at = ? WHERE dealer_id = ? AND read_at IS NULL`)
    .run(new Date().toISOString(), dealerId);

// ---- demo dealer (used for admin-posted demo listings) ----
const DEMO_DEALER_EMAIL = 'demo@tradeautox.com';
async function ensureDemoDealer() {
  let d = getDealerByEmail(DEMO_DEALER_EMAIL);
  if (!d) {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const info = createDealer({
      dealership_name: 'TradeAutoX (demo)',
      contact_name: 'TradeAutoX',
      email: DEMO_DEALER_EMAIL,
      password_hash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12),
      phone: '',
      license_number: 'DEMO',
      license_photo_path: null,
      terms_accepted_at: new Date().toISOString(),
      zip: '30339',
    });
    d = getDealerById(info.lastInsertRowid);
  }
  if (d.status !== 'approved') setDealerStatus(d.id, 'approved');
  if (d.membership_status !== 'active') setMembership(d.id, 'active');
  if (!d.zip) setDealerZip(d.id, '30339');
  return getDealerById(d.id);
}

module.exports = {
  createDealer, getDealerByEmail, getDealerById, getDealerByStripeCustomer,
  setDealerStatus, setStripeCustomer, setMembership, setDealerPassword, setMustChangePassword,
  setDealerZip, setDealerAddress, listDealersByStatus, listAllDealers, getDealerFilePaths, deleteDealer,
  createPurchaseIntent, getPurchaseIntent, deletePurchaseIntent,
  createListing, getActiveListingByVin, addListingPhoto, getListing, getListingPhotos,
  searchListings, getDealerListings, getFeaturedListing, setListingStatus, setListingStatusById,
  createPasswordReset, hasOpenPasswordReset, listOpenPasswordResets,
  getPasswordReset, markPasswordResetUsed,
  createAuction, addAuctionPhoto, getAuctionPhotos, getAuction, listAuctions,
  getDealerAuctions, getAuctionBids, getHighBid, placeBid, extendAuction,
  setAuctionStatus, acceptAuctionBid, getBidById, listActiveDealers,
  createNotification, listUnreadNotifications, markNotificationsRead,
  ensureDemoDealer, DEMO_DEALER_EMAIL,
};
