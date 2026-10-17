# TradeAutoX — Live Stripe (created 2026-10-17)

Stripe account: Tradeautox (acct_1URaBg355EGA6AmI, livemode)

- Product: `prod_VSVyN9BpZhjK4V` — "TradeAutoX Dealer Membership"
- Price: `price_1URaxK355EGA6AmInpeN8LXO` — $599.00 USD / month, recurring

App env needed at deploy time:
```
STRIPE_SECRET_KEY=<live secret key from Stripe dashboard>
STRIPE_PUBLISHABLE_KEY=<live publishable key>
STRIPE_WEBHOOK_SECRET=<from webhook endpoint setup>
STRIPE_PRICE_ID=price_1URaxK355EGA6AmInpeN8LXO
ADMIN_EMAIL=<Louis/Mike admin login email>
ADMIN_PASSWORD=<strong password via Secure Vault>
```

Refunds: handled natively in the Stripe Dashboard (Payments → select payment → Refund).
Customer portal: enable the Billing customer portal in Stripe Dashboard → Settings → Billing,
so dealers can update cards / cancel themselves.
Webhook: after deploy, add endpoint https://<host>/webhooks/stripe with events
checkout.session.completed, customer.subscription.updated, customer.subscription.deleted.
