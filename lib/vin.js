// VIN decoding via the free NHTSA vPIC API (no key required).
// Returns normalized vehicle specs, or { error } when the VIN can't be decoded.

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/; // 17 chars, no I/O/Q

function cleanVin(vin) {
  return String(vin || '').trim().toUpperCase();
}

function isValidVin(vin) {
  return VIN_RE.test(cleanVin(vin));
}

function pick(results, ...names) {
  for (const n of names) {
    const r = results.find((x) => x.Variable === n);
    const v = r && String(r.Value || '').trim();
    if (v && v !== 'Not Applicable') return v;
  }
  return null;
}

async function decodeVin(rawVin) {
  const vin = cleanVin(rawVin);
  if (!isValidVin(vin)) {
    return { error: 'That doesn\u2019t look like a valid 17-character VIN.' };
  }
  let data;
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`, {
      headers: { 'User-Agent': 'TradeAutoX/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`NHTSA responded ${res.status}`);
    data = await res.json();
  } catch (err) {
    return { error: 'VIN lookup is unavailable right now — fill in the details manually.' };
  }
  const results = data.Results || [];
  const errorCode = pick(results, 'Error Code');
  if (errorCode && errorCode !== '0') {
    return { error: 'That VIN didn\u2019t decode — double-check it and fill in the details manually.' };
  }
  const year = parseInt(pick(results, 'Model Year'), 10) || null;
  const engineParts = [
    pick(results, 'Engine Model'),
    pick(results, 'Displacement (L)'),
    pick(results, 'Engine Number of Cylinders'),
  ].filter(Boolean);
  const transParts = [
    pick(results, 'Transmission Style'),
    pick(results, 'Transmission Speeds'),
  ].filter(Boolean);
  const spec = {
    vin,
    year,
    make: pick(results, 'Make'),
    model: pick(results, 'Model'),
    trim: pick(results, 'Trim', 'Series', 'Trim2'),
    body_style: pick(results, 'Body Class'),
    drivetrain: pick(results, 'Drive Type'),
    engine: engineParts.length ? engineParts.join(' · ') : null,
    transmission: transParts.length ? transParts.join(' · ') : null,
    fuel: pick(results, 'Fuel Type - Primary'),
    doors: pick(results, 'Doors'),
    plant: [pick(results, 'Plant City'), pick(results, 'Plant Country')].filter(Boolean).join(', ') || null,
  };
  if (!spec.make || !spec.model) {
    return { error: 'That VIN didn\u2019t decode — double-check it and fill in the details manually.' };
  }
  return { spec };
}

module.exports = { decodeVin, isValidVin, cleanVin };
