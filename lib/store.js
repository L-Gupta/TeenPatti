'use strict';
// Storage behind one small interface, with two backends:
//   - Upstash Redis over its REST API (what you use on Vercel; plain fetch, no dependency)
//   - a JSON file + in-process mutex (what you use on your own computer)
//
//   read(touch?)        -> { table, seen }   the game snapshot and who checked in recently
//   writeTable(obj)
//   getUsers()/setUsers(obj)
//   withLock(fn)        run fn with exclusive access (every write goes through this)
// `touch` = { uid, ts } records a heartbeat in the same round trip.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = { table: 'tp:table', users: 'tp:users', seen: 'tp:seen', lock: 'tp:lock' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ---------- Redis (Upstash REST) ----------

const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function redisStore(url, token) {
  async function pipe(cmds) {
    const res = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) throw new Error(`Redis request failed (HTTP ${res.status}).`);
    return (await res.json()).map((o) => {
      if (o.error) throw new Error('Redis: ' + o.error);
      return o.result;
    });
  }
  const parse = (s) => (s ? JSON.parse(s) : null);
  const toMap = (flat) => {
    const m = {};
    for (let i = 0; i < (flat || []).length; i += 2) m[flat[i]] = Number(flat[i + 1]);
    return m;
  };

  return {
    async read(touch) {
      const cmds = [];
      if (touch) cmds.push(['HSET', KEY.seen, touch.uid, String(touch.ts)]);
      cmds.push(['GET', KEY.table], ['HGETALL', KEY.seen]);
      const r = await pipe(cmds);
      if (touch) r.shift();
      return { table: parse(r[0]), seen: toMap(r[1]) };
    },
    async writeTable(obj) { await pipe([['SET', KEY.table, JSON.stringify(obj)]]); },
    async getUsers() { return parse((await pipe([['GET', KEY.users]]))[0]) || {}; },
    async setUsers(obj) { await pipe([['SET', KEY.users, JSON.stringify(obj)]]); },
    async withLock(fn) {
      const id = crypto.randomBytes(8).toString('hex');
      for (let tries = 0; ; tries++) {
        const [ok] = await pipe([['SET', KEY.lock, id, 'NX', 'PX', '8000']]);
        if (ok === 'OK') break;
        if (tries >= 40) throw new Error('The table is busy, try again.');
        await sleep(60 + Math.random() * 80);
      }
      try { return await fn(); } finally { await pipe([['EVAL', RELEASE, '1', KEY.lock, id]]).catch(() => {}); }
    },
  };
}

// ---------- local file ----------

function fileStore(file) {
  let db = { table: null, users: {} };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { /* first run */ }
  const seen = {}; // heartbeats only matter while the server is up, so they stay in memory
  const flush = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db));
  };
  let tail = Promise.resolve();

  return {
    async read(touch) {
      if (touch) seen[touch.uid] = touch.ts;
      return { table: clone(db.table), seen: { ...seen } };
    },
    async writeTable(obj) { db.table = clone(obj); flush(); },
    async getUsers() { return clone(db.users); },
    async setUsers(obj) { db.users = clone(obj); flush(); },
    withLock(fn) {
      const run = tail.then(() => fn());
      tail = run.catch(() => {});
      return run;
    },
  };
}

// ---------- pick one ----------

let instance;
function getStore() {
  if (instance) return instance;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) instance = redisStore(url, token);
  else if (process.env.VERCEL) throw new Error('No Redis configured: connect an Upstash Redis database to this Vercel project.');
  else instance = fileStore(path.join(__dirname, '..', 'data', 'db.json'));
  return instance;
}

module.exports = { getStore, redisStore, fileStore };
