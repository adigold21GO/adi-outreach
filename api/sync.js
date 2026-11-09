import { json, error, isAuthed, isCron } from '../lib/http.js';
import { runSync } from '../lib/sync.js';
import { loadDb, mutateDb } from '../lib/db.js';
import { sendToLead, readyForFirst, readyForAlumniFirst, dueFollowUps } from '../lib/outreach.js';
import { weekdayInTZ, sentToday, alumniSentToday, firstTemplateFor } from '../lib/model.js';
import { readFile } from 'node:fs/promises';
import { importCandidates, MAX_PER_CALL } from '../lib/importer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// New research leads shipped in seed/pending.json are verified (MillionVerifier) and added on the
// next cron run, once each. Rows that fail verification are logged in the import log and not retried.
async function importPending() {
  let all;
  try { all = JSON.parse(await readFile(new URL('../seed/pending.json', import.meta.url), 'utf8')); } catch { return null; }
  const { db } = await loadDb();
  if (!db.settings.verifier?.apiKeyEnc) return { skipped: 'no verifier key' };
  const done = new Set(db.pendingDone || []);
  const todo = all.filter((r) => r.email && !done.has(String(r.email).trim().toLowerCase()));
  let added = 0; let checked = 0;
  for (let i = 0; i < todo.length && i < MAX_PER_CALL * 4; i += MAX_PER_CALL) {
    const batch = todo.slice(i, i + MAX_PER_CALL);
    let results;
    try { results = await importCandidates(batch); } catch (e) { return { added, checked, error: e.message }; }
    checked += results.length; added += results.filter((r) => r.added).length;
    // Only mark rows done when the verifier gave an answer, so a provider outage is retried next run.
    const finished = results.filter((r) => r.status !== 'error').map((r) => r.email);
    await mutateDb((d) => { d.pendingDone = Array.from(new Set([...(d.pendingDone || []), ...finished])); });
  }
  return { added, checked };
}

// Alumni finder. seed/alumni-queue.json holds alumni business owners found by research (name and
// company domain, no email). Each cron run tries the common owner address formats for a few of them,
// verifies each with the verifier, and adds the first confirmed one to its section. A person is
// marked done once tried, so nobody is retried or charged twice; verifier outages are retried.
const ALUMNI_PER_RUN = 12;
export function emailGuesses(first, last, domain) {
  const f = String(first || '').toLowerCase().replace(/[^a-z]/g, '');
  const l = String(last || '').toLowerCase().replace(/[^a-z]/g, '');
  const d = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!f || !d) return [];
  const out = [`${f}@${d}`];
  if (l) out.push(`${f[0]}${l}@${d}`, `${f}.${l}@${d}`, `${f}${l}@${d}`, `${f}${l[0]}@${d}`);
  return [...new Set(out)];
}
async function alumniFinder(started, budgetMs) {
  let queue;
  try { queue = JSON.parse(await readFile(new URL('../seed/alumni-queue.json', import.meta.url), 'utf8')); } catch { return null; }
  const { db } = await loadDb();
  if (!db.settings.verifier?.apiKeyEnc) return { skipped: 'no verifier key' };
  const key = (r) => `${String(r.domain || '').toLowerCase()}|${String(r.lastName || '').toLowerCase()}`;
  const done = new Set(db.alumniDone || []);
  const todo = queue.filter((r) => r.domain && r.firstName && !done.has(key(r))).slice(0, ALUMNI_PER_RUN);
  const out = { tried: 0, added: 0, addedList: [] };
  for (const r of todo) {
    if (Date.now() - started > budgetMs) break;
    let outage = false;
    for (const email of r.email ? [r.email] : emailGuesses(r.firstName, r.lastName, r.domain)) {
      let res;
      try { [res] = await importCandidates([{ ...r, email, website: r.website || `https://${r.domain}` }]); } catch { outage = true; break; }
      if (!res) break;
      if (res.added) { out.added++; out.addedList.push(email); break; }
      if (res.status === 'error') { outage = true; break; }
      // Stop guessing when the domain can't confirm any mailbox or the company is already known.
      if (/catch|accept.?all|already|skipped|exclu/i.test(res.reason || '')) break;
    }
    out.tried++;
    if (!outage) await mutateDb((d) => { d.alumniDone = Array.from(new Set([...(d.alumniDone || []), key(r)])); });
  }
  return out;
}

