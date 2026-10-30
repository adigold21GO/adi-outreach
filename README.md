# Adi Outreach

A personal outreach dialer: verified leads, calling, Gmail sending from adigold21@gmail.com, and a pipeline that fills itself in from your activity.

## How it works
- **Front end:** `public/` (plain HTML/CSS/JS, no build step).
- **API:** `api/` (Vercel functions). Data lives in a private Vercel Blob store, written with conflict-safe updates.
- **Gmail:** Google OAuth (`gmail.send` + `gmail.readonly`). Sends go out as plain-text emails from your account; replies, bounces and unsubscribes are detected from your inbox.
- **Verification gate:** every lead is checked for format, a real mail server (MX), not a generic or disposable inbox, a confirmed mailbox via MillionVerifier or ZeroBounce, and against the exclusion list (email, domain, phone, business name) before it is added.
- **Daily job:** around 9 a.m. Central, checks the inbox and (if Autopilot is on) sends due follow-ups and first emails within your daily limit.

## Environment variables (Vercel → Project → Settings → Environment Variables)
| Name | Set by | Purpose |
|---|---|---|
| `APP_PASSCODE` | you | Passcode to open the app (6+ characters) |
| `APP_SECRET` | Claude | Signs logins and encrypts stored keys |
| `CRON_SECRET` | Claude | Lets only Vercel's scheduler run the daily job |
| `ALLOWED_GMAIL` | Claude | Only this Gmail account can be connected |
| `BLOB_READ_WRITE_TOKEN` | Vercel (when the Blob store is connected) | Storage |

Google client ID/secret and the verifier API key are entered in the app's Settings page and stored encrypted.
