import { isAuthed, origin, cookie, parseCookies, json, error } from '../lib/http.js';
import { sign, unsign, randomId } from '../lib/crypto.js';
import { loadDb } from '../lib/db.js';
import { authUrl, exchangeCode, profileWithToken, saveConnection, disconnect } from '../lib/gmail.js';

const ALLOWED = (process.env.ALLOWED_GMAIL || '').toLowerCase();

function back(request, msg, ok) {
  const u = new URL('/', origin(request));
  u.hash = `settings?gmail=${ok ? 'ok' : 'error'}&msg=${encodeURIComponent(msg)}`;
  return new Response(null, { status: 302, headers: { location: u.toString(), 'set-cookie': cookie('ao_oauth', '', { maxAge: 0 }) } });
}

// GET /api/google            -> starts sign-in
// GET /api/google?code=...   -> Google redirects back here
export async function GET(request) {
  if (!isAuthed(request)) return new Response(null, { status: 302, headers: { location: '/' } });
  const url = new URL(request.url);
  const redirectUri = `${origin(request)}/api/google`;
  const { db } = await loadDb();
  const s = db.settings;

  if (url.searchParams.get('error')) return back(request, `Google: ${url.searchParams.get('error')}`, false);

  const code = url.searchParams.get('code');
  if (!code) {
    if (!s.google.clientId || !s.google.clientSecretEnc) return back(request, 'Save your Google client ID and secret first.', false);
    const state = randomId(18);
    return new Response(null, {
      status: 302,
      headers: { location: authUrl(s, redirectUri, state), 'set-cookie': cookie('ao_oauth', sign(state), { maxAge: 600 }) },
    });
  }

  const expected = unsign(parseCookies(request).ao_oauth);
  if (!expected || expected !== url.searchParams.get('state')) return back(request, 'Sign-in expired or was tampered with. Try again.', false);
  try {
    const tokens = await exchangeCode(s, code, redirectUri);
    const granted = String(tokens.scope || '');
    if (!granted.includes('gmail.send') || !granted.includes('gmail.readonly')) {
      return back(request, 'Google did not grant both Gmail permissions. Reconnect and tick both boxes.', false);
    }
    const prof = await profileWithToken(tokens.access_token);
    const email = String(prof.emailAddress || '').toLowerCase();
    if (ALLOWED && email !== ALLOWED) return back(request, `Signed in as ${email}, but this app only sends from ${ALLOWED}.`, false);
    if (!tokens.refresh_token) return back(request, 'Google did not return a long-lived token. Remove the app at myaccount.google.com/permissions and connect again.', false);
    await saveConnection(tokens, email);
    return back(request, `Connected ${email}`, true);
  } catch (e) {
    return back(request, e.message, false);
  }
}

export async function DELETE(request) {
  if (!isAuthed(request)) return error('Not signed in', 401);
  await disconnect();
  return json({ ok: true });
}