async function autopilot(started) {
  const { db } = await loadDb();
  const ap = db.settings.autopilot;
  if (!ap.enabled) return { skipped: 'off' };
  const wd = weekdayInTZ();
  if (wd === 'Sat' || wd === 'Sun') return { skipped: 'weekend' };
  const first = db.templates.find((t) => t.kind === 'first');
  const pick = (l) => (firstTemplateFor(db.templates, l) || first).id;
  const follow = db.templates.find((t) => t.kind === 'followup');
  // Alternate follow-ups and first emails so both make progress each day,
  // even when the daily cap or time limit stops the run early.
  const fups = ap.includeFollowUps && follow ? dueFollowUps(db).map((l) => [l.id, follow.id]) : [];
  const firsts = first ? readyForFirst(db).slice(0, ap.firstTouchPerDay).map((l) => [l.id, pick(l)]) : [];
  const queue = [];
  for (let i = 0; i < Math.max(fups.length, firsts.length); i++) {
    if (fups[i]) queue.push(fups[i]);
    if (firsts[i]) queue.push(firsts[i]);
  }
  // Regular sends use dailyCap; UT alumni sends use their own alumniPerDay allowance on top.
  const alumniSent = alumniSentToday(db);
  let room = db.settings.dailyCap - (sentToday(db) - alumniSent);
  let alumniRoom = Math.max(0, (Number(ap.alumniPerDay) || 0) - alumniSent);
  const alumni = alumniRoom ? readyForAlumniFirst(db).slice(0, alumniRoom).map((l) => [l.id, pick(l)]) : [];
  const log = { t: Date.now(), sent: 0, failed: 0, alumniSent: 0, errors: [] };
  let stop = false;
  const send = async (leadId, templateId, source) => {
    try {
      await sendToLead(leadId, templateId, { source });
      log.sent++;
      return true;
    } catch (e) {
      log.failed++; log.errors.push(e.message);
      if (/Gmail is not connected|signed this app out/.test(e.message)) stop = true;
      return false;
    } finally { await sleep(4000 + Math.random() * 4000); }
  };
  // Interleave one alumni email after every few regular ones so both buckets progress each run.
  let ai = 0;
  for (let i = 0; i < queue.length || ai < alumni.length; i++) {
    if (stop || Date.now() - started > 250000) break;
    if (i < queue.length && room > 0) { if (await send(queue[i][0], queue[i][1], 'autopilot')) room--; }
    if ((i % 3 === 2 || i >= queue.length || room <= 0) && ai < alumni.length && alumniRoom > 0) {
      const [id, tid] = alumni[ai++];
      if (await send(id, tid, 'autopilot-alumni')) { alumniRoom--; log.alumniSent++; }
    }
    if (room <= 0 && (ai >= alumni.length || alumniRoom <= 0)) break;
  }
  log.errors = log.errors.slice(0, 5);
  await mutateDb((d) => { d.autopilotLog.push(log); d.autopilotLog = d.autopilotLog.slice(-60); });
  return log;
}

async function handle(request) {
  const cron = isCron(request);
  if (!cron && !isAuthed(request)) return error('Not signed in', 401);
  const started = Date.now();
  try {
    const sync = await runSync();
    const pending = cron ? await importPending() : null;
    const alumni = cron ? await alumniFinder(started, 60000) : null;
    const ap = cron ? await autopilot(started) : null;
    if (alumni) await mutateDb((d) => { d.alumniLog = [...(d.alumniLog || []), { t: Date.now(), tried: alumni.tried, added: alumni.added }].slice(-60); });
    return json({ ok: true, sync, pending, alumni, autopilot: ap });
  } catch (e) {
    console.error(e);
    return error(e.publicMessage || e.message, e.status || 500);
  }
}

export const GET = handle;
export const POST = handle;
