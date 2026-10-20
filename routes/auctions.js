const express = require('express');
const db = require('../db');
const upload = require('../lib/upload');
const { requireMember, requireMemberOrAdmin, currentDealer } = require('../lib/auth');
const { distanceMiles, isValidZip } = require('../lib/geo');
const { sendMail, auctionAlertEmail, auctionWonEmail, auctionSoldEmail } = require('../lib/mail');
const { SPEC_FIELDS } = require('../lib/listings');

const router = express.Router();

const RADIUS_OPTIONS = [25, 50, 100, 250];
const DURATION_OPTIONS = [15, 30, 45, 60];
const ANTI_SNIPE_MS = 2 * 60 * 1000; // a bid in the final 2 minutes extends the clock by 2 minutes

function cleanStr(v) { return String(v == null ? '' : v).trim(); }

function vehicleLabel(a) {
  return `${a.year} ${a.make} ${a.model}${a.trim ? ' ' + a.trim : ''}`;
}

// Auctions a viewer can see, each annotated with distance from the viewer's ZIP.
function visibleAuctions(viewer) {
  const viewerZip = viewer ? viewer.zip : null;
  return db.listAuctions().map((a) => ({
    ...a,
    distance: viewerZip ? distanceMiles(viewerZip, a.seller_zip) : null,
  }));
}

// ---- list ----
router.get('/', requireMemberOrAdmin, (req, res) => {
  const viewer = currentDealer(req);
  const all = visibleAuctions(viewer);
  const live = all.filter((a) => a.status === 'live')
    .sort((x, y) => new Date(x.ends_at) - new Date(y.ends_at));
  const recent = all.filter((a) => a.status !== 'live').slice(0, 10);
  res.render('auctions', { live, recent, viewerZip: viewer ? viewer.zip : null });
});

// ---- create form ----
router.get('/new', requireMember, (req, res) => {
  res.render('auction-new', {
    error: null,
    radiusOptions: RADIUS_OPTIONS,
    durationOptions: DURATION_OPTIONS,
    dealerZip: req.dealer.zip || '',
  });
});

// ---- create ----
router.post('/', requireMember, upload.auctionUpload, async (req, res) => {
  const renderErr = (msg) => res.status(400).render('auction-new', {
    error: msg,
    radiusOptions: RADIUS_OPTIONS,
    durationOptions: DURATION_OPTIONS,
    dealerZip: req.dealer.zip || '',
  });
  try {
    const seller = req.dealer;
    if (!isValidZip(seller.zip)) {
      return renderErr('Set your dealership ZIP code on your dashboard first — live auction alerts are sent by distance from your ZIP.');
    }
    const { make, model, year, vin, mileage, description, target_price } = req.body;
    if (!cleanStr(make) || !cleanStr(model) || !cleanStr(year)) {
      return renderErr('Make, model, and year are required.');
    }
    const yearNum = parseInt(year, 10);
    if (!yearNum || yearNum < 1900 || yearNum > 2100) return renderErr('Please enter a valid year.');
    const radius = RADIUS_OPTIONS.includes(Number(req.body.radius)) ? Number(req.body.radius) : 50;
    const duration = DURATION_OPTIONS.includes(Number(req.body.duration)) ? Number(req.body.duration) : 30;
    const target = target_price ? parseInt(String(target_price).replace(/[^0-9]/g, ''), 10) || null : null;
    const spec = {};
    for (const f of SPEC_FIELDS) spec[f] = cleanStr(req.body[f]) || null;

    const now = Date.now();
    const info = db.createAuction({
      dealer_id: seller.id,
      make: cleanStr(make),
      model: cleanStr(model),
      year: yearNum,
      vin: cleanStr(vin).toUpperCase() || null,
      mileage: mileage ? parseInt(String(mileage).replace(/[^0-9]/g, ''), 10) || null : null,
      description: cleanStr(description) || null,
      target_price: target,
      radius,
      ends_at: new Date(now + duration * 60 * 1000).toISOString(),
      created_at: new Date(now).toISOString(),
      ...spec,
    });
    const auctionId = info.lastInsertRowid;
    for (const f of (req.files && req.files.photos) || []) {
      db.addAuctionPhoto(auctionId, `/uploads/${f.filename}`);
    }

    // Alert every active dealer inside the radius (in-app + email, fire-and-forget).
    const auction = db.getAuction(auctionId);
    const label = vehicleLabel(auction);
    for (const other of db.listActiveDealers()) {
      if (other.id === seller.id || !other.zip) continue;
      const dist = distanceMiles(seller.zip, other.zip);
      if (dist == null || dist > radius) continue;
      db.createNotification(other.id, 'auction_alert', auctionId,
        `Live auction ${dist} mi away: ${label} — bidding ends ${new Date(auction.ends_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET`);
      sendMail({ to: other.email, ...auctionAlertEmail(other, auction, dist) })
        .catch((e) => console.error('[mail] auction alert failed:', e.message));
    }

    res.redirect(`/auctions/${auctionId}`);
  } catch (err) {
    console.error(err);
    renderErr('Something went wrong starting your auction.');
  }
});

