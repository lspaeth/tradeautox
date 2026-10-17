// Lazy Stripe client — throws a clear error if keys are missing so the app
// still boots and serves pages without Stripe configured.
let stripe = null;

function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set. See .env.example and README.md.');
  }
  if (!stripe) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

function baseUrl() {
  return (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

module.exports = { getStripe, stripeConfigured, baseUrl };
