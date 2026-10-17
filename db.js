const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'tradeautox.db');
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

// ---- dealers ----
const createDealer = (d) => db.prepare(`
  INSERT INTO dealers (dealership_name, contact_name, email, password_hash, phone, license_number, license_photo_path, terms_accepted_at)
  VALUES (@dealership_name, @contact_name, @email, @password_hash, @phone, @license_number, @license_photo_path, @terms_accepted_at)
`).run(d);

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

// ---- listings ----
const createListing = (l) => db.prepare(`
  INSERT INTO listings (dealer_id, make, model, year, vin, mileage, price, description, verification_report)
  VALUES (@dealer_id, @make, @model, @year, @vin, @mileage, @price, @description, @verification_report)
`).run(l);

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
    SELECT l.*, d.dealership_name
    FROM listings l JOIN dealers d ON d.id = l.dealer_id
    WHERE l.status = 'active' AND d.status = 'approved' AND d.membership_status = 'active'`;
  const params = [];
  if (make) { sql += ` AND lower(l.make) LIKE ?`; params.push(`%${make.toLowerCase()}%`); }
  if (maxPrice) { sql += ` AND l.price <= ?`; params.push(Number(maxPrice)); }
  sql += ` ORDER BY l.created_at DESC`;
  return db.prepare(sql).all(...params);
}

const getDealerListings = (dealerId) =>
  db.prepare(`SELECT * FROM listings WHERE dealer_id = ? ORDER BY created_at DESC`).all(dealerId);

const setListingStatus = (id, dealerId, status) =>
  db.prepare(`UPDATE listings SET status = ? WHERE id = ? AND dealer_id = ?`).run(status, id, dealerId);

module.exports = {
  createDealer, getDealerByEmail, getDealerById, getDealerByStripeCustomer,
  setDealerStatus, setStripeCustomer, setMembership,
  listDealersByStatus, listAllDealers,
  createListing, addListingPhoto, getListing, getListingPhotos,
  searchListings, getDealerListings, setListingStatus,
};