// ---- room ----
router.get('/:id', requireMemberOrAdmin, (req, res) => {
  const auction = db.getAuction(req.params.id);
  if (!auction) return res.status(404).render('404');
  const viewer = currentDealer(req);
  const isSeller = !!viewer && viewer.id === auction.dealer_id;
  const bids = db.getAuctionBids(auction.id);
  const highBid = bids.length ? bids[0] : null;
  const winner = auction.status === 'accepted' && auction.winner_bid_id
    ? db.getBidById(auction.winner_bid_id) : null;
  const viewerWon = !!winner && !!viewer && winner.dealer_id === viewer.id;
  // Contact details are revealed only to the two parties once a bid is accepted.
  const showContacts = auction.status === 'accepted' && (isSeller || viewerWon || !!req.session.admin);
  res.render('auction-room', {
    auction: { ...auction, distance: viewer && viewer.zip ? distanceMiles(viewer.zip, auction.seller_zip) : null },
    photos: db.getAuctionPhotos(auction.id),
    bids,
    highBid,
    winner,
    isSeller,
    viewerId: viewer ? viewer.id : null,
    showContacts,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// ---- live state (polled by the room page) ----
router.get('/:id/state', requireMemberOrAdmin, (req, res) => {
  const auction = db.getAuction(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Not found' });
  const viewer = currentDealer(req);
  const bids = db.getAuctionBids(auction.id);
  const highBid = bids.length ? bids[0] : null;
  res.json({
    status: auction.status,
    endsAt: auction.ends_at,
    serverNow: new Date().toISOString(),
    highBid: highBid ? highBid.amount : null,
    bidCount: bids.length,
    targetMet: !!(viewer && viewer.id === auction.dealer_id && auction.target_price && highBid && highBid.amount >= auction.target_price),
    bids: bids.map((b) => ({
      dealer: b.dealership_name,
      amount: b.amount,
      mine: !!viewer && b.dealer_id === viewer.id,
      at: b.created_at,
    })),
  });
});

// ---- bid ----
router.post('/:id/bid', requireMember, (req, res) => {
  const auction = db.getAuction(req.params.id);
  if (!auction) return res.status(404).render('404');
  const back = (params) => res.redirect(`/auctions/${auction.id}?${params}`);
  if (auction.dealer_id === req.dealer.id) return back('error=' + encodeURIComponent('You can\'t bid on your own auction.'));
  if (auction.status !== 'live') return back('error=' + encodeURIComponent('This auction has ended.'));
  const amount = parseInt(String(req.body.amount || '').replace(/[^0-9]/g, ''), 10);
  if (!amount || amount <= 0) return back('error=' + encodeURIComponent('Enter a bid amount.'));
  const high = db.getHighBid(auction.id);
  if (high && amount <= high.amount) {
    return back('error=' + encodeURIComponent(`Your bid must beat the current high bid of $${high.amount.toLocaleString('en-US')}.`));
  }
  db.placeBid(auction.id, req.dealer.id, amount);
  // Anti-snipe: a bid inside the final 2 minutes extends the clock.
  const msLeft = new Date(auction.ends_at).getTime() - Date.now();
  if (msLeft > 0 && msLeft < ANTI_SNIPE_MS) {
    db.extendAuction(auction.id, new Date(Date.now() + ANTI_SNIPE_MS).toISOString());
  }
  // Let the outbid dealer know.
  if (high && high.dealer_id !== req.dealer.id) {
    const outbid = db.getDealerById(high.dealer_id);
    if (outbid) {
      db.createNotification(outbid.id, 'auction_outbid', auction.id,
        `You've been outbid on the ${vehicleLabel(auction)} — new high bid $${amount.toLocaleString('en-US')}.`);
    }
  }
  res.redirect(`/auctions/${auction.id}`);
});

// ---- accept high bid (seller) ----
router.post('/:id/accept', requireMember, async (req, res) => {
  const auction = db.getAuction(req.params.id);
  if (!auction) return res.status(404).render('404');
  if (auction.dealer_id !== req.dealer.id) return res.redirect(`/auctions/${auction.id}`);
  if (auction.status === 'accepted') return res.redirect(`/auctions/${auction.id}`);
  const high = db.getHighBid(auction.id);
  if (!high) return res.redirect(`/auctions/${auction.id}?error=` + encodeURIComponent('No bids to accept yet.'));
  db.acceptAuctionBid(auction.id, high.id);
  const label = vehicleLabel(auction);
  const winner = db.getDealerById(high.dealer_id);
  if (winner) {
    db.createNotification(winner.id, 'auction_won', auction.id,
      `You won the ${label} at $${high.amount.toLocaleString('en-US')} — contact ${auction.dealership_name} to complete the deal.`);
    sendMail({ to: winner.email, ...auctionWonEmail(winner, auction, high) })
      .catch((e) => console.error('[mail] auction won failed:', e.message));
  }
  const seller = db.getDealerById(auction.dealer_id);
  if (seller) {
    sendMail({ to: seller.email, ...auctionSoldEmail(seller, auction, high) })
      .catch((e) => console.error('[mail] auction sold failed:', e.message));
  }
  res.redirect(`/auctions/${auction.id}?notice=` + encodeURIComponent(`Bid accepted — ${label} sold to ${high.dealership_name} for $${high.amount.toLocaleString('en-US')}. Contact details are below.`));
});

// ---- cancel (seller, while live) ----
router.post('/:id/cancel', requireMember, (req, res) => {
  const auction = db.getAuction(req.params.id);
  if (!auction) return res.status(404).render('404');
  if (auction.dealer_id === req.dealer.id && auction.status === 'live') {
    db.setAuctionStatus(auction.id, 'cancelled');
  }
  res.redirect(`/auctions/${auction.id}`);
});

module.exports = router;
