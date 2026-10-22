'use strict';

/* TradeAutoX — AAMVA driver's-license barcode parser + signup checks.
 *
 * The PDF417 barcode on the back of a US driver's license decodes (in the
 * applicant's browser — the license image itself is never uploaded) to a
 * text payload in the AAMVA DL/ID standard format:
 *
 *   @ <LF> <RS> <CR> "ANSI " IIN(6) version(2) juris-version(2) entries(2)
 *   then, per subfile: type(2) offset(4) length(4) ... subfiles at offsets.
 *
 * The 'DL' subfile carries data elements as 3-letter codes, one per line:
 *   DCS last name · DAC first name · DAD middle name · DAQ license number
 *   DBA expiration · DBB date of birth (both MMDDYYYY) · DAG street ·
 *   DAI city · DAJ state · DAK ZIP. Older (version 01) cards use DAA for a
 *   combined "LAST,FIRST,MIDDLE" name instead of DCS/DAC/DAD.
 *
 * parseAamva(raw) -> { lastName, firstName, middleName, fullName, dob,
 *   expires, licenseNumber, address, city, state, zip, version } | null
 * evaluateScan(parsed, applicantName) -> { nameMatch, expired }
 *   nameMatch: 'match' | 'mismatch' (surname + first name is the bar;
 *   middle names/initials never fail a match). expired: true/false, or
 *   null when the card showed no readable expiration date.
 */

// AAMVA element IDs live in the 'DL' subfile; values run to end of line.
function splitElements(subfileText) {
  const out = {};
  for (const line of String(subfileText).split(/[\r\n]+/)) {
    const m = /^([A-Z]{3})([\s\S]*)$/.exec(line.trim());
    if (m && out[m[1]] === undefined) out[m[1]] = m[2].trim();
  }
  return out;
}

// Locate the DL subfile via the header's designators; fall back to finding
// the "DL" marker right after the header region, then to scanning the whole
// payload for element lines anchored at a DLDAQ.. pattern.
function extractDlElements(raw) {
  const ansiAt = raw.indexOf('ANSI ');
  if (ansiAt < 0) return null;
  const header = raw.slice(ansiAt + 5); // IIN(6) version(2) juris(2) entries(2), then designators
  if (header.length < 12) return null;
  const entries = parseInt(header.slice(10, 12), 10);
  if (Number.isFinite(entries) && entries > 0 && entries <= 9) {
    let p = 12; // first designator: type(2) offset(4) length(4)
    const designators = [];
    for (let i = 0; i < entries; i++) {
      const type = header.slice(p, p + 2);
      const offset = parseInt(header.slice(p + 2, p + 6), 10);
      const length = parseInt(header.slice(p + 6, p + 10), 10);
      if (type && Number.isFinite(offset) && Number.isFinite(length)) {
        designators.push({ type, offset, length });
      }
      p += 10;
    }
    // Offsets are absolute from the start of the full payload.
    const dl = designators.find((d) => d.type === 'DL' || d.type === 'ID');
    if (dl && dl.length > 2 && dl.offset >= 0 && dl.offset + dl.length <= raw.length + 2) {
      let text = raw.slice(dl.offset, dl.offset + dl.length);
      text = text.replace(/^(DL|ID)/, ''); // slice starts with the type marker
      const els = splitElements(text);
      if (els.DAQ || els.DCS || els.DAA) return els;
    }
  }
  // Fallback: the DL subfile is almost always the first subfile after the
  // designators — scan for a run of element-looking lines containing DAQ.
  const tail = raw.slice(ansiAt);
  const lines = tail.split(/[\r\n]+/);
  const collected = {};
  let started = false;
  for (const line of lines) {
    const clean = line.replace(/^(DL|ID)(?=DA[A-Z])/, '');
    const m = /^(DA[A-Z]|DC[A-Z]|DB[A-Z]|DD[A-Z])([\s\S]*)$/.exec(clean.trim());
    if (m) {
      started = true;
      if (collected[m[1]] === undefined) collected[m[1]] = m[2].trim();
    } else if (started && collected.DAQ) {
      break;
    }
  }
  if (collected.DAQ || collected.DCS || collected.DAA) return collected;
  return null;
}

