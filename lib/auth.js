'use strict';
// Accounts: scrypt-hashed passwords and a signed session cookie (no session storage needed).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'tp_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,15}$/;
const MIN_PASSWORD = 4;

let secret;
function getSecret() {
  if (secret) return secret;
  if (process.env.SESSION_SECRET) return (secret = process.env.SESSION_SECRET);
  if (process.env.VERCEL) throw new Error('SESSION_SECRET is not set. Add it in the Vercel project settings.');
  // local use: make one once and keep it so logins survive restarts
  const file = path.join(__dirname, '..', 'data', 'secret.txt');
  try { secret = fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* none yet */ }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret);
  }
  return secret;
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString();
const sign = (s) => crypto.createHmac('sha256', getSecret()).update(s).digest('base64url');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}

function checkPassword(password, rec) {
  return safeEqual(hashPassword(password, rec.salt).hash, rec.hash);
}

function makeSession(uid) {
  const body = `${b64(uid)}.${Date.now() + SESSION_MS}`;
  return `${body}.${sign(body)}`;
}

// returns the account id, or null if the cookie is missing, forged or expired
function readSession(cookieHeader) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader || '');
  if (!m) return null;
  const [id, exp, sig] = m[1].split('.');
  if (!id || !exp || !sig || !safeEqual(sig, sign(`${id}.${exp}`)) || Number(exp) < Date.now()) return null;
  return unb64(id);
}

function sessionCookie(value, secure) {
  const maxAge = value ? Math.floor(SESSION_MS / 1000) : 0;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

module.exports = { NAME_RE, MIN_PASSWORD, hashPassword, checkPassword, makeSession, readSession, sessionCookie };
