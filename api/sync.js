import { json, error, isAuthed, isCron } from '../lib/http.js';
import { runSync } from '../lib/sync.js';
import { loadDb, mutateDb } from '../lib/db.js';
import { sendToLead, readyForFirst, dueFollowUps } from '../lib/outreach.js';
import { weekdayInTZ, sentToday, firstTemplateFor } from '../lib/model.js';
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
  let room = db.settings.dailyCap - sentToday(db);
  const log = { t: Date.now(), sent: 0, failed: 0, errors: [] };
  for (const [leadId, templateId] of queue) {
    if (room <= 0 || Date.now() - started > 250000) break;
    try {
      await sendToLead(leadId, templateId, { source: 'autopilot' });
      log.sent++; room--;
    } catch (e) {
      log.failed++; log.errors.push(e.message);
      if (e.status === 429 || /Gmail is not connected|signed this app out/.test(e.message)) break;
    }
    await sleep(4000 + Math.random() * 4000);
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
    const ap = cron ? await autopilot(started) : null;
    return json({ ok: true, sync, pending, autopilot: ap });
  } catch (e) {
    console.error(e);
    return error(e.publicMessage || e.message, e.status || 500);
  }
}

export const GET = handle;
export const POST = handle;
