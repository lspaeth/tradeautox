// Creates the $599/month TradeAutoX dealer membership product + price in Stripe.
// Run: npm run setup-stripe   (needs STRIPE_SECRET_KEY in .env)
require('dotenv').config();

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and add your test key.');
    process.exit(1);
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  const product = await stripe.products.create({
    name: 'TradeAutoX Dealer Membership',
    description: 'Flat $599/month wholesale marketplace membership. Unlimited buying and selling, no auction fees. Wholesale license required.',
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 59900, // $599.00
    currency: 'usd',
    recurring: { interval: 'month' },
    nickname: 'Dealer membership — monthly',
  });

  console.log('\nDone! Add this to your .env:\n');
  console.log(`STRIPE_PRICE_ID=${price.id}`);
  console.log(`\nProduct: ${product.id}\n`);
}

main().catch((err) => {
  console.error('setup-stripe failed:', err.message);
  process.exit(1);
});
