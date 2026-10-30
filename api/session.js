import { json, error, body, isAuthed, checkPasscode, sessionCookie, clearSessionCookie } from '../lib/http.js';

export async function GET(request) {
  return json({
    authed: isAuthed(request),
    passcodeSet: !!(process.env.APP_PASSCODE && process.env.APP_PASSCODE.length >= 6),
    secretSet: !!(process.env.APP_SECRET && process.env.APP_SECRET.length >= 32),
  });
}

export async function POST(request) {
  const { passcode } = await body(request);
  if (!checkPasscode(passcode)) {
    await new Promise((r) => setTimeout(r, 900));
    return error('Wrong passcode', 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie() });
}

export async function DELETE() {
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}
