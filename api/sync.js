import { json, error, isAuthed, isCron } from '../lib/http.js';
import { runSync } from '../lib/sync.js';
import { loadDb, mutateDb } from '../lib/db.js';
import { sendToLead, readyForFirst, dueFollowUps } from '../lib/outreach.js';
import { weekdayInTZ, sentToday } from '../lib/model.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autopilot(started) {
  const { db } = await loadDb();
  const ap = db.settings.autopilot;
  if (!ap.enabled) return { skipped: 'off' };
  const wd = weekdayInTZ();
  if (wd === 'Sat' || wd === 'Sun') return { skipped: 'weekend' };
  const first = db.templates.find((t) => t.kind === 'first');
  const follow = db.templates.find((t) => t.kind === 'followup');
  const queue = [];
  if (ap.includeFollowUps && follow) for (const l of dueFollowUps(db)) queue.push([l.id, follow.id]);
  if (first) for (const l of readyForFirst(db).slice(0, ap.firstTouchPerDay)) queue.push([l.id, first.id]);
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
    const ap = cron ? await autopilot(started) : null;
    return json({ ok: true, sync, autopilot: ap });
  } catch (e) {
    console.error(e);
    return error(e.publicMessage || e.message, e.status || 500);
  }
}

export const GET = handle;
export const POST = handle;
