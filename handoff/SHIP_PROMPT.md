# Ship Adi Outreach: finish verification and start sending

You are picking up work on **Adi Outreach**, my own cold-email and calling app. Your job is to get it to the point where verified leads are being emailed every weekday from adigold21@gmail.com, with zero bounces. Read this whole prompt before doing anything.

## What exists
- **Live app:** https://adi-outreach.vercel.app (I'm logged in, in my Chrome).
- **Code:** GitHub `adigold21GO/adi-outreach`, branch `main`. Pushing to main auto-deploys on Vercel (team "Adi Gold's projects", project `adi-outreach`).
- **How it works:** plain JS front end in `public/`, Vercel functions in `api/`, data in a private Vercel Blob store. The app reads my Gmail through Google sign-in (connected). The `api/data.js` actions include `recordVerification`, `deliveryCheck`, `addSuppression`, `saveSettings`. `api/import.js` has a `seed` mode that imports `seed/candidates.json` in slices of 25, verifying each one.
- **Test:** `node --experimental-test-module-mocks --test test/backend.test.mjs`. Run it before every push.
- **Calling the app's API:** run fetch() calls from the open adi-outreach.vercel.app tab in my Chrome, using the remote Chrome tools. The session cookie is already there. Never put my passcode or any API key in chat.

## Current state (as of Nov 1)
- **239 leads** imported from my Volvera pipeline. **150 are verified**: 141 by Gmail delivery (emailed, no bounce) and 9 by Apollo's mailbox check.
- **11 emails found but not yet verified:** `handoff/found-pending-verification.json`. Each was printed on the business's own website and passed an MX check. Lead ids match the app.
- **78 Volvera leads still have no email:** `handoff/no-email-yet.csv`. 6 were never researched; 72 were searched with no email found (reasons in `notes`).
- **114 new Texas leads** from research: `seed/candidates.json`. Owner-level contacts, emails from Clay. Not imported yet.
- **Exclusion list** in the app: 316 emails, 267 domains, 434 phones and 447 names from the whole Volvera team. Imports skip matches automatically.
- **Apollo:** about 66 lead credits left.

## Blockers only I can clear (ask me first, in one message)
1. **Mailing address** for the email footer. Sending is blocked without it (CAN-SPAM). A P.O. box is fine.
2. **Verifier key.** The 114 research leads need about 114 mailbox checks, more than Apollo's remaining credits. Ask me to buy MillionVerifier (smallest pack) and paste the key into Settings myself, or tell you to use Apollo credits for part of it.
3. **Email copy.** Show me the current "First email" and "Follow-up" templates (Templates page). My Volvera emails used the subject "Adi Gold, UT Austin student | Quick question about {company}" and opened "Hi {first_name}, Quick question from a UT Austin student here in Austin..." Ask which version I want before sending anything. No corny lines. I describe myself as studying sales and business at UT, and my phone is 305-905-7574.

## Steps
1. **Verify the 11 found emails.**
   - First search my Gmail for a bounce on each address (`from:(mailer-daemon OR postmaster) "<address>"`). Any that bounced are out.
   - Then run Apollo's email validation on the rest. Use Apollo's exact confirmation wording and wait for my yes.
   - Record results with `recordVerification`, with provider `apollo-leadmagic` and a reason that includes where the address came from.
   - Only addresses Apollo marks `validated` count as valid.
2. **Research the 78 without an email**, starting with the 6 never researched, using the method below. Then verify what you find the same way.
3. **Import the 114 research leads** with `POST /api/import {mode:'seed', offset}` in steps of 25 once the verifier key is set. The import rejects anything unverified, catch-all, generic, already contacted, or with no mail server. Report how many were added and the top reasons for rejections.
4. **Send me a test email** at adigold21@gmail.com from the app, and confirm it arrived and threads correctly. Delete that test lead afterwards so it doesn't count toward stats.
5. **Ship:** with my OK, turn on Autopilot in Settings. It sends weekdays around 9am Central, follow-ups first, within the daily cap of 30. Keep 30/day unless I say otherwise. Check that the next morning's run logged sends and that the inbox sync caught any replies or bounces.

## Research method that works
- Use my Chrome through Claude in Chrome, in your own tab, one page at a time. Google `"<company>" Austin TX <phone>`, open the business's own site, and read emails from page text and mailto links (homepage, then contact/about).
- The site must show the lead's phone or street address. Otherwise mark it medium confidence and say why.
- MX check every domain: `https://dns.google/resolve?name=<domain>&type=MX`. No MX records means no email.
- Check every address against my Gmail bounces before using it.
- If Google shows a CAPTCHA or Chrome asks for a site permission, stop and tell me. Never bypass either.

## Rules (zero mistakes)
- Never construct an email from a name pattern. Never take emails from directories (Yelp, BBB, Angi, Healthgrades, MapQuest, Facebook, LinkedIn).
- **Clay and websites can both be stale.** Clay returned cody@heatbootcamp.com, and capitalwindowcleaning.com still prints chrisdecker@capitalwindowcleaning.com. Both had already bounced. Always check bounce history.
- **Volvera records can have typos.** Garner Heating's real address was justin.sheffield@garnerac.com, not the stored one without the dot. When something looks off, trust what my Gmail Sent folder shows.
- Never mark an email valid without a provider and a reason. Never send to an unverified lead.
- Smiles of Austin (simons@smilesofaustin.net) is verified, but the site's phone doesn't match the lead. Ask me before emailing it.
- Don't email anyone already contacted by Volvera unless it's a follow-up in the same thread.
- Ask before: spending Apollo credits, sending any email, turning on Autopilot, or changing the daily cap.
- If a step hits a permission prompt, usage limit or tool error, stop and tell me plainly. Don't route around it.

## Done means
- Every lead in the app is either verified (with provider and reason) or has no email and is marked call-only.
- The 114 research leads are imported (or rejected, with reasons).
- The mailing address and approved email copy are in place.
- A test email has arrived.
- Autopilot is on, and the first scheduled run has sent with no bounces.

Then give me a short summary: verified count, how many are queued to send, the date the queue runs out at 30/day, and anything still waiting on me.
