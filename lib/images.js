// Automatic photo compression for vehicle photos (listings + auctions).
// Every dealer-uploaded vehicle photo is resized to a web-sized JPEG at
// upload time, so a 15-photo car costs ~5 MB on disk instead of ~45 MB.
// The dealer uploads exactly as before — the conversion happens server-side
// before the photo is counted or stored.
//
// SCOPE: listing + auction photos only (Exterior / Interior boxes, the
// add-photos flow, bulk ZIP import). License photos at signup and
// verification reports never pass through here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const MAX_DIMENSION = 1600; // long side, pixels — no upscaling of smaller shots
const JPEG_QUALITY = 80;

function pipeline(input) {
  return sharp(input)
    .rotate() // apply EXIF orientation so phone photos never land sideways
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // transparent PNGs flatten cleanly to JPEG
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
}

// Convert one multer disk-storage file in place: resize + re-encode as JPEG,
// replace the original on disk, and update the multer file object so the
// rest of the request (DB paths, photo counts) sees the converted file.
// Throws a plain-language Error on an unreadable/corrupt image — the
// caller's error path shows it to the dealer.
async function compressVehiclePhotoFile(file) {
  const dir = path.dirname(file.path);
  const stem = path.basename(file.filename, path.extname(file.filename));
  const outName = `${stem}.jpg`;
  const outPath = path.join(dir, outName);
  const tmpPath = path.join(dir, `.${stem}.converting.jpg`);
  try {
    await pipeline(file.path).toFile(tmpPath);
  } catch (err) {
    fs.unlink(tmpPath, () => {});
    console.error(`[images] could not convert ${file.originalname}:`, err.message);
    throw new Error('One of the photos could not be read — please re-save it as a JPG and try again.');
  }
  fs.unlinkSync(file.path);
  fs.renameSync(tmpPath, outPath);
  const stat = fs.statSync(outPath);
  file.filename = outName;
  file.path = outPath;
  file.size = stat.size;
  file.mimetype = 'image/jpeg';
  file.originalname = `${path.basename(file.originalname, path.extname(file.originalname))}.jpg`;
  return file;
}

// Convert every vehicle photo in a multer req.files object (photos_exterior /
// photos_interior / legacy photos). Verification reports and license photos
// are never in these fields, so they pass through untouched.
// Runs before any DB write, so if one photo fails to convert, every file
// from this upload is removed from disk (nothing references them) and the
// caller shows the plain-language error instead of leaving orphans behind.
async function compressVehiclePhotos(files) {
  if (!files) return;
  const photoFiles = [];
  for (const field of ['photos_exterior', 'photos_interior', 'photos']) {
    for (const f of files[field] || []) photoFiles.push(f);
  }
  try {
    for (const f of photoFiles) await compressVehiclePhotoFile(f);
  } catch (err) {
    for (const f of photoFiles) fs.unlink(f.path, () => {});
    throw err;
  }
}

// Bulk import: convert a ZIP-extracted photo buffer to a web-sized JPEG.
// Returns the converted buffer + the stored filename (same unique-name
// scheme as lib/upload.js, .jpg extension).
async function compressVehiclePhotoBuffer(buffer, originalName) {
  let out;
  try {
    out = await pipeline(buffer).toBuffer();
  } catch (err) {
    console.error(`[images] could not convert ${originalName}:`, err.message);
    throw new Error('One of the photos could not be read — please re-save it as a JPG and try again.');
  }
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.jpg`;
  return { buffer: out, filename };
}

module.exports = {
  compressVehiclePhotoFile,
  compressVehiclePhotos,
  compressVehiclePhotoBuffer,
  MAX_DIMENSION,
  JPEG_QUALITY,
};
