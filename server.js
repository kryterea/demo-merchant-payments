require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || '';
const APP_BASE = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS merchants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    amount_kobo INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    reference TEXT NOT NULL UNIQUE,
    amount_kobo INTEGER NOT NULL,
    expected_kobo INTEGER,
    customer_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    paystack_id INTEGER,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Migration for existing DBs: keep the amount the customer actually paid in
// amount_kobo and the link amount in expected_kobo so mismatches can show both.
try {
  const cols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
  if (!cols.includes('expected_kobo')) {
    db.exec('ALTER TABLE payments ADD COLUMN expected_kobo INTEGER');
  }
  db.exec(`UPDATE payments SET expected_kobo = amount_kobo WHERE expected_kobo IS NULL`);
} catch (e) { /* best-effort migration; fresh DBs already have the column */ }

// --- helpers ---
const naira = (kobo) => (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function newCode() {
  for (let i = 0; i < 5; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    if (!db.prepare('SELECT 1 FROM links WHERE code = ?').get(code)) return code;
  }
  return crypto.randomBytes(6).toString('hex');
}

function newReference() {
  return 'LGP_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function signSession(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

function paystackHeaders() {
  return { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' };
}

async function paystackVerify(reference) {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: paystackHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(body.message || 'paystack_verify_failed');
  return body.data;
}

function markPaid(payment, data) {
  db.prepare(
    `UPDATE payments SET status = 'paid', paystack_id = ?, customer_email = ?, paid_at = COALESCE(paid_at, datetime('now')) WHERE id = ?`
  ).run(data && data.id ? data.id : payment.paystack_id, (data && data.customer && data.customer.email) || payment.customer_email, payment.id);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}

// Paystack gateway statuses that mean the money is still moving (bank
// transfer, USSD): keep the row pending and tell the customer to wait.
// Only 'abandoned' and 'failed' mean the payment is closed.
const PROCESSING_STATUSES = new Set(['ongoing', 'pending', 'processing', 'queued']);
const CLOSED_STATUSES = new Set(['abandoned', 'failed']);

// How long the customer should wait before tapping Pay / Verify again after
// an unclear verification. Shown as exact seconds on the pay page.
const VERIFY_RETRY_WAIT_SECS = Number(process.env.VERIFY_RETRY_WAIT_SECS) || 60;

// --- request throttling (in-memory) ---
// Slows down password guessing and floods of fake pending payments.
// Limits are configurable by environment; all 429s carry retry_after_secs
// so the client can show "wait N seconds".
// The client IP comes from X-Forwarded-For ONLY when TRUST_PROXY=true in
// .env (i.e. the app runs behind a proxy you control). Otherwise the socket
// address is used, so a client cannot dodge limits by spoofing the header.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const RATE_LIMITS = {
  signup: {
    limit: Number(process.env.RATE_SIGNUP_LIMIT) || 10,
    windowSecs: Number(process.env.RATE_SIGNUP_WINDOW_SECS) || 600,
  },
  login: {
    limit: Number(process.env.RATE_LOGIN_LIMIT) || 10,
    windowSecs: Number(process.env.RATE_LOGIN_WINDOW_SECS) || 600,
    perEmailLimit: Number(process.env.RATE_LOGIN_PER_EMAIL_LIMIT) || 10,
  },
  initiate: {
    limit: Number(process.env.RATE_INITIATE_LIMIT) || 20,
    windowSecs: Number(process.env.RATE_INITIATE_WINDOW_SECS) || 600,
  },
  verify: {
    limit: Number(process.env.RATE_VERIFY_LIMIT) || 30,
    windowSecs: Number(process.env.RATE_VERIFY_WINDOW_SECS) || 600,
  },
};
const _hits = new Map(); // key -> number[] timestamps (ms)
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// Drop fully-expired buckets so the map stays small: iterate on each check
// and delete keys whose window has passed and that hold no fresh hits.
function checkRate(key, limit, windowSecs) {
  const now = Date.now();
  const windowMs = windowSecs * 1000;
  for (const [k, arr] of _hits) {
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    if (!arr.length) _hits.delete(k);
    // Bound sweep cost: stop early on large maps.
    if (_hits.size > 5000) break;
  }
  let arr = _hits.get(key);
  if (!arr) { arr = []; _hits.set(key, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) {
    const retryAfter = Math.ceil((arr[0] + windowMs - now) / 1000);
    return { allowed: false, retryAfterSecs: Math.max(1, retryAfter) };
  }
  arr.push(now);
  return { allowed: true, retryAfterSecs: 0 };
}
function tooMany(res, retryAfterSecs) {
  res.set('Retry-After', String(retryAfterSecs));
  return res.status(429).json({
    error: 'too_many_requests',
    retry_after_secs: retryAfterSecs,
    message: `Too many attempts. Please wait ${retryAfterSecs} seconds before trying again.`,
  });
}
function rateLimit(bucket) {
  const cfg = RATE_LIMITS[bucket];
  return (req, res, next) => {
    const key = `${bucket}:${clientIp(req)}`;
    const r = checkRate(key, cfg.limit, cfg.windowSecs);
    if (!r.allowed) return tooMany(res, r.retryAfterSecs);
    next();
  };
}
// Extra guard on login: cap tries per email as well as per IP, so an attacker
// rotating IPs cannot hammer one merchant account unchecked.
function loginEmailLimit(req, res, next) {
  const cfg = RATE_LIMITS.login;
  const email = String((req.body || {}).email || '').toLowerCase();
  if (!email) return next();
  const r = checkRate(`login-email:${email}`, cfg.perEmailLimit, cfg.windowSecs);
  if (!r.allowed) return tooMany(res, r.retryAfterSecs);
  next();
}

function mismatchInfo(payment, chargedKobo) {
  const expected = payment.expected_kobo != null ? payment.expected_kobo : payment.amount_kobo;
  const paid = typeof chargedKobo === 'number' ? chargedKobo : payment.amount_kobo;
  const diff = paid - expected;
  return { expected, paid, diff };
}

// --- middleware ---
function auth(req, res, next) {
  const token = req.cookies && req.cookies.sid;
  if (!token) return res.status(401).json({ error: 'not_logged_in' });
  const row = db.prepare('SELECT m.* FROM sessions s JOIN merchants m ON m.id = s.merchant_id WHERE s.token = ?').get(token);
  if (!row) return res.status(401).json({ error: 'not_logged_in' });
  req.merchant = row;
  next();
}

// Webhook needs the RAW body for signature check — register before express.json().
app.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured' });
    const signature = req.headers['x-paystack-signature'] || '';
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
    if (signature !== expected) return res.status(401).json({ error: 'bad_signature' });
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'charge.success' && event.data && event.data.reference) {
      const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(event.data.reference);
      if (payment && payment.status !== 'paid' && payment.status !== 'refunded') {
        try {
          const data = await paystackVerify(event.data.reference);
          // Any successful charge is money that left the customer: record it as
          // paid (even on amount mismatch) so the merchant can see/refund it.
          if (data.status === 'success') {
            markPaid(payment, data);
            if (typeof data.amount === 'number' && data.amount !== payment.amount_kobo) {
              // Keep what the customer actually paid in amount_kobo and the
              // link amount in expected_kobo so the dashboard shows both
              // (paid vs asked-for) instead of a normal paid row.
              db.prepare('UPDATE payments SET amount_kobo = ?, expected_kobo = COALESCE(expected_kobo, ?) WHERE id = ?').run(data.amount, payment.amount_kobo, payment.id);
            } else if (payment.expected_kobo == null) {
              db.prepare('UPDATE payments SET expected_kobo = amount_kobo WHERE id = ?').run(payment.id);
            }
          }
        } catch (e) { /* leave pending; client-side verify will retry */ }
      }
    }
    res.json({ received: true });
  } catch (e) {
    res.status(400).json({ error: 'bad_webhook' });
  }
});

