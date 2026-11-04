const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const upload = require('../lib/upload');
const { requireAdmin } = require('../lib/auth');
const { createListingFromRequest } = require('../lib/listings');
const { getStripe, stripeConfigured } = require('../lib/stripe');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    return res.status(500).render('admin-login', { error: 'Admin credentials are not configured on the server.' });
  }
  // Owner login (env credentials) — behavior unchanged.
  if (email === adminEmail && password === adminPassword) {
    req.session.admin = true;
    req.session.admin_email = adminEmail;
    return res.redirect('/admin');
  }
  // Extra admin logins (invited, each with their own credentials).
  const extra = email ? db.getAdminByEmail(String(email).toLowerCase().trim()) : null;
  if (extra && await bcrypt.compare(password || '', extra.password_hash)) {
    req.session.admin = true;
    req.session.admin_email = extra.email;
    return res.redirect('/admin');
  }
  res.status(401).render('admin-login', { error: 'Invalid admin credentials.' });
});

router.get('/logout', (req, res) => {
  req.session.admin = false;
  req.session.admin_email = null;
  delete req.session.dealerId;
  delete req.session.impersonatingDealerId;
  delete req.session.impersonatingFrom;
  res.redirect('/admin/login');
});

// ---- view-as-dealer impersonation ----
// Lets the admin see the site exactly as a dealer sees it (support/debugging).
// Sets the SAME session key the dealer login sets (session.dealerId) — no
// parallel auth path. The admin flag stays so "Exit view" can return to /admin.
// Works for any status (pending/suspended included): it bypasses the login
// gate but changes nothing about the dealer's actual record.
router.post('/dealers/:id/impersonate', requireAdmin, (req, res) => {
  const dealer = db.getDealerById(req.params.id);
  if (!dealer) return res.status(404).render('404');
  const adminEmail = req.session.admin_email || 'owner';
  req.session.impersonatingFrom = adminEmail;
  req.session.impersonatingDealerId = dealer.id;
  req.session.dealerId = dealer.id;
  console.log(`[admin] ${adminEmail} started viewing as dealer ${dealer.id} (${dealer.dealership_name})`);
  res.redirect('/dashboard');
});

// Exit view-as mode: drop the dealer session, keep the admin session.
// No requireAdmin here on purpose — without an active impersonation this is a
// harmless no-op that just sends the visitor home.
router.post('/impersonate/exit', (req, res) => {
  if (req.session.impersonatingDealerId) {
    const adminEmail = req.session.impersonatingFrom || req.session.admin_email || 'owner';
    console.log(`[admin] ${adminEmail} stopped viewing as dealer ${req.session.impersonatingDealerId}`);
    delete req.session.dealerId;
    delete req.session.impersonatingDealerId;
    delete req.session.impersonatingFrom;
    return res.redirect('/admin');
  }
  res.redirect('/');
});

// One-time admin setup link. Public — the invitee isn't logged in yet.
router.get('/setup/:token', (req, res) => {
  const invite = db.getAdminInvite(req.params.token);
  if (!invite || invite.used_at || new Date(invite.expires_at) <= new Date()) {
    return res.status(410).render('admin-setup', { invalid: true, error: null, email: '' });
  }
  res.render('admin-setup', { invalid: false, error: null, email: '' });
});

router.post('/setup/:token', async (req, res) => {
  const invite = db.getAdminInvite(req.params.token);
  if (!invite || invite.used_at || new Date(invite.expires_at) <= new Date()) {
    return res.status(410).render('admin-setup', { invalid: true, error: null, email: '' });
  }
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const fail = (error) =>
    res.status(400).render('admin-setup', { invalid: false, error, email: String(req.body.email || '') });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (password !== confirm) return fail('Passwords do not match.');
  if (email === String(process.env.ADMIN_EMAIL || '').toLowerCase()) {
    return fail('That email is already the owner login — use a different one.');
  }
  if (db.getAdminByEmail(email)) return fail('An admin with that email already exists.');
  // Re-check the invite wasn't used between the form view and submit.
  const fresh = db.getAdminInvite(req.params.token);
  if (!fresh || fresh.used_at) {
    return res.status(410).render('admin-setup', { invalid: true, error: null, email: '' });
  }
  db.createAdmin(email, await bcrypt.hash(password, 12));
  db.markAdminInviteUsed(req.params.token);
  req.session.admin = true;
  req.session.admin_email = email;
  res.redirect('/admin');
});

