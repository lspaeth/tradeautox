// Minimal CSV parser (RFC 4180-ish): handles quoted fields, commas and
// newlines inside quotes, "" escapes, CRLF, and a leading BOM.
// Returns an array of rows; each row is an array of string cells.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Rows -> objects keyed by the (lowercased, trimmed) header row.
// Fully blank rows are dropped. Each object gets `_row`: its 1-based line
// number in the file (header is line 1), for plain-language error reports.
function rowsToObjects(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const records = rows.slice(1).map((cells, idx) => {
    const obj = { _row: idx + 2 };
    headers.forEach((h, i) => { if (h) obj[h] = String(cells[i] == null ? '' : cells[i]).trim(); });
    return obj;
  });
  return { headers, records };
}

module.exports = { parseCsv, rowsToObjects };
