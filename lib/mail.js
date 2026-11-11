// Outgoing email via SMTP (nodemailer). Configured through env vars; if the
// SMTP settings are absent, sending is skipped with a console warning so the
// app never crashes for lack of email config.
const nodemailer = require('nodemailer');

let transporter = null;

function mailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    console.warn(`[mail] skipped email to ${to} — SMTP is not configured`);
    return false;
  }
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
  return true;
}

function welcomeEmail(dealer) {
  const baseUrl = (process.env.BASE_URL || 'https://tradeautox-production.up.railway.app').replace(/\/$/, '');
  const subject = 'Welcome to TradeAutoX — your application is approved';
  const idLine = dealer.member_number
    ? `Your member ID is ${dealer.member_number} — other dealers can find your inventory by it.`
    : '';
  const text =
`Hi ${dealer.contact_name},

Your TradeAutoX application for ${dealer.dealership_name} has been approved — welcome aboard.
${idLine ? '\n' + idLine + '\n' : ''}
Here's how to get rolling:
1. Log in at ${baseUrl}/login
2. Activate your $599/month membership to start buying and selling (no auction fees, no per-vehicle cut)
3. List your inventory — attach a Vintel verification report to earn the Verified badge

TradeAutoX is a pure venue: sales happen directly between dealers, as-is.

See you on the lot,
TradeAutoX`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">Welcome to TradeAutoX</h2>
<p>Hi ${dealer.contact_name},</p>
<p>Your application for <strong>${dealer.dealership_name}</strong> has been approved — welcome aboard.</p>
${dealer.member_number ? `<p>Your member <strong>ID is ${dealer.member_number}</strong> — other dealers can find your inventory by it.</p>` : ''}
<p><strong>Here's how to get rolling:</strong></p>
<ol>
<li>Log in at <a href="${baseUrl}/login">${baseUrl}/login</a></li>
<li>Activate your <strong>$599/month membership</strong> to start buying and selling — no auction fees, no per-vehicle cut</li>
<li>List your inventory — attach a Vintel verification report to earn the Verified badge</li>
</ol>
<p>TradeAutoX is a pure venue: sales happen directly between dealers, as-is.</p>
<p>See you on the lot,<br><strong>TradeAutoX</strong></p>
</div>`;
  return { subject, text, html };
}

// Admin alert when a dealer's membership payment goes bad. Sent on the
// transition only (active → past_due, or → inactive) so retries don't spam.
function paymentProblemEmail(dealer, membershipStatus) {
  const what = membershipStatus === 'past_due'
    ? 'their $599 payment FAILED and Stripe is retrying the card'
    : 'their subscription has ENDED (canceled/unpaid) — they are no longer paying';
  const subject = membershipStatus === 'past_due'
    ? `TradeAutoX payment failed: ${dealer.dealership_name}`
    : `TradeAutoX subscription ended: ${dealer.dealership_name}`;
  const text =
`Payment problem on TradeAutoX:

Dealership: ${dealer.dealership_name}
Contact: ${dealer.contact_name} (${dealer.email}${dealer.phone ? `, ${dealer.phone}` : ''})
Status: ${what}.

While past due, the dealer keeps full board access — they're only locked out if Stripe gives up and the subscription ends (inactive). You can also suspend or remove them from the admin panel.

— TradeAutoX (automatic alert)`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">TradeAutoX payment problem</h2>
<p><strong>${dealer.dealership_name}</strong> — ${what}.</p>
<p>Contact: ${dealer.contact_name} (${dealer.email}${dealer.phone ? `, ${dealer.phone}` : ''})</p>
<p>While past due, the dealer keeps full board access — they're only locked out if Stripe gives up and the subscription ends (inactive). You can also suspend or remove them from the admin panel.</p>
<p class="small" style="color:#555">Automatic alert from the Stripe webhook.</p>
</div>`;
  return { subject, text, html };
}

function baseUrl() {
  return (process.env.BASE_URL || 'https://tradeautox-production.up.railway.app').replace(/\/$/, '');
}