router.get('/', requireAdmin, (req, res) => {
  const members = db.listAllDealers();
  const baseUrl = (process.env.BASE_URL || 'https://www.tradeautox.com').replace(/\/$/, '');
  res.render('admin', {
    pending: db.listDealersByStatus('pending'),
    members,
    // Dealers who stopped paying: card failing (past_due) or subscription
    // ended (inactive). The demo dealer never bills, so it's excluded.
    paymentIssues: members.filter((d) =>
      d.email !== db.DEMO_DEALER_EMAIL && d.status !== 'rejected' &&
      (d.membership_status === 'past_due' || d.membership_status === 'inactive')),
    resets: db.listOpenPasswordResets(),
    demoEmail: db.DEMO_DEALER_EMAIL,
    admins: db.listAdmins(),
    invites: db.listOpenAdminInvites().map((i) => ({ ...i, link: `${baseUrl}/admin/setup/${i.token}` })),
    adminEmail: req.session.admin_email || null,
    ownerEmail: process.env.ADMIN_EMAIL || null,
  });
});

// Create a one-time admin invite link (valid 7 days). The link is shown once —
// send it to the person yourself (text or email).
router.post('/invites', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.createAdminInvite(token, expiresAt, req.session.admin_email || null);
  const baseUrl = (process.env.BASE_URL || 'https://www.tradeautox.com').replace(/\/$/, '');
  res.render('admin-invite-created', { link: `${baseUrl}/admin/setup/${token}`, expiresAt });
});

// Revoke an unused invite link.
router.post('/invites/:token/revoke', requireAdmin, (req, res) => {
  db.revokeAdminInvite(req.params.token);
  res.redirect('/admin');
});

// Remove an extra admin login. The owner (env credentials) is never in the
// table and can't be removed here; nobody can remove their own login.
router.post('/admins/:id/remove', requireAdmin, (req, res) => {
  const target = db.getAdminById(req.params.id);
  if (!target) return res.redirect('/admin');
  if (target.email === req.session.admin_email) return res.redirect('/admin');
  db.removeAdmin(target.id);
  res.redirect('/admin');
});

router.post('/dealers/:id/approve', requireAdmin, (req, res) => {
  db.setDealerStatus(req.params.id, 'approved');
  // Member ID is assigned at approval, before the welcome email is built so
  // the email can include it. Idempotent — re-approvals never move the number.
  db.assignMemberNumber(req.params.id);
  // Welcome email — fire and forget; approval must not fail if email does.
  const dealer = db.getDealerById(req.params.id);
  if (dealer) {
    const { sendMail, welcomeEmail } = require('../lib/mail');
    const msg = welcomeEmail(dealer);
    sendMail({ to: dealer.email, ...msg }).catch((err) =>
      console.error('[mail] welcome email failed:', err.message));
  }
  res.redirect('/admin');
});

router.post('/dealers/:id/reject', requireAdmin, (req, res) => {
  db.setDealerStatus(req.params.id, 'rejected');
  res.redirect('/admin');
});

// Suspend an approved dealer: login is blocked, listings and auctions drop
// off the board, AND subscription billing is paused (Stripe pause_collection,
// behavior "void" — the subscription stays in place, no invoices or charges
// while paused). Reversible via reactivate, which resumes collection.
// Same discipline as dealer removal: if the dealer has a live subscription
// and the pause/resume can't be verified in Stripe, the state change aborts
// so access and billing never silently desync. Dealers with no subscription
// suspend/reactivate with no Stripe call. The demo dealer is protected —
// demo posting depends on it.
router.post('/dealers/:id/suspend', requireAdmin, async (req, res) => {
  const dealer = db.getDealerById(req.params.id);
  if (!dealer || dealer.email === db.DEMO_DEALER_EMAIL || dealer.status !== 'approved') {
    return res.redirect('/admin');
  }

  if (dealer.stripe_subscription_id && stripeConfigured()) {
    try {
      const stripe = getStripe();
      const sub = await stripe.subscriptions.retrieve(dealer.stripe_subscription_id);
      const billable = ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status);
      if (billable && !sub.pause_collection) {
        await stripe.subscriptions.update(dealer.stripe_subscription_id, {
          pause_collection: { behavior: 'void' },
        });
        const check = await stripe.subscriptions.retrieve(dealer.stripe_subscription_id);
        if (!check.pause_collection || check.pause_collection.behavior !== 'void') {
          throw new Error('Stripe did not confirm the billing pause');
        }
      }
    } catch (err) {
      console.error('[admin] suspend aborted — Stripe pause failed:', err.message);
      return res.status(500).send(
        'Could not pause this dealer\'s Stripe billing, so they were NOT suspended. ' +
        'Pause the subscription in the Stripe Dashboard first, then suspend the dealer.'
      );
    }
  }

  db.setDealerStatus(dealer.id, 'suspended');
  res.redirect('/admin');
});

