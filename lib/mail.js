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
  const text =
`Hi ${dealer.contact_name},

Your TradeAutoX application for ${dealer.dealership_name} has been approved — welcome aboard.

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

module.exports = { mailConfigured, sendMail, welcomeEmail, auctionAlertEmail, auctionWonEmail, auctionSoldEmail };