function auctionAlertEmail(dealer, auction, distance) {
  const vehicle = `${auction.year} ${auction.make} ${auction.model}${auction.trim ? ' ' + auction.trim : ''}`;
  const subject = `Live auction near you: ${vehicle}`;
  const text =
`Hi ${dealer.contact_name},

A live TradeAutoX auction just started${distance != null ? ` ${distance} miles from you` : ''}:

${vehicle}${auction.mileage ? ` — ${Number(auction.mileage).toLocaleString('en-US')} miles` : ''}
Seller: ${auction.dealership_name}
Bidding ends soon — jump in: ${baseUrl()}/auctions/${auction.id}

TradeAutoX is a pure venue: sales happen directly between dealers, as-is.`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">Live auction near you</h2>
<p>Hi ${dealer.contact_name},</p>
<p>A live TradeAutoX auction just started${distance != null ? ` <strong>${distance} miles from you</strong>` : ''}:</p>
<p><strong>${vehicle}</strong>${auction.mileage ? ` — ${Number(auction.mileage).toLocaleString('en-US')} miles` : ''}<br>Seller: ${auction.dealership_name}</p>
<p>Bidding ends soon — <a href="${baseUrl()}/auctions/${auction.id}">jump into the auction room</a>.</p>
<p>TradeAutoX is a pure venue: sales happen directly between dealers, as-is.</p>
</div>`;
  return { subject, text, html };
}

// A vehicle matching a dealer's saved Want just listed — same shape as the
// auction alert, linking to the listing instead of an auction room.
function wantMatchEmail(dealer, listing, want, distance) {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
  const subject = `Want match: ${vehicle} — $${Number(listing.price).toLocaleString('en-US')}`;
  const text =
`Hi ${dealer.contact_name},

A vehicle matching your Want just listed on TradeAutoX${distance != null ? ` ${distance} miles from you` : ''}:

${vehicle}${listing.mileage ? ` — ${Number(listing.mileage).toLocaleString('en-US')} miles` : ''}
Asking $${Number(listing.price).toLocaleString('en-US')} — Seller: ${listing.dealership_name}
View it: ${baseUrl()}/listings/${listing.id}

TradeAutoX is a pure venue: sales happen directly between dealers, as-is.`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">A car you're hunting just listed</h2>
<p>Hi ${dealer.contact_name},</p>
<p>A vehicle matching your Want just listed on TradeAutoX${distance != null ? ` <strong>${distance} miles from you</strong>` : ''}:</p>
<p><strong>${vehicle}</strong>${listing.mileage ? ` — ${Number(listing.mileage).toLocaleString('en-US')} miles` : ''}<br>Asking <strong>$${Number(listing.price).toLocaleString('en-US')}</strong> — Seller: ${listing.dealership_name}</p>
<p><a href="${baseUrl()}/listings/${listing.id}">View the listing</a></p>
<p>TradeAutoX is a pure venue: sales happen directly between dealers, as-is.</p>
</div>`;
  return { subject, text, html };
}