app.use(express.json());
app.use(cookieParser());

// --- auth ---
app.post('/api/auth/signup', rateLimit('signup'), (req, res) => {
  const { businessName, email, password } = req.body || {};
  if (!businessName || !businessName.trim()) return res.status(400).json({ error: 'business_name_required' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid_email_required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'password_min_6' });
  const exists = db.prepare('SELECT 1 FROM merchants WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'email_taken' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO merchants (business_name, email, password_hash) VALUES (?, ?, ?)').run(
    businessName.trim(), email.toLowerCase(), hash
  );
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, merchant_id) VALUES (?, ?)').run(token, info.lastInsertRowid);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/auth/login', rateLimit('login'), loginEmailLimit, (req, res) => {
  const { email, password } = req.body || {};
  const m = db.prepare('SELECT * FROM merchants WHERE email = ?').get((email || '').toLowerCase());
  if (!m || !bcrypt.compareSync(password || '', m.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, merchant_id) VALUES (?, ?)').run(token, m.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    id: req.merchant.id,
    businessName: req.merchant.business_name,
    email: req.merchant.email,
    paystackConfigured: Boolean(PAYSTACK_PUBLIC && PAYSTACK_SECRET),
  });
});

// --- merchant: links ---
app.post('/api/links', auth, (req, res) => {
  const { amountNaira, title, description } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title_required', message: 'Enter what the payment is for.' });
  const n = Number(amountNaira);
  if (!Number.isFinite(n) || n <= 0) {
    return res.status(400).json({ error: 'amount_must_be_positive', message: 'Amount must be more than ₦0. Enter an amount above zero.' });
  }
  if (n > 10000000) {
    return res.status(400).json({ error: 'amount_too_large', message: 'Amount is above the ₦10,000,000 limit. Enter ₦10,000,000 or less, or split it into smaller links.' });
  }
  const amountKobo = Math.round(n * 100);
  const code = newCode();
  const info = db.prepare(
    'INSERT INTO links (merchant_id, code, title, description, amount_kobo) VALUES (?, ?, ?, ?, ?)'
  ).run(req.merchant.id, code, String(title).trim(), String(description || '').trim(), amountKobo);
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ...link, url: `${APP_BASE}/pay/${link.code}`, amountNaira: naira(link.amount_kobo) });
});

