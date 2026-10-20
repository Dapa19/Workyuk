import crypto from 'node:crypto';
import { get, run } from './db/database.js';
import { safeUser, now } from './utils.js';

const COOKIE = 'workyuk.sid';
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const configuredClientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
export const allowedClientOrigins = new Set([configuredClientOrigin]);
if (process.env.NODE_ENV !== 'production') {
  const configuredUrl = new URL(configuredClientOrigin);
  const localAlias = configuredUrl.hostname === 'localhost'
    ? '127.0.0.1'
    : configuredUrl.hostname === '127.0.0.1' ? 'localhost' : null;
  if (localAlias) {
    configuredUrl.hostname = localAlias;
    allowedClientOrigins.add(configuredUrl.origin);
  }
}

const sign = (sid) => crypto.createHmac('sha256', secret).update(sid).digest('base64url');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function cookieValue(req) {
  const raw = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return raw ? decodeURIComponent(raw.slice(COOKIE.length + 1)) : '';
}
function validSessionCookie(value) {
  const [sid, signature] = value.split('.');
  if (!sid || !signature) return null;
  const expected = Buffer.from(sign(sid));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? sid : null;
}
function setCookie(res, sid) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_MS / 1000)}`];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(`${sid}.${sign(sid)}`)}; ${flags.join('; ')}`);
}
export function clearSessionCookie(res) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=; ${flags.join('; ')}`);
}

export async function createSession(res, userId) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_MS;
  await run('INSERT INTO sessions(sid_hash, user_id, expires_at, created_at) VALUES(?, ?, ?, ?)',
    [hash(sid), userId, expires, now()]);
  setCookie(res, sid);
  return sid;
}

export async function destroySession(req, res) {
  const sid = validSessionCookie(cookieValue(req));
  if (sid) await run('DELETE FROM sessions WHERE sid_hash = ?', [hash(sid)]);
  clearSessionCookie(res);
}

export async function requireAuth(req, res, next) {
  try {
    const sid = validSessionCookie(cookieValue(req));
    if (!sid) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Silakan masuk kembali.' } });
    const row = await get(`SELECT s.sid_hash, s.expires_at, u.*, c.id AS client_id
      FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN clients c ON c.user_id=u.id
      WHERE s.sid_hash=?`, [hash(sid)]);
    if (!row || row.expires_at <= Date.now() || !row.is_active) {
      if (row) await run('DELETE FROM sessions WHERE sid_hash=?', [row.sid_hash]);
      clearSessionCookie(res);
      return res.status(401).json({ error: { code: 'SESSION_EXPIRED', message: 'Sesi berakhir. Silakan masuk kembali.' } });
    }
    req.user = safeUser(row);
    req.sessionSid = sid;
    next();
  } catch (error) { next(error); }
}

export function requireRole(...roles) {
  return (req, res, next) => req.user && roles.includes(req.user.role)
    ? next()
    : res.status(req.user ? 403 : 401).json({ error: { code: req.user ? 'FORBIDDEN' : 'UNAUTHENTICATED', message: 'Akses tidak diizinkan.' } });
}

export function requirePasswordReady(req, res, next) {
  if (req.user?.mustChangePassword) {
    return res.status(403).json({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Ganti password awal sebelum melanjutkan.' } });
  }
  next();
}

export function checkSameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !allowedClientOrigins.has(origin)) return res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Asal permintaan tidak diizinkan.' } });
  next();
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function projectVisible(project, user) {
  return user.role === 'agency' || Number(project.client_id) === Number(user.clientId);
}