function auctionWonEmail(dealer, auction, bid) {
  const vehicle = `${auction.year} ${auction.make} ${auction.model}${auction.trim ? ' ' + auction.trim : ''}`;
  const subject = `You won the auction: ${vehicle}`;
  const text =
`Hi ${dealer.contact_name},

Your bid of $${Number(bid.amount).toLocaleString('en-US')} was accepted for the ${vehicle}.

Contact the seller to complete the deal:
${auction.dealership_name} — ${auction.contact_name}
Phone: ${auction.phone || '—'}
Email: ${auction.dealer_email}

TradeAutoX is a pure venue: the sale is directly between you and the seller, as-is.`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">You won the auction</h2>
<p>Hi ${dealer.contact_name},</p>
<p>Your bid of <strong>$${Number(bid.amount).toLocaleString('en-US')}</strong> was accepted for the <strong>${vehicle}</strong>.</p>
<p><strong>Contact the seller to complete the deal:</strong><br>
${auction.dealership_name} — ${auction.contact_name}<br>
Phone: ${auction.phone || '—'}<br>
Email: ${auction.dealer_email}</p>
<p>TradeAutoX is a pure venue: the sale is directly between you and the seller, as-is.</p>
</div>`;
  return { subject, text, html };
}

function auctionSoldEmail(dealer, auction, bid) {
  const vehicle = `${auction.year} ${auction.make} ${auction.model}${auction.trim ? ' ' + auction.trim : ''}`;
  const subject = `Your auction sold: ${vehicle}`;
  const text =
`Hi ${dealer.contact_name},

You accepted a bid of $${Number(bid.amount).toLocaleString('en-US')} for the ${vehicle}.

Contact the buyer to complete the deal:
${bid.dealership_name} — ${bid.contact_name}
Phone: ${bid.phone || '—'}
Email: ${bid.dealer_email}

TradeAutoX is a pure venue: the sale is directly between you and the buyer, as-is.`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">Your auction sold</h2>
<p>Hi ${dealer.contact_name},</p>
<p>You accepted a bid of <strong>$${Number(bid.amount).toLocaleString('en-US')}</strong> for the <strong>${vehicle}</strong>.</p>
<p><strong>Contact the buyer to complete the deal:</strong><br>
${bid.dealership_name} — ${bid.contact_name}<br>
Phone: ${bid.phone || '—'}<br>
Email: ${bid.dealer_email}</p>
<p>TradeAutoX is a pure venue: the sale is directly between you and the buyer, as-is.</p>
</div>`;
  return { subject, text, html };
}

// Deal sheet, emailed to BOTH buyer and seller when a buyer clicks Buy on a
// listing. Print-friendly on purpose: white background, black text, plain
// sections, no dark fills — either side can print it and keep it with the
// deal. Buyer and seller are listed separately, each with dealership, point
// of contact, phone, email, and street address (when on file). The seller's
// contact is called out for pickup: the buyer knows who to ask for on arrival.
function dealSheetEmail({ seller, buyer, listing, method }) {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}${listing.trim ? ' ' + listing.trim : ''}`;
  const methodLabel = method === 'wire' ? 'Wire transfer' : 'Check upon pickup';
  const price = `$${Number(listing.price).toLocaleString('en-US')}`;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const partyLines = (d) => [
    `<strong>${d.dealership_name}</strong>`,
    `Point of contact: ${d.contact_name}`,
    `Phone: ${d.phone || 'Not on file'}`,
    `Email: ${d.email}`,
    ...(d.address ? [`${d.address}`] : []),
    ...([d.city, d.state].filter(Boolean).join(', ') || d.zip ? [`${[d.city, d.state].filter(Boolean).join(', ')}${d.zip ? ' ' + d.zip : ''}`.trim()] : []),
  ].join('<br>');
  const partyText = (d) => [
    d.dealership_name,
    `Point of contact: ${d.contact_name}`,
    `Phone: ${d.phone || 'Not on file'}`,
    `Email: ${d.email}`,
    ...(d.address ? [d.address] : []),
    ...([d.city, d.state].filter(Boolean).join(', ') || d.zip ? [`${[d.city, d.state].filter(Boolean).join(', ')}${d.zip ? ' ' + d.zip : ''}`.trim()] : []),
  ].join('\n');
  const subject = `TradeAutoX deal sheet: ${vehicle} — ${methodLabel}`;
  const text =
`TRADEAUTOX DEAL SHEET — ${date}

Vehicle: ${vehicle}
${listing.vin ? `VIN: ${listing.vin}\n` : ''}${listing.mileage ? `Mileage: ${Number(listing.mileage).toLocaleString('en-US')} mi\n` : ''}Price: ${price}
Payment: ${methodLabel}

SELLER
${partyText(seller)}

BUYER
${partyText(buyer)}

WHEN THE BUYER ARRIVES, ASK FOR: ${seller.contact_name} (${seller.phone || seller.email})

