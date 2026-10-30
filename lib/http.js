import { sign, unsign, safeEqual } from './crypto.js';

const SESSION_COOKIE = 'ao_s';
const SESSION_DAYS = 30;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function error(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  return c;
}

export function sessionCookie() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return cookie(SESSION_COOKIE, sign(`s:${exp}`), { maxAge: SESSION_DAYS * 86400 });
}

export function clearSessionCookie() {
  return cookie(SESSION_COOKIE, '', { maxAge: 0 });
}

export function isAuthed(request) {
  try {
    const v = unsign(parseCookies(request)[SESSION_COOKIE]);
    if (!v || !v.startsWith('s:')) return false;
    return Number(v.slice(2)) > Date.now();
  } catch {
    return false;
  }
}

export function checkPasscode(input) {
  const pass = process.env.APP_PASSCODE;
  if (!pass || pass.length < 6) return false;
  return safeEqual(input || '', pass);
}

export function isCron(request) {
  const s = process.env.CRON_SECRET;
  if (!s) return false;
  return safeEqual(request.headers.get('authorization') || '', `Bearer ${s}`);
}

// Wraps a handler: requires a valid session, catches errors as JSON.
export function guarded(fn) {
  return async (request) => {
    if (!isAuthed(request)) return error('Not signed in', 401);
    try {
      return await fn(request);
    } catch (e) {
      console.error(e);
      return error(e.publicMessage || e.message || 'Server error', e.status || 500);
    }
  };
}

export function origin(request) {
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || u.host;
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}

export async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.publicMessage = message;
    this.status = status;
  }
}
