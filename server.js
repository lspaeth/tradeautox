require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const db = require('./db'); // initializes schema
const billing = require('./routes/billing');

const app = express();
const PORT = process.env.PORT || 3000;

// Uploads directory (gitignored; on Railway this lives on the persistent volume via DATA_DIR)
const dataDir = process.env.DATA_DIR || __dirname;
const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Stripe webhook MUST come before express.json() — signature verification needs the raw body
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), billing.handleWebhook);

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Build stamp, visible in the footer on every page and via /version, so a live
// deploy is verifiable instead of guessed at. Railway injects the commit SHA.
app.locals.buildCommit = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';

app.use(session({
  secret: process.env.SESSION_SECRET || 'tradeautox-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
}));

// Make auth state available to all views
app.use((req, res, next) => {
  res.locals.currentDealer = req.session.dealerId ? db.getDealerById(req.session.dealerId) : null;
  res.locals.isAdmin = !!req.session.admin;
  res.locals.fmtMoney = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  next();
});

app.use('/', require('./routes/site'));
app.use('/', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/listings', require('./routes/listings'));
app.use('/auctions', require('./routes/auctions'));
app.use('/admin', require('./routes/admin'));
app.use('/billing', billing.billingRouter);

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`TradeAutoX listening on http://localhost:${PORT}`);
});