What happens next:
- Seller: pull the car and mark it sold on your TradeAutoX dashboard.
- Buyer: ${method === 'wire' ? 'send the wire to the seller and arrange pickup.' : 'bring the check when you pick the car up.'}

Print this email for your records. TradeAutoX is a pure venue — the sale is directly between buyer and seller, as-is.`;
  const html =
`<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#000;background:#fff">
<h1 style="font-size:22px;border-bottom:3px double #000;padding-bottom:8px;margin-bottom:4px">TradeAutoX Deal Sheet</h1>
<p style="color:#333">${date}</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr><td style="padding:6px 8px;border:1px solid #999"><strong>Vehicle</strong></td><td style="padding:6px 8px;border:1px solid #999">${vehicle}</td></tr>
${listing.vin ? `<tr><td style="padding:6px 8px;border:1px solid #999"><strong>VIN</strong></td><td style="padding:6px 8px;border:1px solid #999">${listing.vin}</td></tr>` : ''}
${listing.mileage ? `<tr><td style="padding:6px 8px;border:1px solid #999"><strong>Mileage</strong></td><td style="padding:6px 8px;border:1px solid #999">${Number(listing.mileage).toLocaleString('en-US')} mi</td></tr>` : ''}
<tr><td style="padding:6px 8px;border:1px solid #999"><strong>Price</strong></td><td style="padding:6px 8px;border:1px solid #999">${price}</td></tr>
<tr><td style="padding:6px 8px;border:1px solid #999"><strong>Payment</strong></td><td style="padding:6px 8px;border:1px solid #999">${methodLabel}</td></tr>
</table>
<h2 style="font-size:17px;margin:20px 0 6px">Seller</h2>
<p style="margin:0 0 16px;line-height:1.5">${partyLines(seller)}</p>
<h2 style="font-size:17px;margin:20px 0 6px">Buyer</h2>
<p style="margin:0 0 16px;line-height:1.5">${partyLines(buyer)}</p>
<p style="border:2px solid #000;padding:10px 12px"><strong>When the buyer arrives, ask for: ${seller.contact_name}</strong>${seller.phone ? ` — ${seller.phone}` : ''}</p>
<h2 style="font-size:17px;margin:20px 0 6px">What happens next</h2>
<ul style="line-height:1.6">
<li><strong>Seller:</strong> pull the car and mark it sold on your TradeAutoX dashboard.</li>
<li><strong>Buyer:</strong> ${method === 'wire' ? 'send the wire to the seller and arrange pickup.' : 'bring the check when you pick the car up.'}</li>
</ul>
<p style="color:#333">Print this email for your records. TradeAutoX is a pure venue — the sale is directly between buyer and seller, as-is.</p>
</div>`;
  return { subject, text, html };
}

// Notice to the buyer when a seller cancels a pending purchase intent and puts
// the listing back online — e.g. under the 3-day buyer-silence rule in §5.
function intentCancelledEmail({ seller, buyer, listing }) {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}${listing.trim ? ' ' + listing.trim : ''}`;
  const subject = `TradeAutoX: ${vehicle} is back on the market`;
  const text =
`Hi ${buyer.contact_name},

The seller (${seller.dealership_name}) has cancelled the pending sale for the ${vehicle} and put it back online.

Per the TradeAutoX terms (§5), a seller may cancel a purchase intent and relist the vehicle if they have not heard from the buyer within 3 days of the intent.

TradeAutoX is a pure venue — the sale is directly between buyer and seller, as-is.`;
  const html =
`<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#000;background:#fff">
<p>Hi ${buyer.contact_name},</p>
<p>The seller (<strong>${seller.dealership_name}</strong>) has cancelled the pending sale for the <strong>${vehicle}</strong> and put it back online.</p>
<p>Per the TradeAutoX terms (§5), a seller may cancel a purchase intent and relist the vehicle if they have not heard from the buyer within 3 days of the intent.</p>
<p style="color:#333">TradeAutoX is a pure venue — the sale is directly between buyer and seller, as-is.</p>
</div>`;
  return { subject, text, html };
}

