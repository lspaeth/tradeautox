const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const imageFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files are allowed'), false);
};

// Verification reports: PDF or image (e.g. Vintel diagnostic report)
const reportFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Verification report must be a PDF or image'), false);
};

const uploadReport = multer({
  storage,
  fileFilter: reportFilter,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// Listing form: 15–20 photos to publish (at least 5 exterior + 5 interior),
// up to 10 per box, plus one optional verification report (PDF or image).
// The minimum is enforced server-side in lib/listings.js — multer only caps.
const listingUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos_exterior' || file.fieldname === 'photos_interior') return imageFilter(req, file, cb);
    if (file.fieldname === 'verification_report') return reportFilter(req, file, cb);
    cb(new Error('Unexpected file field'), false);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
}).fields([
  { name: 'photos_exterior', maxCount: 10 },
  { name: 'photos_interior', maxCount: 10 },
  { name: 'verification_report', maxCount: 1 },
]);

// Live auction form: same 15–20 photo rule as listings (at least 5 + 5).
const auctionUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos_exterior' || file.fieldname === 'photos_interior') return imageFilter(req, file, cb);
    cb(new Error('Unexpected file field'), false);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
}).fields([
  { name: 'photos_exterior', maxCount: 10 },
  { name: 'photos_interior', maxCount: 10 },
]);

// Add-photos flow (finish a draft, or top up a listing): same two boxes.
const addPhotosUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos_exterior' || file.fieldname === 'photos_interior') return imageFilter(req, file, cb);
    cb(new Error('Unexpected file field'), false);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
}).fields([
  { name: 'photos_exterior', maxCount: 10 },
  { name: 'photos_interior', maxCount: 10 },
]);

// Bulk import: a CSV of vehicles + a ZIP of photos, held in memory and
// processed by the bulk route (photos are written to the uploads dir there
// under generated names, exactly like single-listing photos).
const bulkUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (file.fieldname === 'csv_file') {
      if (name.endsWith('.csv') || ['text/csv', 'application/vnd.ms-excel', 'text/plain'].includes(file.mimetype)) return cb(null, true);
      return cb(new Error('The vehicle file must be a .csv file.'), false);
    }
    if (file.fieldname === 'photos_zip') {
      if (name.endsWith('.zip') || ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'].includes(file.mimetype)) return cb(null, true);
      return cb(new Error('The photo file must be a .zip file.'), false);
    }
    cb(new Error('Unexpected file field'), false);
  },
  limits: { fileSize: 100 * 1024 * 1024, files: 2 }, // 100 MB total cap per file (fleet photo ZIPs run large)
}).fields([
  { name: 'csv_file', maxCount: 1 },
  { name: 'photos_zip', maxCount: 1 },
]);

module.exports = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
});
// Turn a multer/busboy upload error into plain language for the dealer.
// (Multer surfaces a raw "Unexpected file field" for an over-full upload box.)
function friendlyUploadError(err) {
  if (!err) return 'Upload failed.';
  if (err.code === 'LIMIT_UNEXPECTED_FILE' || /unexpected/i.test(err.message || '')) {
    return 'Too many photos in one upload box (max 10 exterior, 10 interior).';
  }
  if (err.code === 'LIMIT_FILE_SIZE') return 'One of the photos is too large — the limit is 20 MB per photo.';
  if (err.code === 'LIMIT_FILE_COUNT') return 'Too many photos — the limit is 20 per listing.';
  return err.message || 'Upload failed.';
}

module.exports.uploadReport = uploadReport;
module.exports.listingUpload = listingUpload;
module.exports.auctionUpload = auctionUpload;
module.exports.addPhotosUpload = addPhotosUpload;
module.exports.bulkUpload = bulkUpload;
module.exports.friendlyUploadError = friendlyUploadError;