function parseAamvaDate(mmddyyyy) {
  if (!mmddyyyy) return null;
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(String(mmddyyyy).replace(/\D/g, ''));
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null; // e.g. Feb 30
  return `${m[3]}-${m[1]}-${m[2]}`; // ISO date
}

function parseAamva(raw) {
  if (typeof raw !== 'string' || raw.length < 20) return null;
  const els = extractDlElements(raw);
  if (!els) return null;

  let lastName = (els.DCS || '').trim();
  let firstName = (els.DAC || '').trim();
  let middleName = (els.DAD || '').trim();
  // Version-01 cards carry one combined name element: LAST,FIRST,MIDDLE
  // (separators are commas in the standard; some issuers use spaces).
  if (!lastName && !firstName && els.DAA) {
    const parts = els.DAA.split(',').map((s) => s.trim());
    if (parts.length >= 2) {
      [lastName, firstName, middleName = ''] = parts;
    } else {
      const words = els.DAA.trim().split(/\s+/);
      if (words.length >= 2) { lastName = words[words.length - 1]; firstName = words[0]; }
      else lastName = els.DAA.trim();
    }
  }
  if (!lastName && !firstName && !els.DAQ) return null; // nothing identifying

  const fullName = [firstName, middleName, lastName]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');

  const ansiAt = raw.indexOf('ANSI ');
  const version = ansiAt >= 0 ? raw.slice(ansiAt + 11, ansiAt + 13) : null;

  return {
    lastName: lastName || null,
    firstName: firstName || null,
    middleName: middleName || null,
    fullName: fullName || null,
    dob: parseAamvaDate(els.DBB),
    expires: parseAamvaDate(els.DBA),
    licenseNumber: (els.DAQ || '').trim() || null,
    address: (els.DAG || '').trim() || null,
    city: (els.DAI || '').trim() || null,
    state: (els.DAJ || '').trim() || null,
    // DAK is ZIP+4 space/zero padded ("301440000"); keep the 5-digit ZIP,
    // plus the +4 when it carries real digits.
    zip: normalizeZip(els.DAK),
    version: version && /^\d{2}$/.test(version) ? version : null,
  };
}

function normalizeZip(dak) {
  if (!dak) return null;
  const digits = String(dak).replace(/\D/g, '');
  if (digits.length < 5) return String(dak).trim() || null;
  if (digits.length > 5 && digits.slice(5) !== '0000') return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`;
  return digits.slice(0, 5);
}

/* ---------- Name matching ---------- */

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V', 'ESQ', 'MD', 'DDS', 'PHD']);

function nameTokens(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t));
}

// First names match when equal, or when one is a prefix of the other
// (initial "J" vs "JOHN", "JOHN" vs "JOHNNY").
function firstNamesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short);
}

// The bar: surname + first name. Applicant names arrive as "First [Middle]
// Last" or "Last, First". Middle names/initials are ignored by design.
function namesMatch(applicantName, parsed) {
  if (!parsed) return false;
  const dlLast = nameTokens(parsed.lastName)[0] || null;
  const dlFirst = nameTokens(parsed.firstName)[0] || null;
  if (!dlLast || !dlFirst) return false;

  let appFirst = null;
  let appLast = null;
  const rawName = String(applicantName || '');
  if (rawName.includes(',')) {
    const [lastPart, restPart] = rawName.split(',', 2);
    appLast = nameTokens(lastPart)[0] || null;
    appFirst = nameTokens(restPart)[0] || null;
  } else {
    const tokens = nameTokens(rawName);
    if (tokens.length >= 2) {
      appFirst = tokens[0];
      appLast = tokens[tokens.length - 1];
    } else if (tokens.length === 1) {
      appLast = tokens[0];
    }
  }
  if (!appLast || appLast !== dlLast) return false;
  if (!appFirst) return false;
  return firstNamesMatch(appFirst, dlFirst);
}

function evaluateScan(parsed, applicantName, now = new Date()) {
  if (!parsed) return { nameMatch: null, expired: null };
  let expired = null;
  if (parsed.expires) {
    const today = now.toISOString().slice(0, 10); // UTC date; ISO compares lexically
    expired = parsed.expires < today;
  }
  return {
    nameMatch: namesMatch(applicantName, parsed) ? 'match' : 'mismatch',
    expired,
  };
}

module.exports = { parseAamva, parseAamvaDate, namesMatch, evaluateScan };
