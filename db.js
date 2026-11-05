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
  employee_logins_enabled INTEGER NOT NULL DEFAULT 0, -- owner toggle: employee logins on/off
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
  status TEXT NOT NULL DEFAULT 'active',             -- active | draft | sold | removed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listing_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  category TEXT -- 'exterior' | 'interior'; NULL = uncategorized (bulk ZIP photos, pre-rule photos)
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
  path TEXT NOT NULL,
  category TEXT -- 'exterior' | 'interior'; NULL = uncategorized (pre-rule photos)
);

-- Dealer employee logins. The owner keeps logging in via the dealers table
-- exactly as before; employees live here, one row per person, and always
-- act as their dealership (session dealerId is the org). Emails are unique
-- across dealers + dealer_users so a login can never be ambiguous.
CREATE TABLE IF NOT EXISTS dealer_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',           -- 'user' (employees); owners stay in dealers
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Trade partners: one-sided follow (v1, no mutual acceptance). A dealer
-- saves the dealers they trade with regularly and can filter the board to
-- just those partners' inventory.
CREATE TABLE IF NOT EXISTS trade_partners (
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  partner_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dealer_id, partner_id)
);

-- Extra admin logins. The owner stays on ADMIN_EMAIL/ADMIN_PASSWORD env vars;
-- these rows are for additional people (added via invite link), each with
-- their own credentials so access can be granted and revoked individually.
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time admin invite links. A link is valid until used or 7 days pass.
CREATE TABLE IF NOT EXISTS admin_invites (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by_email TEXT
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

// Best-effort migration: sequential member number ("ID" in the UI). Assigned
// at approval in chronological order starting at 1001; a number is never
// reused. SQLite can't add a UNIQUE column via ALTER TABLE, so the column
// goes on plain and uniqueness is enforced by the index below (NULLs —
// dealers not yet numbered — are allowed to repeat).
try {
  db.exec(`ALTER TABLE dealers ADD COLUMN member_number INTEGER`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dealers_member_number ON dealers(member_number)`);

// Best-effort migrations: dealer employee logins (owner toggle + users table
// columns) and photo categories (exterior/interior) for the 15–20 photo rule.
try {
  db.exec(`ALTER TABLE dealers ADD COLUMN employee_logins_enabled INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
}
try {
  db.exec(`ALTER TABLE listing_photos ADD COLUMN category TEXT`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
}
try {
  db.exec(`ALTER TABLE auction_photos ADD COLUMN category TEXT`);
} catch (e) {
  if (!/duplicate column name/i.test(String(e.message))) throw e;
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

// ---- member numbers ("ID" in the UI) ----
// Assigned at approval, chronological, starting at 1001, never reused.
// Idempotent: only assigns when the dealer has no number yet, so calling it
// twice (approve + reactivate, re-approvals) can never burn or move a number.
const assignMemberNumber = (dealerId) =>
  db.prepare(`
    UPDATE dealers
    SET member_number = (SELECT COALESCE(MAX(member_number), 1000) + 1 FROM dealers)
    WHERE id = ? AND member_number IS NULL
  `).run(dealerId);

const getDealerByMemberNumber = (n) =>
  db.prepare(`SELECT * FROM dealers WHERE member_number = ?`).get(Number(n));

// Backfill: every non-rejected dealer without a number gets one, oldest
// (lowest id) first, so existing dealers number up in onboarding order.
function backfillMemberNumbers() {
  const rows = db.prepare(
    `SELECT id FROM dealers WHERE status != 'rejected' AND member_number IS NULL ORDER BY id ASC`
  ).all();
  for (const r of rows) assignMemberNumber(r.id);
}
backfillMemberNumbers();

// ---- trade partners (one-sided follow, v1: no mutual acceptance) ----
const addTradePartner = (dealerId, partnerId) =>
  db.prepare(`INSERT OR IGNORE INTO trade_partners (dealer_id, partner_id) VALUES (?, ?)`).run(dealerId, partnerId);

const removeTradePartner = (dealerId, partnerId) =>
  db.prepare(`DELETE FROM trade_partners WHERE dealer_id = ? AND partner_id = ?`).run(dealerId, partnerId);

// Saved partners that are still approved dealers (id, name, city/state, ID).
const listTradePartners = (dealerId) =>
  db.prepare(`
    SELECT d.id, d.dealership_name, d.city, d.state, d.member_number
    FROM trade_partners tp JOIN dealers d ON d.id = tp.partner_id
    WHERE tp.dealer_id = ? AND d.status = 'approved'
    ORDER BY d.dealership_name
  `).all(dealerId);

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
  INSERT INTO listings (dealer_id, make, model, year, vin, mileage, price, description, verification_report, status,
    trim, body_style, drivetrain, engine, transmission, fuel, doors, color, title_status)
  VALUES (@dealer_id, @make, @model, @year, @vin, @mileage, @price, @description, @verification_report, @status,
    @trim, @body_style, @drivetrain, @engine, @transmission, @fuel, @doors, @color, @title_status)
`).run({ color: null, title_status: null, status: 'active', ...l });

const getActiveListingByVin = (dealerId, vin) =>
  db.prepare(`SELECT id FROM listings WHERE dealer_id = ? AND vin = ? AND status = 'active'`).get(dealerId, vin);

// Any live-or-draft listing with this VIN for this dealer (sold/removed don't
// count) — the bulk-import duplicate check, so re-importing a draft VIN
// skips instead of creating a second listing for the same car.
const getDealerListingByVin = (dealerId, vin) =>
  db.prepare(`SELECT id FROM listings WHERE dealer_id = ? AND vin = ? AND status IN ('active', 'draft')`).get(dealerId, vin);

const addListingPhoto = (listingId, p, category = null) =>
  db.prepare(`INSERT INTO listing_photos (listing_id, path, category) VALUES (?, ?, ?)`).run(listingId, p, category || null);

const getListing = (id) =>
  db.prepare(`
    SELECT l.*, d.dealership_name, d.contact_name, d.phone, d.email AS dealer_email
    FROM listings l JOIN dealers d ON d.id = l.dealer_id
    WHERE l.id = ?
  `).get(id);

const getListingPhotos = (listingId) =>
  db.prepare(`SELECT * FROM listing_photos WHERE listing_id = ? ORDER BY id`).all(listingId);

// Photo totals for the 15–20 rule: uncategorized photos (bulk ZIP, pre-rule)
// count toward the total only, never toward either side's minimum.
const getListingPhotoCounts = (listingId) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN category = 'exterior' THEN 1 ELSE 0 END), 0) AS exterior,
      COALESCE(SUM(CASE WHEN category = 'interior' THEN 1 ELSE 0 END), 0) AS interior
    FROM listing_photos WHERE listing_id = ?
  `).get(listingId);
  return { total: row.total, exterior: row.exterior, interior: row.interior };
};

function searchListings({ make, maxPrice, memberNumber, dealerIds }) {
  // A partner filter with no partners matches nothing (avoids `IN ()`).
  if (dealerIds && !dealerIds.length) return [];
  let sql = `
    SELECT l.*, d.dealership_name, d.zip AS seller_zip,
      (SELECT method FROM purchase_intents WHERE listing_id = l.id LIMIT 1) AS pending_method
    FROM listings l JOIN dealers d ON d.id = l.dealer_id
    WHERE l.status = 'active' AND d.status = 'approved' AND d.membership_status IN ('active', 'past_due')`;
  const params = [];
  if (make) { sql += ` AND lower(l.make) LIKE ?`; params.push(`%${make.toLowerCase()}%`); }
  if (maxPrice) { sql += ` AND l.price <= ?`; params.push(Number(maxPrice)); }
  if (memberNumber) { sql += ` AND d.member_number = ?`; params.push(Number(memberNumber)); }
  if (dealerIds && dealerIds.length) {
    sql += ` AND l.dealer_id IN (${dealerIds.map(() => '?').join(',')})`;
    params.push(...dealerIds.map(Number));
  }
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

// ---- extra admins + one-time invite links ----
// The owner (ADMIN_EMAIL/ADMIN_PASSWORD env) is not in the admins table and
// can never be removed here. Table admins are checked at login only when the
// env credentials don't match.
const createAdminInvite = (token, expiresAt, createdByEmail) =>
  db.prepare(`INSERT INTO admin_invites (token, expires_at, created_by_email) VALUES (?, ?, ?)`)
    .run(token, expiresAt, createdByEmail);

const getAdminInvite = (token) =>
  db.prepare(`SELECT * FROM admin_invites WHERE token = ?`).get(token);

const markAdminInviteUsed = (token) =>
  db.prepare(`UPDATE admin_invites SET used_at = datetime('now') WHERE token = ?`).run(token);

const revokeAdminInvite = (token) =>
  db.prepare(`DELETE FROM admin_invites WHERE token = ?`).run(token);

const listOpenAdminInvites = () =>
  db.prepare(`SELECT * FROM admin_invites WHERE used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC`).all();

const createAdmin = (email, passwordHash) =>
  db.prepare(`INSERT INTO admins (email, password_hash) VALUES (?, ?)`).run(email, passwordHash);

const getAdminByEmail = (email) =>
  db.prepare(`SELECT * FROM admins WHERE email = ?`).get(email);

const getAdminById = (id) =>
  db.prepare(`SELECT id, email, created_at FROM admins WHERE id = ?`).get(id);

const listAdmins = () =>
  db.prepare(`SELECT id, email, created_at FROM admins ORDER BY created_at`).all();

const removeAdmin = (id) =>
  db.prepare(`DELETE FROM admins WHERE id = ?`).run(id);

const setDealerPassword = (id, passwordHash) =>
  db.prepare(`UPDATE dealers SET password_hash = ? WHERE id = ?`).run(passwordHash, id);

const setMustChangePassword = (id, val) =>
  db.prepare(`UPDATE dealers SET must_change_password = ? WHERE id = ?`).run(val ? 1 : 0, id);

// ---- dealer employee logins ----
// The owner keeps logging in via the dealers table; employees live here.
// Email uniqueness is enforced across BOTH tables by the callers (login and
// signup/add-employee check dealers + dealer_users) — SQLite can't express
// a cross-table UNIQUE constraint.
const setEmployeeLoginsEnabled = (dealerId, val) =>
  db.prepare(`UPDATE dealers SET employee_logins_enabled = ? WHERE id = ?`).run(val ? 1 : 0, dealerId);

const createDealerUser = ({ dealer_id, name, email, password_hash }) =>
  db.prepare(`INSERT INTO dealer_users (dealer_id, name, email, password_hash) VALUES (?, ?, ?, ?)`)
    .run(dealer_id, name, email, password_hash);

const getDealerUserByEmail = (email) =>
  db.prepare(`SELECT * FROM dealer_users WHERE email = ?`).get(email);

const getDealerUserById = (id) =>
  db.prepare(`SELECT * FROM dealer_users WHERE id = ?`).get(id);

const listDealerUsers = (dealerId) =>
  db.prepare(`SELECT id, dealer_id, name, email, role, active, must_change_password, created_at FROM dealer_users WHERE dealer_id = ? ORDER BY created_at`).all(dealerId);

const setDealerUserActive = (id, dealerId, val) =>
  db.prepare(`UPDATE dealer_users SET active = ? WHERE id = ? AND dealer_id = ?`).run(val ? 1 : 0, id, dealerId);

const setDealerUserPassword = (id, passwordHash) =>
  db.prepare(`UPDATE dealer_users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);

const setDealerUserMustChange = (id, val) =>
  db.prepare(`UPDATE dealer_users SET must_change_password = ? WHERE id = ?`).run(val ? 1 : 0, id);

// ---- live auctions ----
const createAuction = (a) => db.prepare(`
  INSERT INTO auctions (dealer_id, make, model, year, vin, mileage, trim, body_style, drivetrain,
    engine, transmission, fuel, doors, description, target_price, radius, ends_at, status, created_at)
  VALUES (@dealer_id, @make, @model, @year, @vin, @mileage, @trim, @body_style, @drivetrain,
    @engine, @transmission, @fuel, @doors, @description, @target_price, @radius, @ends_at, 'live', @created_at)
`).run(a);

const addAuctionPhoto = (auctionId, p, category = null) =>
  db.prepare(`INSERT INTO auction_photos (auction_id, path, category) VALUES (?, ?, ?)`).run(auctionId, p, category || null);

const getAuctionPhotos = (auctionId) =>
  db.prepare(`SELECT * FROM auction_photos WHERE auction_id = ? ORDER BY id`).all(auctionId);

// Same 15–20 rule totals as listings (see getListingPhotoCounts).
const getAuctionPhotoCounts = (auctionId) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN category = 'exterior' THEN 1 ELSE 0 END), 0) AS exterior,
      COALESCE(SUM(CASE WHEN category = 'interior' THEN 1 ELSE 0 END), 0) AS interior
    FROM auction_photos WHERE auction_id = ?
  `).get(auctionId);
  return { total: row.total, exterior: row.exterior, interior: row.interior };
};

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
  backfillMemberNumbers(); // a lazily-created demo dealer gets the next ID
  return getDealerById(d.id);
}

module.exports = {
  createDealer, getDealerByEmail, getDealerById, getDealerByStripeCustomer,
  setDealerStatus, setStripeCustomer, setMembership, setDealerPassword, setMustChangePassword,
  setDealerZip, setDealerAddress, listDealersByStatus, listAllDealers, getDealerFilePaths, deleteDealer,
  assignMemberNumber, getDealerByMemberNumber, backfillMemberNumbers,
  addTradePartner, removeTradePartner, listTradePartners,
  createPurchaseIntent, getPurchaseIntent, deletePurchaseIntent,
  createListing, getActiveListingByVin, getDealerListingByVin, addListingPhoto, getListing, getListingPhotos,
  getListingPhotoCounts, getAuctionPhotoCounts,
  searchListings, getDealerListings, getFeaturedListing, setListingStatus, setListingStatusById,
  createPasswordReset, hasOpenPasswordReset, listOpenPasswordResets,
  getPasswordReset, markPasswordResetUsed,
  createAdminInvite, getAdminInvite, markAdminInviteUsed, revokeAdminInvite,
  listOpenAdminInvites, createAdmin, getAdminByEmail, getAdminById, listAdmins, removeAdmin,
  setEmployeeLoginsEnabled, createDealerUser, getDealerUserByEmail, getDealerUserById,
  listDealerUsers, setDealerUserActive, setDealerUserPassword, setDealerUserMustChange,
  createAuction, addAuctionPhoto, getAuctionPhotos, getAuction, listAuctions,
  getDealerAuctions, getAuctionBids, getHighBid, placeBid, extendAuction,
  setAuctionStatus, acceptAuctionBid, getBidById, listActiveDealers,
  createNotification, listUnreadNotifications, markNotificationsRead,
  ensureDemoDealer, DEMO_DEALER_EMAIL,
};
