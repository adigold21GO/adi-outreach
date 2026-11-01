# Ship my own outreach dialer (Ben Jones, Gainesville)

I'm Ben Jones, part of Volvera AI. I need my own copy of our outreach app: it finds and verifies Gainesville-area small-business leads, sends cold email from **benjones0821@gmail.com**, tracks calls and replies, and has zero bounces. Adi built the app for himself (Austin). The code is in the attached **outreach-app.zip**. Set up a separate copy for me: my GitHub, my Vercel, my Gmail, my data. Read this whole prompt before starting.

## Before you start, ask me these in one message
1. **Sender details.** My name as it should appear, school/role, the phone number for my signature, and a mailing address for the footer. A P.O. box works; CAN-SPAM requires one.
2. **My pitch.** What Volvera offers and one proof point. Draft a short first email and follow-up from my answer and get my approval. No corny lines. Subject format that has worked: "<Name>, UF student | Quick question about {company}". Confirm the school with me.
3. **Targets.** Which kinds of businesses (default: owner-run home services, health/dental/chiro/vet, fitness, salons, auto repair, professional services), which towns (default: Gainesville, Alachua, Newberry, High Springs, Archer, Micanopy, Ocala only if I say yes), and how many verified leads (default 300).
4. **Verifier.** I need a MillionVerifier account with credits (about $5–10 per 1,000 checks) and will paste the API key into the app's Settings myself.

## What the app is
- Plain JS front end in `public/`, Vercel functions in `api/`, data in a **private Vercel Blob** store, Gmail through Google sign-in (`gmail.send` + `gmail.readonly`).
- Every lead has to pass a verification gate before it's added: format, a real mail server (MX), not generic or disposable, mailbox confirmed by MillionVerifier (catch-alls rejected), and not already contacted (exclusion list by email, domain, phone and business name).
- The tracker fills itself from activity: sends, calls, replies and bounces are pulled from Gmail. A daily job runs around 9am Central.
- Sending is blocked until the From name, signature, mailing address and a finished template are set. Read `README.md` in the zip.
- Test: `npm install && node --experimental-test-module-mocks --test test/backend.test.mjs`. Run it before every push.

## Setup (do as much as you can; stop where noted)
1. **Code.** Unzip. Ask me to create an empty **private** GitHub repo (e.g. `ben-outreach`, no README), then push the code to it. If the push is refused because the Claude GitHub App isn't installed on my account, tell me to install it at github.com/apps/claude for that repo only.
2. **Vercel.** I import the repo at vercel.com/new and click Deploy (Framework: Other, no other changes).
   - From my open Vercel dashboard tab you can call Vercel's API with fetch() to the `/api/...` paths, with credentials included. Use it to:
     - Create a **private** Blob store named `outreach-data` with `projectId` set, then confirm `BLOB_READ_WRITE_TOKEN` is on the project.
     - Add env vars for all environments: `APP_SECRET` (random, 48+ chars), `CRON_SECRET` (random hex), `ALLOWED_GMAIL=benjones0821@gmail.com`, `APP_PASSCODE` (generate a readable one and tell me it once).
     - Redeploy.
   - Generate the secrets in your shell. Never paste them anywhere except Vercel.
3. **Google sign-in.** Use my Chrome (Claude in Chrome, in your own tab). Confirm the console shows benjones0821@gmail.com before doing anything.
   1. Create a Cloud project "Outreach" and enable the Gmail API.
   2. Google Auth Platform: app name, my email, Audience **External**, contact email.
   3. **Ask me before ticking Google's User Data Policy box.**
   4. Add benjones0821@gmail.com as a test user. Note that "Ineligible accounts not added" just means it was already added.
   5. Create a **Web application** client with redirect URI `https://<my-app>.vercel.app/api/google`.
   6. Save the client ID and secret into the app with `POST /api/data {action:'saveSettings', settings:{googleClientId, googleClientSecret}}`, run from the logged-in app tab.
   7. Open `/api/google` and let **me** click through Google's consent: choose my account, Continue past "unverified app", tick both Gmail boxes.
4. **Do-not-contact list.** Load `handoff/ben/do-not-contact.csv` (type,value rows: email/domain/phone/name) with `POST /api/data {action:'addSuppression', emails, domains, phones, names}`. It holds every business Volvera (Adi, Ethan, me) or Adi's own app has contacted or queued. About 170 of them are in the Gainesville/Ocala area, including our clients Gladden Boxing Club, Sweat Life Fitness and TutorGNV. Confirm the counts in the Import page afterward. If I can open the Volvera dialer (volvera-dialer.vercel.app) in Chrome, also pull its latest `outreach_drafts`, `leads` and `pipeline` emails/phones/names (read-only) and add any new ones.
5. **Settings.** Enter my From name, signature, mailing address and daily cap (30). Ask me to paste the MillionVerifier key. Put the approved templates on the Templates page. Send one test email to benjones0821@gmail.com from the app and confirm it arrived, then delete that test lead.

## Finding leads (what actually works)
- Work in small, sequential batches. Lessons from Adi's run:
  - Running many research agents at once got Clay throttled ("Too many concurrent requests") and burned through usage limits.
  - WebFetch on business sites needs approval prompts that time out when no one's watching.
  - The search tool mostly returns directories.
- **Best method:** Google in my Chrome (your own tab): `"<business type>" Gainesville FL`. Open each business's **own website** and read emails from page text and mailto links (homepage, then contact/about/team), plus the owner's name. Record the phone shown on the site.
- **Clay as a second source.** Use `search-companies` with `locations.any(city in ("Gainesville","Alachua",...))` and check every result's `locality` is in Florida, because the filter is loose. Then `search-contacts` for owner/founder/president at those domains, then the Email data point, polling `get-task-context` with `entityIds`. One Clay call at a time.
- **Import through the app.** Use the Import page or `POST /api/import {candidates:[...]}`, at most 25 rows per call (or put them in `seed/candidates.json`, push, and use `{mode:'seed', offset}`). The app does the MX check, mailbox check and exclusion matching. Report how many were added and why the rest were rejected.

## Rules (zero mistakes)
- Never construct an email from a name pattern. Never take emails from directories (Yelp, BBB, Angi, Healthgrades, MapQuest, Facebook, LinkedIn). LinkedIn is only for confirming who the owner is.
- **Every source can be stale.** In Adi's run:
  - Clay returned an address that had already bounced.
  - A company website still printed a dead address.
  - A site printed info@ on a domain with no mail server.

  The app's mailbox check catches these. Never mark anything verified by hand without a provider and a reason.
- Independent local businesses only, roughly 2–50 people. No franchises' corporate offices, chains, trade associations, nonprofits, manufacturers or SaaS.
- Don't email anyone on the do-not-contact list.
- **Ask me before:** sending any email, turning on Autopilot, raising the daily cap, spending Clay or Apollo credits beyond normal searches, or agreeing to any terms.
- If you hit a CAPTCHA, a site-permission prompt, a usage limit or a refused action, stop and tell me plainly. Don't work around it.
- Keep my passcode, API keys and client secret out of chat and out of the repo.

## Done means
- The app is live on my Vercel and I can log in.
- Gmail shows "Sending as benjones0821@gmail.com" and a test email has arrived.
- The do-not-contact list is loaded, and my sender details and approved templates are set.
- My target number of verified Gainesville leads is imported, each with its verification reason.
- With my OK, Autopilot is on at 30/day on weekdays.

Then give me a short summary: the app URL, verified lead count, the date the first-email queue runs out, and anything still waiting on me.
