import dns from 'node:dns';
import { decrypt } from './crypto.js';
import { domainOf } from './model.js';

const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(['8.8.8.8', '1.1.1.1']);

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

const ROLE = new Set([
  'info', 'contact', 'hello', 'hi', 'sales', 'support', 'help', 'admin', 'office', 'team', 'service', 'services',
  'customerservice', 'billing', 'accounts', 'accounting', 'marketing', 'jobs', 'careers', 'hr', 'noreply', 'no-reply',
  'donotreply', 'webmaster', 'postmaster', 'abuse', 'mail', 'email', 'inquiries', 'inquiry', 'enquiries', 'frontdesk',
  'reception', 'booking', 'bookings', 'appointments', 'orders', 'press', 'media', 'privacy', 'legal', 'general',
]);

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com',
  'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'burnermail.io',
]);

export function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase().replace(/^mailto:/, '');
}

export function syntaxOk(email) {
  return email.length <= 254 && EMAIL_RE.test(email) && !email.includes('..');
}

export function isRole(email) {
  return ROLE.has(email.split('@')[0]);
}

export function isDisposable(email) {
  return DISPOSABLE.has(domainOf(email));
}

const mxCache = new Map();
export async function hasMx(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try {
    const recs = await resolver.resolveMx(domain);
    ok = recs.some((r) => r.exchange && r.exchange !== '.' && r.exchange !== '');
  } catch (e) {
    if (!['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ENOTIMP', 'EREFUSED'].includes(e.code)) {
      // Network trouble: try Google DNS over HTTPS before failing.
      try {
        const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        ok = (j.Answer || []).some((a) => a.type === 15 && !/\s\.$/.test(a.data));
      } catch {
        ok = false;
      }
    }
  }
  mxCache.set(domain, ok);
  return ok;
}

// Calls the configured verification service. Returns { verdict: 'valid'|'invalid'|'risky'|'error', detail }
export async function providerCheck(settings, email) {
  const provider = settings.verifier.provider;
  const key = decrypt(settings.verifier.apiKeyEnc);
  if (!key) return { verdict: 'error', detail: 'No verification API key saved in Settings' };
  try {
    if (provider === 'millionverifier') {
      const u = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=20`;
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (j.error) return { verdict: 'error', detail: `MillionVerifier: ${j.error}` };
      const res = String(j.result || '').toLowerCase();
      if (res === 'ok') return { verdict: 'valid', detail: 'ok', raw: { result: j.result, subresult: j.subresult, credits: j.credits } };
      if (res === 'invalid' || res === 'disposable') return { verdict: 'invalid', detail: res, raw: { result: j.result, subresult: j.subresult } };
      return { verdict: 'risky', detail: res || 'unknown', raw: { result: j.result, subresult: j.subresult } };
    }
    if (provider === 'zerobounce') {
      const u = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&ip_address=&timeout=30`;
      const r = await fetch(u, { signal: AbortSignal.timeout(40000) });
      const j = await r.json();
      if (j.error) return { verdict: 'error', detail: `ZeroBounce: ${j.error}` };
      const st = String(j.status || '').toLowerCase();
      if (st === 'valid') return { verdict: 'valid', detail: 'valid', raw: { status: j.status, sub_status: j.sub_status } };
      if (['invalid', 'spamtrap', 'abuse', 'do_not_mail'].includes(st)) return { verdict: 'invalid', detail: `${st}${j.sub_status ? ` (${j.sub_status})` : ''}`, raw: { status: j.status, sub_status: j.sub_status } };
      return { verdict: 'risky', detail: st || 'unknown', raw: { status: j.status, sub_status: j.sub_status } };
    }
    return { verdict: 'error', detail: `Unknown provider ${provider}` };
  } catch (e) {
    return { verdict: 'error', detail: `Verification service unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})` };
  }
}

export async function providerCredits(settings) {
  const key = decrypt(settings.verifier.apiKeyEnc);
  if (!key) return null;
  if (settings.verifier.provider === 'millionverifier') {
    const r = await fetch(`https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j.error) throw new Error(`MillionVerifier: ${j.error}`);
    return Number(j.credits || 0) + Number(j.bulk_credits || 0);
  }
  if (settings.verifier.provider === 'zerobounce') {
    const r = await fetch(`https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const n = Number(j.Credits);
    if (n < 0) throw new Error('ZeroBounce rejected the API key');
    return n;
  }
  return null;
}

// Full gate. Every check must pass for an email to count as verified.
export async function verifyEmail(settings, rawEmail) {
  const email = normalizeEmail(rawEmail);
  const checkedAt = Date.now();
  const fail = (reason, stage) => ({ ok: false, email, status: stage === 'error' ? 'error' : 'rejected', reason, checkedAt });
  if (!syntaxOk(email)) return fail('Not a valid email format', 'syntax');
  if (isDisposable(email)) return fail('Disposable address', 'disposable');
  if (!settings.allowRoleEmails && isRole(email)) return fail('Generic inbox (info@, contact@...) - turn on in Settings to allow', 'role');
  const domain = domainOf(email);
  if (!(await hasMx(domain))) return fail(`${domain} has no mail server`, 'mx');
  const p = await providerCheck(settings, email);
  if (p.verdict === 'valid') {
    return { ok: true, email, status: 'valid', reason: `Mailbox confirmed (${settings.verifier.provider})`, checkedAt, provider: settings.verifier.provider, raw: p.raw };
  }
  if (p.verdict === 'error') return fail(p.detail, 'error');
  if (p.verdict === 'risky') return fail(p.detail === 'catch_all' || p.detail === 'catch-all' ? 'Catch-all domain, mailbox cannot be confirmed' : `Could not confirm mailbox (${p.detail})`, 'risky');
  return fail(`Mailbox does not exist (${p.detail})`, 'invalid');
}