// Email verification link sent at signup. The dealer clicks it to prove
// the address works; until then they can't sign in and their application
// shows in the admin queue as unverified.
function verificationEmail(dealer, token) {
  const link = `${baseUrl()}/verify-email?token=${token}`;
  const subject = 'Verify your email — TradeAutoX application';
  const text =
`Hi ${dealer.contact_name},

Thanks for applying to TradeAutoX. Click the link below to verify this email address — it confirms we can reach you about your application:

${link}

The link expires in 24 hours. If you didn't apply for TradeAutoX, ignore this email.

— TradeAutoX`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">Verify your email</h2>
<p>Hi ${dealer.contact_name},</p>
<p>Thanks for applying to TradeAutoX. Click the link below to verify this email address — it confirms we can reach you about your application:</p>
<p><a href="${link}">${link}</a></p>
<p>The link expires in 24 hours. If you didn't apply for TradeAutoX, ignore this email.</p>
<p>— TradeAutoX</p>
</div>`;
  return { subject, text, html };
}

// "Still available?" nudge: a listing has sat on the board for 30 days
// with no seller confirmation. The seller confirms from the listing page
// (or their dashboard); silence for 7 more days hides the listing.
function staleNudgeEmail({ dealer, listing }) {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
  const link = `${baseUrl()}/listings/${listing.id}`;
  const subject = `Still available? Your ${vehicle} has been on TradeAutoX for 30 days`;
  const text =
`Hi ${dealer.contact_name},

Your ${vehicle} (asking $${Number(listing.price).toLocaleString('en-US')}) has been on the TradeAutoX board for over 30 days.

If it's still available, click below to confirm — that keeps it live for another 30 days:

${link}

If it's sold, mark it sold from your dashboard; if it's no longer available, remove it. If we don't hear from you in 7 days, we'll hide the listing from the board — you can put it back anytime from your dashboard.

— TradeAutoX`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">Still available?</h2>
<p>Hi ${dealer.contact_name},</p>
<p>Your <strong>${vehicle}</strong> (asking $${Number(listing.price).toLocaleString('en-US')}) has been on the TradeAutoX board for over 30 days.</p>
<p>If it's still available, <a href="${link}">click here to confirm</a> — that keeps it live for another 30 days.</p>
<p>If it's sold, mark it sold from your dashboard; if it's no longer available, remove it. If we don't hear from you in 7 days, we'll hide the listing from the board — you can put it back anytime from your dashboard.</p>
<p>— TradeAutoX</p>
</div>`;
  return { subject, text, html };
}

// The 7-day silence window passed: the listing is hidden from the board.
// The seller puts it back with one click (Relist) from their dashboard.
function listingExpiredEmail({ dealer, listing }) {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
  const subject = `Your ${vehicle} was hidden from the TradeAutoX board`;
  const text =
`Hi ${dealer.contact_name},

We asked a week ago whether your ${vehicle} (asking $${Number(listing.price).toLocaleString('en-US')}) was still available and didn't hear back, so we've hidden it from the TradeAutoX board to keep the board honest.

Nothing is deleted — put it back anytime from your dashboard (Relist), or list it again if the details changed.

— TradeAutoX`;
  const html =
`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#111">
<h2 style="border-bottom:3px double #111;padding-bottom:8px">Listing hidden</h2>
<p>Hi ${dealer.contact_name},</p>
<p>We asked a week ago whether your <strong>${vehicle}</strong> (asking $${Number(listing.price).toLocaleString('en-US')}) was still available and didn't hear back, so we've hidden it from the board to keep the board honest.</p>
<p>Nothing is deleted — put it back anytime from your dashboard (Relist), or list it again if the details changed.</p>
<p>— TradeAutoX</p>
</div>`;
  return { subject, text, html };
}

module.exports = { mailConfigured, sendMail, welcomeEmail, paymentProblemEmail, auctionAlertEmail, auctionWonEmail, auctionSoldEmail, dealSheetEmail, intentCancelledEmail, wantMatchEmail, verificationEmail, staleNudgeEmail, listingExpiredEmail };
