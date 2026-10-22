const express = require('express');
const db = require('../db');
const { requireLogin } = require('../lib/auth');
const { getStripe, stripeConfigured, baseUrl } = require('../lib/stripe');
const { sendMail, paymentProblemEmail } = require('../lib/mail');

const router = express.Router();

function billingReady(res) {
  if (!stripeConfigured() || !process.env.STRIPE_PRICE_ID) {
    res.status(500).render('billing-error', {
      message: 'Billing is not configured yet. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID (see README.md).',
    });
    return false;
  }
  return true;
}

// Start subscription checkout — approved dealers only
router.post('/checkout', requireLogin, async (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer || dealer.status !== 'approved') return res.redirect('/dashboard');
  if (!billingReady(res)) return;
  try {
    const stripe = getStripe();
    let customerId = dealer.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: dealer.email,
        name: dealer.dealership_name,
        phone: dealer.phone || undefined,
        metadata: { dealer_id: String(dealer.id) },
      });
      customerId = customer.id;
      db.setStripeCustomer(dealer.id, customerId);
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      metadata: { dealer_id: String(dealer.id) },
      subscription_data: {
        trial_period_days: 30, // first 30 days free — card is collected but not charged until the trial ends
        metadata: { dealer_id: String(dealer.id) },
      },
      success_url: `${baseUrl()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl()}/billing/cancel`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('checkout error:', err);
    res.status(500).render('billing-error', { message: 'Could not start checkout. Please try again.' });
  }
});

// Success page — includes a fallback activation in case the webhook hasn't fired yet
router.get('/success', requireLogin, async (req, res) => {
  let dealer = db.getDealerById(req.session.dealerId);
  if (req.query.session_id && stripeConfigured()) {
    try {
      const s = await getStripe().checkout.sessions.retrieve(req.query.session_id);
      // Trials collect a card but take no payment, so payment_status is 'no_payment_required'.
      const paidLike = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
      if (paidLike && String(s.metadata.dealer_id) === String(dealer.id)) {
        db.setMembership(dealer.id, 'active', s.subscription);
      }
    } catch (err) {
      console.error('success fallback error:', err);
    }
  }
  dealer = db.getDealerById(req.session.dealerId);
  res.render('billing-success', { dealer });
});

router.get('/cancel', requireLogin, (req, res) => {
  res.render('billing-cancel');
});

// Customer portal — dealers manage/cancel their own subscription
router.post('/portal', requireLogin, async (req, res) => {
  const dealer = db.getDealerById(req.session.dealerId);
  if (!dealer || !dealer.stripe_customer_id) return res.redirect('/dashboard');
  if (!billingReady(res)) return;
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: dealer.stripe_customer_id,
      return_url: `${baseUrl()}/dashboard`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('portal error:', err);
    res.status(500).render('billing-error', { message: 'Could not open the billing portal. Please try again.' });
  }
});

// ---- Webhook (registered with express.raw in server.js — signature verification needs the raw body)
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    const stripe = getStripe();
    if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const dealerId = s.metadata && s.metadata.dealer_id;
        if (dealerId) {
          db.setMembership(Number(dealerId), 'active', s.subscription || null);
          console.log(`membership activated for dealer ${dealerId}`);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const dealer = db.getDealerByStripeCustomer(sub.customer);
        if (dealer) {
          // past_due is a flag, not a lockout: the dealer keeps full board
          // access while Stripe retries (see BOARD_ACCESS_STATUSES in
          // lib/auth.js). Only when Stripe gives up — unpaid, canceled, or
          // the subscription is deleted — does the dealer become 'inactive'
          // and lose access. A later 'active' update clears the flag.
          const map = {
            active: 'active',
            trialing: 'active',
            past_due: 'past_due',
            unpaid: 'inactive',
            canceled: 'inactive',
            incomplete_expired: 'inactive',
          };
          const status = map[sub.status] || 'inactive';
          const prev = dealer.membership_status;
          db.setMembership(dealer.id, status, sub.id);
          console.log(`membership ${status} for dealer ${dealer.id}`);
          // Tell the admin the moment a dealer stops paying — once, on the
          // transition into past_due/inactive, not on every Stripe retry.
          if ((status === 'past_due' || status === 'inactive') && prev !== status && process.env.ADMIN_EMAIL) {
            const msg = paymentProblemEmail(dealer, status);
            sendMail({ to: process.env.ADMIN_EMAIL, ...msg }).catch((err) =>
              console.error('[mail] payment problem alert failed:', err.message));
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('webhook handler error:', err);
  }
  res.json({ received: true });
}

module.exports = { billingRouter: router, handleWebhook };
