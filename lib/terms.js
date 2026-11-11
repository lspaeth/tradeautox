// The version of the Terms every dealer must have accepted. Bump this to
// the date of the material change whenever the Terms change; dealers whose
// recorded version is older (or blank — everyone who joined before
// versioning existed) are asked to accept on their next login.
// Current version: the November 6, 2026 rewrite (Section 18 added,
// effective December 6, 2026).
const TERMS_VERSION = '2026-11-06';

// Short, plain-language summary shown on the re-acceptance page. The full
// Terms are one click away — this is the "what changed" version.
const TERMS_WHAT_CHANGED = [
  'The Terms were rewritten on November 6, 2026 — clearer rules on membership, listings, auctions, and member conduct.',
  'New Section 18 (Privacy and transaction data): TradeAutoX does not sell your information. It takes effect December 6, 2026.',
  'Your acceptance is recorded with a timestamp, the same as at signup.',
];

module.exports = { TERMS_VERSION, TERMS_WHAT_CHANGED };