router.post('/dealers/:id/reactivate', requireAdmin, async (req, res) => {
  const dealer = db.getDealerById(req.params.id);
  if (!dealer || dealer.email === db.DEMO_DEALER_EMAIL || dealer.status !== 'suspended') {
    return res.redirect('/admin');
  }

  if (dealer.stripe_subscription_id && stripeConfigured()) {
    try {
      const stripe = getStripe();
      const sub = await stripe.subscriptions.retrieve(dealer.stripe_subscription_id);
      if (sub.pause_collection) {
        // An empty pause_collection clears the pause and resumes collection.
        await stripe.subscriptions.update(dealer.stripe_subscription_id, { pause_collection: '' });
        const check = await stripe.subscriptions.retrieve(dealer.stripe_subscription_id);
        if (check.pause_collection) {
          throw new Error('Stripe did not confirm billing resumed');
        }
      }
    } catch (err) {
      console.error('[admin] reactivate aborted — Stripe resume failed:', err.message);
      return res.status(500).send(
        'Could not resume this dealer\'s Stripe billing, so they were NOT reactivated. ' +
        'Resume the subscription in the Stripe Dashboard first, then reactivate the dealer.'
      );
    }
  }

  db.setDealerStatus(dealer.id, 'approved');
  db.assignMemberNumber(dealer.id); // idempotent — a suspended dealer keeps its original ID
  res.redirect('/admin');
});

// Permanently remove a dealer account (e.g. the launch test account) along
// with everything attached to it. A live Stripe subscription is canceled
// first so a removed dealer is never billed for a deleted account; if Stripe
// can't confirm the cancel, removal aborts and nothing is deleted. The demo
// dealer is protected — demo posting depends on it.
router.post('/dealers/:id/remove', requireAdmin, async (req, res) => {
  const dealer = db.getDealerById(req.params.id);
  if (!dealer) return res.redirect('/admin');
  if (dealer.email === db.DEMO_DEALER_EMAIL) return res.redirect('/admin');

  if (dealer.stripe_subscription_id && stripeConfigured()) {
    try {
      const stripe = getStripe();
      const sub = await stripe.subscriptions.retrieve(dealer.stripe_subscription_id);
      if (['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) {
        await stripe.subscriptions.cancel(dealer.stripe_subscription_id);
      }
    } catch (err) {
      console.error('[admin] dealer remove aborted — Stripe check failed:', err.message);
      return res.status(500).send(
        'Could not verify/cancel this dealer\'s Stripe subscription, so nothing was removed. ' +
        'Cancel the subscription in the Stripe Dashboard first, then remove the dealer.'
      );
    }
  }

  const uploadsDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
  const files = db.getDealerFilePaths(dealer.id);
  db.deleteDealer(dealer.id);
  for (const p of files) {
    fs.unlink(path.join(uploadsDir, path.basename(p)), () => {});
  }
  res.redirect('/admin');
});

// Issue a one-time temporary password for a reset request.
// Shown once on screen — the admin passes it to the dealer directly.
router.post('/resets/:id/issue', requireAdmin, async (req, res) => {
  const reset = db.getPasswordReset(req.params.id);
  if (!reset || reset.used_at) return res.redirect('/admin');
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  const tempPassword = `TAX-${s.slice(0, 4)}-${s.slice(4)}`;
  db.setDealerPassword(reset.dealer_id, await bcrypt.hash(tempPassword, 12));
  db.setMustChangePassword(reset.dealer_id, 1);
  db.markPasswordResetUsed(reset.id);
  // Email the temp password too (skipped gracefully if SMTP isn't configured).
  const { sendMail } = require('../lib/mail');
  let emailed = false;
  try {
    emailed = await sendMail({
      to: reset.email,
      subject: 'Your TradeAutoX temporary password',
      text:
`Hi ${reset.contact_name},

Your temporary TradeAutoX password is:

${tempPassword}

Log in at ${(process.env.BASE_URL || 'https://tradeautox-production.up.railway.app').replace(/\/$/, '')}/login and you'll be asked to choose a new password.

— TradeAutoX`,
    });
  } catch (err) {
    console.error('[mail] temp password email failed:', err.message);
  }
  res.render('admin-reset-issued', { reset, tempPassword, emailed });
});

// Post a demo vehicle (listed under the TradeAutoX demo seller, for showing how it works)
router.get('/listings/new', requireAdmin, (req, res) => {
  res.render('listing-new', {
    error: null, formAction: '/admin/listings', heading: 'Post a demo vehicle', isAdmin: true,
  });
});

router.post('/listings', requireAdmin, upload.listingUpload, async (req, res) => {
  try {
    const demo = await db.ensureDemoDealer();
    const listingId = createListingFromRequest(demo.id, req.body, req.files);
    res.redirect(`/listings/${listingId}`);
  } catch (err) {
    console.error(err);
    res.status(400).render('listing-new', {
      error: err.message || 'Something went wrong saving the listing.',
      formAction: '/admin/listings', heading: 'Post a demo vehicle', isAdmin: true,
    });
  }
});

// Mark sold / remove any listing (admin)
router.post('/listings/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['sold', 'removed'].includes(status)) return res.redirect('/admin');
  db.setListingStatusById(req.params.id, status);
  res.redirect('/admin');
});

module.exports = router;