app.get('/api/links', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM links WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id);
  res.json(rows.map((l) => ({ ...l, url: `${APP_BASE}/pay/${l.code}`, amountNaira: naira(l.amount_kobo) })));
});

// --- merchant: payments + refund ---
app.get('/api/payments', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT p.*, l.title AS link_title, l.amount_kobo AS link_amount_kobo FROM payments p JOIN links l ON l.id = p.link_id
     WHERE p.merchant_id = ? ORDER BY p.id DESC LIMIT 200`
  ).all(req.merchant.id);
  const now = Date.now();
  res.json(rows.map((p) => {
    const expected = p.expected_kobo != null ? p.expected_kobo : (p.link_amount_kobo != null ? p.link_amount_kobo : p.amount_kobo);
    const mismatch = p.status === 'paid' && p.amount_kobo !== expected;
    let waitingSecs = null;
    let waitingLabel = null;
    let nextStep = null;
    if (p.status === 'pending') {
      const created = Date.parse((p.created_at || '').replace(' ', 'T') + 'Z');
      waitingSecs = Number.isFinite(created) ? Math.max(0, Math.round((now - created) / 1000)) : null;
      waitingLabel = waitingSecs == null ? 'waiting — time unknown'
        : waitingSecs < 60 ? `waiting ${waitingSecs}s`
        : `waiting ${Math.floor(waitingSecs / 60)}m ${waitingSecs % 60}s`;
      nextStep = waitingSecs != null && waitingSecs >= 300
        ? 'Pending 5+ min: ask the customer to tap Pay / refresh so verify runs again, then check the Paystack dashboard for this reference. Only refund/close when Paystack says failed or abandoned.'
        : 'Still within normal bank-transfer/USSD window: wait, then ask the customer to refresh or tap Pay again (pending row is reused). Do not create a duplicate.';
    } else if (mismatch) {
      nextStep = p.amount_kobo < expected
        ? `Underpaid by ₦${naira(expected - p.amount_kobo)}: collect the balance or refund in full and ask for a fresh payment.`
        : `Overpaid by ₦${naira(p.amount_kobo - expected)}: refund the difference (full refund via Paystack, settle outside) or refund in full.`;
    }
    return {
      ...p,
      expected_kobo: expected,
      expectedNaira: naira(expected),
      amountNaira: naira(p.amount_kobo),
      amount_mismatch: mismatch,
      underpaid: mismatch && p.amount_kobo < expected,
      overpaid: mismatch && p.amount_kobo > expected,
      waiting_secs: waitingSecs,
      waiting_label: waitingLabel,
      next_step: nextStep,
    };
  }));
});

app.post('/api/payments/:id/refund', auth, async (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ? AND merchant_id = ?').get(req.params.id, req.merchant.id);
  if (!p) return res.status(404).json({ error: 'payment_not_found', message: 'Payment not found.' });
  if (p.status !== 'paid') return res.status(400).json({ error: 'only_paid_can_refund', status: p.status, retryable: false, message: `Only paid payments can be refunded. This payment is "${p.status}".` });
  if (!p.paystack_id) return res.status(400).json({ error: 'no_paystack_transaction', status: p.status, retryable: false, message: 'No Paystack transaction is stored for this payment, so it cannot be refunded from here. Check the Paystack dashboard.' });
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured', status: p.status, retryable: true, message: 'Paystack keys are not set on the server. Add them to .env, then try the refund again.' });
  try {
    const r = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: paystackHeaders(),
      body: JSON.stringify({ transaction: p.paystack_id }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.status) {
      // Paystack refused or errored: money did NOT move. Keep the row paid
      // so the merchant can safely try again — never mark refunded here.
      return res.status(502).json({
        error: 'refund_not_completed',
        status: 'paid',
        retryable: true,
        message: 'The refund could not reach Paystack, so the payment is still paid and no money moved. Check your connection / Paystack dashboard, then press Refund again.',
        detail: body.message || 'paystack_refund_failed',
      });
    }
    const status = body.data && body.data.status === 'pending' ? 'refund_pending' : 'refunded';
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, p.id);
    res.json({
      ok: true,
      status,
      message: status === 'refunded'
        ? 'Refund completed on Paystack.'
        : 'Refund is queued on Paystack and will complete shortly — check the Paystack dashboard if it stays pending.',
    });
  } catch (e) {
    // Network/timeout reaching Paystack: keep paid, tell the merchant plainly
    // to try again. No state change, so a retry is always safe.
    res.status(502).json({
      error: 'refund_not_completed',
      status: 'paid',
      retryable: true,
      message: 'The refund could not reach Paystack (network error), so the payment is still paid and no money moved. Try the refund again.',
    });
  }
});

// --- public: pay flow ---
app.get('/api/pay/:code', (req, res) => {
  const link = db.prepare(
    'SELECT l.*, m.business_name FROM links l JOIN merchants m ON m.id = l.merchant_id WHERE l.code = ?'
  ).get(req.params.code);
  if (!link) return res.status(404).json({ error: 'link_not_found' });
  res.json({
    title: link.title,
    description: link.description,
    amountKobo: link.amount_kobo,
    amountNaira: naira(link.amount_kobo),
    businessName: link.business_name,
  });
});

app.post('/api/pay/:code/initiate', rateLimit('initiate'), (req, res) => {
  if (!PAYSTACK_PUBLIC || !PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured' });
  const link = db.prepare('SELECT * FROM links WHERE code = ?').get(req.params.code);
  if (!link) return res.status(404).json({ error: 'link_not_found' });
  const email = String((req.body || {}).email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid_email_required' });
  const emailNorm = email.toLowerCase();
  // Repeat-pay rule (PRD §4.3.1): a second tap for the same link + email while a
  // payment is still pending reuses that pending row instead of creating a new one,
  // so the dashboard shows one clear payment and the customer is not charged twice.
  const existing = db.prepare(
    `SELECT * FROM payments WHERE link_id = ? AND customer_email = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`
  ).get(link.id, emailNorm);
  if (existing) {
    return res.json({ publicKey: PAYSTACK_PUBLIC, reference: existing.reference, amountKobo: link.amount_kobo, email: emailNorm, reused: true });
  }
  const reference = newReference();
  db.prepare(
    'INSERT INTO payments (link_id, merchant_id, reference, amount_kobo, expected_kobo, customer_email) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(link.id, link.merchant_id, reference, link.amount_kobo, link.amount_kobo, emailNorm);
  res.json({ publicKey: PAYSTACK_PUBLIC, reference, amountKobo: link.amount_kobo, email: emailNorm, reused: false });
});

// Customer closed the Paystack popup without paying: close out the pending row
// as abandoned so a later tap starts a fresh payment instead of piling up
// pending rows. Only the pending row for this reference is touched.
app.post('/api/pay/:code/abandon', (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference_required' });
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) return res.status(404).json({ error: 'payment_not_found' });
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(payment.link_id);
  if (!link || link.code !== req.params.code) return res.status(400).json({ error: 'reference_mismatch' });
  if (payment.status === 'pending') {
    db.prepare(`UPDATE payments SET status = 'abandoned' WHERE id = ?`).run(payment.id);
  }
  res.json({ ok: true, status: payment.status === 'pending' ? 'abandoned' : payment.status });
});

app.post('/api/pay/:code/verify', rateLimit('verify'), async (req, res) => {
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured' });
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference_required' });
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) return res.status(404).json({ error: 'payment_not_found' });
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(payment.link_id);
  // Cross-link reference guard (PRD §4.3.5): a reference belongs to the link that
  // created it. Verifying it under a different link code is rejected with a clear
  // message so the customer retries on the correct pay page instead of getting stuck.
  if (!link || link.code !== req.params.code) return res.status(400).json({ error: 'reference_mismatch', message: 'This payment reference belongs to a different payment link. Please go back to the correct link and try again.' });
  if (payment.status === 'paid') return res.json({ ok: true, status: 'paid' });
  try {
    const data = await paystackVerify(reference);
    if (data.status === 'success') {
      // Money left the customer's account, even if the amount is wrong.
      // Record it as paid so the merchant sees it on the dashboard and can refund it.
      // Never tell the customer they were not charged in this branch.
      const paid = markPaid(payment, data);
      if (data.amount === (payment.expected_kobo != null ? payment.expected_kobo : payment.amount_kobo)) {
        if (payment.expected_kobo == null) {
          db.prepare('UPDATE payments SET expected_kobo = amount_kobo WHERE id = ?').run(payment.id);
        }
        return res.json({ ok: true, status: 'paid' });
      }
      if (typeof data.amount === 'number' && data.amount !== payment.amount_kobo) {
        db.prepare('UPDATE payments SET amount_kobo = ?, expected_kobo = COALESCE(expected_kobo, ?) WHERE id = ?').run(data.amount, payment.amount_kobo, payment.id);
      }
      const { expected, paid: paidKobo, diff } = mismatchInfo(payment, data.amount);
      const expectedNaira = naira(expected);
      const paidNaira = naira(paidKobo);
      const action = diff < 0
        ? `Please collect the remaining ₦${naira(-diff)} from the customer, or refund this payment and ask them to pay the full amount again.`
        : `Please refund the extra ₦${naira(diff)} to the customer.`;
      return res.json({
        ok: true,
        status: 'paid',
        amount_mismatch: true,
        underpaid: diff < 0,
        overpaid: diff > 0,
        reference: payment.reference,
        paid_kobo: paidKobo,
        paid_naira: paidNaira,
        expected_kobo: expected,
        expected_naira: expectedNaira,
        difference_kobo: diff,
        merchant_action: action,
        message: `You paid ₦${paidNaira} but this link asked for ₦${expectedNaira}. Your payment was received — it is flagged on the merchant dashboard as paid ₦${paidNaira} / asked ₦${expectedNaira}, and the merchant will contact you to ${diff < 0 ? 'collect the balance' : 'refund the difference'}. Please do not pay again.`,
      });
    }
    // Still moving (bank transfer / USSD / queued): keep the row pending and
    // tell the customer exactly how long to wait — never report this as failed.
    if (PROCESSING_STATUSES.has(data.status)) {
      return res.json({
        ok: true,
        status: 'pending',
        waiting: true,
        retry_after_secs: VERIFY_RETRY_WAIT_SECS,
        reference: payment.reference,
        gateway_status: data.status,
        message: `Your payment is still processing (e.g. bank transfer or USSD can take a few minutes). Please wait ${VERIFY_RETRY_WAIT_SECS} seconds and do not tap Pay again yet — this page will confirm automatically, or tap Verify / refresh after the wait.`,
      });
    }
    // Only abandoned or failed closes the payment. Anything else unknown
    // stays pending so a late success can still land via verify/webhook.
    if (!CLOSED_STATUSES.has(data.status)) {
      return res.json({
        ok: true,
        status: 'pending',
        waiting: true,
        retry_after_secs: VERIFY_RETRY_WAIT_SECS,
        reference: payment.reference,
        gateway_status: data.status,
        message: `Your payment is still processing. Please wait ${VERIFY_RETRY_WAIT_SECS} seconds, then refresh or tap Pay again (your pending payment will be reused) — do not start a new payment elsewhere.`,
      });
    }
    // Paystack confirms the charge did NOT succeed: mark failed so the
    // customer can start a fresh payment (initiate only reuses pending rows).
    if (payment.status === 'pending') {
      db.prepare(`UPDATE payments SET status = 'failed' WHERE id = ?`).run(payment.id);
    }
    return res.json({
      ok: false,
      status: 'failed',
      retryable: true,
      fresh: true,
      reference: payment.reference,
      message: 'This payment failed and you were not charged for it. Tap Pay again to start a fresh payment.',
    });
  } catch (e) {
    // Webhook-wait timing rule (PRD §4.3.4): when Paystack cannot be verified right
    // now the payment stays pending and both sides get an exact wait in seconds,
    // then tap Pay / refresh — the pending row is reused so no duplicate is created.
    return res.status(502).json({
      error: 'verify_failed',
      status: 'pending',
      retryable: true,
      waiting: true,
      retry_after_secs: VERIFY_RETRY_WAIT_SECS,
      reference: payment.reference,
      message: `We could not confirm your payment yet. Please wait ${VERIFY_RETRY_WAIT_SECS} seconds, then tap Pay again (your pending payment will be reused) or refresh this page.`,
    });
  }
});

// --- pages ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('/pay/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pay.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => console.log(`Merchant payments live on ${APP_BASE}`));
