'use strict';
// The whole backend, written against plain Node req/res so the very same code runs
// as Vercel functions (api/*.js) and inside the local server (dev-server.js).
//
//   GET  /api/auth    -> { codeRequired, user }          who am I / is a table code needed
//   POST /api/auth    -> { action: signup | login | logout, username, password, code }
//   GET  /api/state   -> the caller's view of the table  (poll this; ?hb=1 also marks you online)
//   POST /api/action  -> { type, seat?, boot? }          play; replies with the fresh view

const { Table } = require('../game');
const { getStore } = require('./store');
const auth = require('./auth');

const MAX_ACCOUNTS = 12;
const MAX_FAILS = 5;
const LOCKOUT_MS = 60 * 1000;
const ACTIONS = new Set(['join', 'leave', 'see', 'chaal', 'raise', 'pack', 'show', 'deal', 'boot', 'topup', 'reset']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  // Vercel has already parsed it into req.body; plain Node has not
  let b = req.body;
  if (b === undefined || b === null) {
    b = await new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 10000) req.destroy(); });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  }
  if (Buffer.isBuffer(b)) b = b.toString();
  if (typeof b === 'string') {
    try { b = JSON.parse(b || '{}'); } catch (e) { throw new HttpError(400, 'Bad request.'); }
  }
  return b || {};
}

// Load the table, apply one change, save it - all under the lock so two players can't overwrite each other.
function mutate(uid, change) {
  const store = getStore();
  return store.withLock(async () => {
    const now = Date.now();
    const { table: raw, seen } = await store.read({ uid, ts: now });
    seen[uid] = now;
    const t = Table.restore(raw);
    t.seen = seen;
    const ticked = t.tick();
    const err = await change(t);
    if (!err || ticked) await store.writeTable(t.snapshot());
    return { err, view: t.viewFor(uid) };
  });
}

// ---------- accounts ----------

async function authRoute(req, res, secure) {
  const store = getStore();

  if (req.method === 'GET') {
    const uid = auth.readSession(req.headers.cookie);
    const rec = uid ? (await store.getUsers())[uid] : null;
    return send(res, 200, { codeRequired: !!process.env.TABLE_CODE, user: rec ? rec.name : null });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const b = await readBody(req);
  const name = String(b.username || '').trim();
  const uid = name.toLowerCase();
  const password = String(b.password || '');

  if (b.action === 'logout') return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', secure) });

  if (b.action === 'signup') {
    if (!auth.NAME_RE.test(name)) throw new HttpError(400, 'Username: 2-16 letters, numbers, spaces, . _ -');
    if (password.length < auth.MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${auth.MIN_PASSWORD} characters.`);
    const need = process.env.TABLE_CODE;
    if (need && String(b.code || '').trim() !== need) throw new HttpError(403, 'Wrong table code.');
    await store.withLock(async () => {
      const users = await store.getUsers();
      if (users[uid]) throw new HttpError(409, 'That username is taken.');
      if (Object.keys(users).length >= MAX_ACCOUNTS) throw new HttpError(403, 'This table has no room for more accounts.');
      users[uid] = { name, ...auth.hashPassword(password) };
      await store.setUsers(users);
    });
    return send(res, 200, { ok: true, user: name }, { 'Set-Cookie': auth.sessionCookie(auth.makeSession(uid), secure) });
  }

  if (b.action === 'login') {
    const user = await store.withLock(async () => {
      const users = await store.getUsers();
      const rec = users[uid];
      const now = Date.now();
      if (rec && rec.lockedUntil > now) throw new HttpError(429, 'Too many wrong attempts. Wait a minute and try again.');
      if (!rec || !auth.checkPassword(password, rec)) {
        if (rec) {
          rec.fails = (rec.fails || 0) + 1;
          if (rec.fails >= MAX_FAILS) { rec.fails = 0; rec.lockedUntil = now + LOCKOUT_MS; }
          await store.setUsers(users);
        }
        throw new HttpError(401, 'Wrong username or password.');
      }
      if (rec.fails || rec.lockedUntil) { delete rec.fails; delete rec.lockedUntil; await store.setUsers(users); }
      return rec.name;
    });
    return send(res, 200, { ok: true, user }, { 'Set-Cookie': auth.sessionCookie(auth.makeSession(uid), secure) });
  }

  throw new HttpError(400, 'Unknown action.');
}

// ---------- the game ----------

async function stateRoute(req, res, uid) {
  const store = getStore();
  const hb = new URL(req.url, 'http://x').searchParams.get('hb') === '1';
  const now = Date.now();
  const { table: raw, seen } = await store.read(hb ? { uid, ts: now } : null);
  seen[uid] = now;
  const t = Table.restore(raw);
  t.seen = seen;
  // reading is cheap and lock-free; only take the lock when someone has to be auto-packed
  if (t.tick()) return send(res, 200, (await mutate(uid, () => null)).view);
  return send(res, 200, t.viewFor(uid));
}

async function actionRoute(req, res, uid) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = await readBody(req);
  if (!ACTIONS.has(b.type)) throw new HttpError(400, 'Unknown action.');

  const out = await mutate(uid, async (t) => {
    switch (b.type) {
      case 'join': {
        const rec = (await getStore().getUsers())[uid];
        if (!rec) throw new HttpError(401, 'Account not found - log in again.');
        return t.join(uid, b.seat, rec.name);
      }
      case 'leave': return t.leave(uid);
      case 'see': return t.see(uid);
      case 'chaal': case 'raise': case 'pack': case 'show': return t.act(uid, b.type);
      case 'deal': return t.deal(uid);
      case 'boot': return t.setBoot(uid, b.boot);
      case 'topup': return t.topup(uid);
      default: return t.resetAll(uid);
    }
  });
  send(res, 200, out.err ? { ok: false, error: out.err, view: out.view } : { ok: true, view: out.view });
}

async function handle(route, req, res) {
  try {
    if (route === 'auth') return await authRoute(req, res, req.headers['x-forwarded-proto'] === 'https');
    const uid = auth.readSession(req.headers.cookie);
    if (!uid) throw new HttpError(401, 'Log in first.');
    if (route === 'state') return await stateRoute(req, res, uid);
    if (route === 'action') return await actionRoute(req, res, uid);
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : (e.message || 'Server error.') });
  }
}

module.exports = { handle };
