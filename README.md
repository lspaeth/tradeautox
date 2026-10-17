# TradeAutoX

B2B wholesale vehicle marketplace for licensed auto dealers.

- **Flat $599/month membership** — unlimited buying and selling, no per-transaction auction fees.
- **Licensed dealers only** — wholesale license verified at signup; applications sit in a pending queue until an admin approves them.
- **Stripe billing** — subscriptions via Stripe Checkout, self-serve billing portal, webhooks keep membership status in sync. **Refunds are issued natively in the Stripe Dashboard** (Payments → select payment → Refund) — no custom code involved.

## Business model: listing venue only (no escrow)

TradeAutoX is strictly a go-between listing venue. Dealers sign up, upload photos, and list vehicles; buyers browse and buy **directly from the selling dealer**. The platform:

- processes **no** vehicle transactions,
- holds **no** escrow,
- takes **no** commission or cut of any sale.

Revenue is the $599/mo membership alone. Do not reintroduce transaction processing, escrow, or per-sale fees without an explicit business decision — the old Stripe Connect integration (payouts/escrow) was the source of the v1 failure. The `/terms` page and the signup checkbox carry the marketplace liability disclaimer; every listing detail page shows the as-is, buyer-seller-only banner.

## Stack

Node.js + Express + better-sqlite3 + EJS + multer + Stripe Node SDK + bcryptjs. Single process, SQLite file, local `uploads/` dir.

## Quick start

```bash
cp .env.example .env
# edit .env: SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL
npm install
node server.js
# → http://localhost:3000
```

- Landing: `/`
- Dealer signup: `/signup` (creates a `pending` account)
- Dealer login: `/login`
- Admin panel: `/admin` (login with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`)
- Member dashboard: `/dashboard`
- Wholesale board: `/listings` (approved + active membership only)

## Stripe test-mode walkthrough

1. Create a free Stripe account at https://dashboard.stripe.com and switch to **Test mode**.
2. Copy `.env.example` to `.env` and fill in:
   - `STRIPE_SECRET_KEY` — from https://dashboard.stripe.com/test/apikeys (starts `sk_test_`)
   - `STRIPE_PUBLISHABLE_KEY` — same page (starts `pk_test_`)
3. Create the $599/mo product + price:
   ```bash
   npm run setup-stripe
   # prints STRIPE_PRICE_ID — paste it into .env
   ```
4. Webhooks (so memberships activate automatically):
   - Install the Stripe CLI, then: `stripe listen --forward-to localhost:3000/webhooks/stripe`
   - The CLI prints a webhook signing secret (`whsec_...`) — paste it into `.env` as `STRIPE_WEBHOOK_SECRET`.
   - Restart the server.
5. Customer portal (the "Manage billing" button): in the Stripe Dashboard under **Settings → Billing → Customer portal** (test mode), enable it once.
6. End-to-end test:
   - Sign up a dealer at `/signup`, approve them at `/admin`.
   - Log in as the dealer → Dashboard → **Activate membership**.
   - Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.
   - The webhook (or the success-page fallback) flips the dealer to `active` — they can now browse and post listings.
   - Cancel via **Manage billing** → the `customer.subscription.deleted` webhook flips them back to `inactive`.
7. Refunds: **Stripe Dashboard → Payments** → open the payment → **Refund**. That's it — refunds need no app code, which is exactly what was broken in v1.

## How memberships stay in sync

| Stripe event | App effect |
|---|---|
| `checkout.session.completed` | dealer → `membership_status = active` |
| `customer.subscription.updated` → `past_due` | dealer → `past_due` (prompted to update card) |
| `customer.subscription.deleted` / `unpaid` | dealer → `inactive` (loses board access) |

The `/billing/success` page also re-checks the Checkout Session as a fallback, so a slow webhook never strands a paying dealer.

## Deploy notes

- **Node 20+**, single process (`node server.js` or via PM2/systemd).
- **Persistent disk required** for `tradeautox.db` (SQLite) and `uploads/` — on ephemeral hosts (plain Heroku dynos, etc.) use a volume or object storage; the stock multer disk config assumes local disk.
- Set all env vars from `.env.example` in the host's environment; never commit `.env`.
- Put the app behind HTTPS (webhooks and Checkout require it in live mode) — e.g. Caddy/Nginx reverse proxy.
- Set `BASE_URL=https://tradeautox.com` in production so Checkout/portal redirects work.
- Point GoDaddy DNS for `tradeautox.com` at the server (A record to the host IP, or CNAME per the host's docs).
- In production, restrict `/uploads` or move license photos out of the public static path; restrict admin to known IPs if possible.
- The session store is in-memory (fine for one process); use `connect-sqlite3` or Redis if you ever run multiple processes.

## Project layout

```
server.js            Express app, session, route mounting (webhook mounted before body parsers)
db.js                SQLite schema + data-access helpers
lib/stripe.js        Lazy Stripe client (app boots fine without keys)
lib/auth.js          requireLogin / requireMember / requireAdmin middleware
lib/upload.js        multer config (images only, 10 MB, uploads/)
routes/site.js       Landing page
routes/auth.js       Signup (license upload) / login / logout
routes/dashboard.js  Member dashboard + membership status
routes/listings.js   Browse/search (members only), new listing, detail, mark sold/removed
routes/admin.js      Admin login, approve/reject queue, member list
routes/billing.js    Checkout, success/cancel, customer portal, Stripe webhook handler
scripts/setup-stripe.js  Creates the $599/mo product + price, prints STRIPE_PRICE_ID
views/               EJS templates (partials/header, footer)
public/styles.css    Styling
uploads/             Uploaded photos (gitignored)
```
