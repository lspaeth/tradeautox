const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
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

module.exports = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
});
module.exports.uploadReport = uploadReport;
module.exports.listingUpload = listingUpload;
