import { decrypt, encrypt } from './crypto.js';
import { loadAuth, mutateAuth } from './db.js';
import { HttpError } from './http.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
let cached = { token: null, exp: 0, refreshEnc: null };

export function authUrl(settings, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: settings.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(settings, code, redirectUri) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.google.clientId,
      client_secret: decrypt(settings.google.clientSecretEnc) || '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || r.status}`);
  return j;
}

async function accessToken(settings) {
  const { auth } = await loadAuth();
  if (!auth || !auth.refreshEnc || auth.broken) throw new HttpError('Gmail is not connected. Connect it in Settings.', 409);
  if (cached.token && cached.exp > Date.now() + 60000 && cached.refreshEnc === auth.refreshEnc) return { token: cached.token, auth };
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.google.clientId,
      client_secret: decrypt(settings.google.clientSecretEnc) || '',
      refresh_token: decrypt(auth.refreshEnc),
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    if (j.error === 'invalid_grant') {
      await mutateAuth((a) => ({ ...a, broken: true, brokenAt: Date.now() }));
      throw new HttpError('Google signed this app out (this happens every 7 days while the Google app is in Testing). Reconnect Gmail in Settings.', 409);
    }
    throw new HttpError(`Google token error: ${j.error_description || j.error}`, 502);
  }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, refreshEnc: auth.refreshEnc };
  return { token: j.access_token, auth };
}

async function gfetch(settings, path, init = {}) {
  const { token, auth } = await accessToken(settings);
  const r = await fetch(`${G}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const msg = j.error?.message || `Gmail error ${r.status}`;
    throw new HttpError(`Gmail: ${msg}`, r.status === 429 ? 429 : 502);
  }
  return { data: j, auth };
}

export async function profileWithToken(accessTokenValue) {
  const r = await fetch(`${G}/profile`, { headers: { authorization: `Bearer ${accessTokenValue}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Could not read Gmail profile');
  return j; // { emailAddress, ... }
}

export async function saveConnection(tokens, email) {
  cached = { token: null, exp: 0, refreshEnc: null };
  return mutateAuth((a) => ({
    refreshEnc: tokens.refresh_token ? encrypt(tokens.refresh_token) : a.refreshEnc,
    email,
    connectedAt: Date.now(),
    broken: false,
    scope: tokens.scope,
  }));
}

export async function disconnect() {
  cached = { token: null, exp: 0, refreshEnc: null };
  return mutateAuth(() => ({ refreshEnc: null, email: null, broken: false }));
}

function encodeHeader(s) {
  // RFC 2047 for non-ASCII subjects / names.
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function wrap76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n').trim();
}

export function buildMime({ fromName, fromEmail, to, subject, text, inReplyTo, references }) {
  const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const headers = [
    `From: ${encodeHeader(clean(fromName))} <${clean(fromEmail)}>`,
    `To: ${clean(to)}`,
    `Subject: ${encodeHeader(clean(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    `List-Unsubscribe: <mailto:${clean(fromEmail)}?subject=unsubscribe>`,
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${clean(inReplyTo)}`);
  if (references) headers.push(`References: ${clean(references)}`);
  const body = wrap76(Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

export async function sendMail(settings, { to, subject, text, threadId, inReplyTo, references }) {
  const { auth } = await loadAuth();
  const fromEmail = auth?.email;
  if (!fromEmail) throw new HttpError('Gmail is not connected. Connect it in Settings.', 409);
  const raw = Buffer.from(buildMime({ fromName: settings.fromName, fromEmail, to, subject, text, inReplyTo, references })).toString('base64url');
  const payload = { raw };
  if (threadId) payload.threadId = threadId;
  const { data } = await gfetch(settings, '/messages/send', { method: 'POST', body: JSON.stringify(payload) });
  // Fetch our own Message-ID so follow-ups can thread correctly.
  let messageIdHeader = null;
  try {
    const { data: m } = await gfetch(settings, `/messages/${data.id}?format=metadata&metadataHeaders=Message-ID`);
    messageIdHeader = (m.payload?.headers || []).find((h) => h.name.toLowerCase() === 'message-id')?.value || null;
  } catch { /* non-fatal */ }
  return { id: data.id, threadId: data.threadId, messageIdHeader, from: fromEmail };
}

export async function listMessages(settings, q, max = 1000) {
  const out = [];
  let pageToken;
  do {
    const p = new URLSearchParams({ q, maxResults: '500' });
    if (pageToken) p.set('pageToken', pageToken);
    const { data } = await gfetch(settings, `/messages?${p}`);
    out.push(...(data.messages || []));
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

export async function getMeta(settings, id, headers = ['From', 'Subject', 'Date', 'Auto-Submitted', 'X-Autoreply', 'X-Failed-Recipients', 'Precedence']) {
  const p = new URLSearchParams({ format: 'metadata' });
  for (const h of headers) p.append('metadataHeaders', h);
  const { data } = await gfetch(settings, `/messages/${id}?${p}`);
  const hs = {};
  for (const h of data.payload?.headers || []) hs[h.name.toLowerCase()] = h.value;
  return { id: data.id, threadId: data.threadId, snippet: data.snippet || '', internalDate: Number(data.internalDate || 0), headers: hs, labelIds: data.labelIds || [] };
}

export async function getFull(settings, id) {
  const { data } = await gfetch(settings, `/messages/${id}?format=full`);
  return data;
}
