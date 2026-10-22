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

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    return res.status(500).render('admin-login', { error: 'Admin credentials are not configured on the server.' });
  }
  if (email === adminEmail && password === adminPassword) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.status(401).render('admin-login', { error: 'Invalid admin credentials.' });
});

router.get('/logout', (req, res) => {
  req.session.admin = false;
  res.redirect('/admin/login');
});

router.get('/', requireAdmin, (req, res) => {
  const members = db.listAllDealers();
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
  });
});

router.post('/dealers/:id/approve', requireAdmin, (req, res) => {
  db.setDealerStatus(req.params.id, 'approved');
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
