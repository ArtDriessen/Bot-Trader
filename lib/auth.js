const crypto = require('crypto');
const { promisify } = require('util');
const store = require('./store');

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 16384, r: 8, p: 1 };
const SESSION_MS = 14 * 24 * 3600 * 1000;
const COOKIE = 'sid';

// ---------- Senhas (scrypt com salt) ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, PARAMS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'hex');
  const actual = await scrypt(pw, Buffer.from(s, 'hex'), expected.length, PARAMS);
  return crypto.timingSafeEqual(actual, expected);
}

// Hash falso para gastar o mesmo tempo quando o e-mail não existe (evita descobrir e-mails cadastrados)
const DUMMY_HASH = hashPassword('senha-falsa-para-igualar-tempo');
const burnTime = async (pw) => verifyPassword(pw, await DUMMY_HASH);

// ---------- Sessões (cookie httpOnly; só o hash do token fica salvo) ----------
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function cookiesOf(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie malformado */
    }
  }
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const sessions = store.load('sessions.json', []).filter((s) => s.expiresAt > now);
  sessions.push({ id: sha(token), userId, expiresAt: now + SESSION_MS });
  store.save('sessions.json', sessions);
  return token;
}

function startSession(req, res, userId) {
  const token = createSession(userId);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: SESSION_MS, path: '/' });
}

function endSession(req, res) {
  const token = cookiesOf(req)[COOKIE];
  if (token) store.save('sessions.json', store.load('sessions.json', []).filter((s) => s.id !== sha(token)));
  res.clearCookie(COOKIE, { path: '/' });
}

function endUserSessions(userId) {
  store.save('sessions.json', store.load('sessions.json', []).filter((s) => s.userId !== userId));
}

function userFromRequest(req) {
  const token = cookiesOf(req)[COOKIE];
  if (!token) return null;
  const id = sha(token);
  const s = store.load('sessions.json', []).find((x) => x.id === id && x.expiresAt > Date.now());
  if (!s) return null;
  const u = store.load('users.json', []).find((x) => x.id === s.userId);
  return u && !u.blocked ? u : null;
}

// ---------- Limite de tentativas (em memória) ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let e = hits.get(key);
  if (!e || e.reset < now) {
    e = { n: 0, reset: now + windowMs };
    hits.set(key, e);
  }
  e.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  return e.n > max;
}

module.exports = {
  hashPassword, verifyPassword, burnTime,
  startSession, endSession, endUserSessions, userFromRequest, limited,
};
