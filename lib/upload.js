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

// Listing form: up to 8 photos + one optional verification report (PDF or image)
const listingUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos') return imageFilter(req, file, cb);
    if (file.fieldname === 'verification_report') return reportFilter(req, file, cb);
    cb(new Error('Unexpected file field'), false);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
}).fields([
  { name: 'photos', maxCount: 8 },
  { name: 'verification_report', maxCount: 1 },
]);

// Live auction form: up to 8 photos
const auctionUpload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 15 * 1024 * 1024 },
}).fields([
  { name: 'photos', maxCount: 8 },
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
module.exports.uploadReport = uploadReport;
module.exports.listingUpload = listingUpload;
module.exports.auctionUpload = auctionUpload;
module.exports.bulkUpload = bulkUpload;
