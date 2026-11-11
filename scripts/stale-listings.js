// Daily stale-listing sweep (run by the tradeautox-stale-listings-daily
// cron, ~8 AM ET).
// 1. Active listings quiet for 30+ days (and not mid-sale) get a "still
//    available?" email + in-app notification; the nudge is recorded so
//    each listing is nudged exactly once per stale spell.
// 2. Listings nudged 7+ days ago with no seller response are hidden from
//    the board (status 'expired'); the seller is emailed and can put the
//    car back with one click (Relist) from their dashboard.
// Run: node scripts/stale-listings.js   (from ~/workspace/tradeautox)
const db = require('../db');
const { sendMail, staleNudgeEmail, listingExpiredEmail } = require('../lib/mail');

async function main() {
  let nudged = 0;
  let expired = 0;

  for (const row of db.listStaleCandidates()) {
    const dealer = { contact_name: row.contact_name, email: row.dealer_email, dealership_name: row.dealership_name };
    try {
      const msg = staleNudgeEmail({ dealer, listing: row });
      await sendMail({ to: dealer.email, ...msg });
    } catch (err) {
      console.error(`[stale] nudge email to ${dealer.email} failed:`, err.message);
    }
    db.createNotification(row.dealer_id, 'stale_nudge', row.id,
      `Your ${row.year} ${row.make} ${row.model} has been on the board for 30+ days — is it still available?`);
    db.markListingNudged(row.id);
    nudged++;
  }

  for (const row of db.listNudgedExpired()) {
    const dealer = { contact_name: row.contact_name, email: row.dealer_email, dealership_name: row.dealership_name };
    db.setListingStatusById(row.id, 'expired');
    try {
      const msg = listingExpiredEmail({ dealer, listing: row });
      await sendMail({ to: dealer.email, ...msg });
    } catch (err) {
      console.error(`[stale] expiry email to ${dealer.email} failed:`, err.message);
    }
    db.createNotification(row.dealer_id, 'stale_expired', row.id,
      `Your ${row.year} ${row.make} ${row.model} was hidden from the board after 30+ days with no confirmation. Relist it from your dashboard anytime.`);
    expired++;
  }

  console.log(`[stale] done: ${nudged} nudged, ${expired} hidden`);
}

main().catch((err) => { console.error('[stale] failed:', err); process.exit(1); });
