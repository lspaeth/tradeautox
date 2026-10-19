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

module.exports = { mailConfigured, sendMail, welcomeEmail };
