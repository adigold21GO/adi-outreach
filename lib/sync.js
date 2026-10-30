import { loadDb, mutateDb, loadAuth } from './db.js';
import { listMessages, getMeta } from './gmail.js';
import { addEvent, advance, setStatus } from './model.js';

const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (e-?mailing|contacting)|do not (e-?mail|contact)|don'?t (e-?mail|contact))\b/i;
const AUTO = /(out of (the )?office|automatic reply|auto-?reply|autoreply|away from (the|my) (office|desk)|on vacation|on leave|thank you for (your email|contacting))/i;

function addrOf(from) {
  const m = /<([^>]+)>/.exec(from || '');
  return (m ? m[1] : from || '').trim().toLowerCase();
}

export async function runSync() {
  const { auth } = await loadAuth();
  if (!auth?.refreshEnc || auth.broken) return { skipped: 'Gmail not connected' };
  const { db } = await loadDb();
  const me = (auth.email || '').toLowerCase();

  const threadToLead = new Map();
  const emailToLead = new Map();
  for (const l of db.leads) {
    for (const t of l.threadIds || []) threadToLead.set(t, l.id);
    if (l.email) emailToLead.set(l.email.toLowerCase(), l.id);
  }
  const seen = new Set();
  for (const l of db.leads) for (const h of l.history || []) if (h.msgId) seen.add(h.msgId);

  const since = Math.floor(((db.sync.lastSyncAt || Date.now() - 30 * 864e5) - 3 * 864e5) / 1000);
  const findings = [];

  if (threadToLead.size) {
    const msgs = await listMessages(db.settings, `after:${since} -from:me -in:chats`, 2000);
    for (const m of msgs) {
      if (seen.has(m.id) || !threadToLead.has(m.threadId)) continue;
      const meta = await getMeta(db.settings, m.id);
      const from = addrOf(meta.headers.from);
      if (from === me) continue;
      const subject = meta.headers.subject || '';
      let kind = 'reply';
      if (/mailer-daemon|postmaster/i.test(from) || /delivery status notification|undeliverable|delivery has failed|returned mail/i.test(subject)) kind = 'bounce';
      else if (/auto-replied|auto-generated/i.test(meta.headers['auto-submitted'] || '') || meta.headers['x-autoreply'] || AUTO.test(subject)) kind = 'auto_reply';
      else if (OPT_OUT.test(meta.snippet)) kind = 'opt_out';
      findings.push({ leadId: threadToLead.get(m.threadId), msgId: m.id, kind, from, subject, snippet: meta.snippet.slice(0, 280), at: meta.internalDate });
    }
  }

  // Bounces that Gmail did not thread with the original message.
  const bounces = await listMessages(db.settings, `after:${since} from:(mailer-daemon OR postmaster)`, 500);
  for (const m of bounces) {
    if (seen.has(m.id) || findings.some((f) => f.msgId === m.id)) continue;
    const meta = await getMeta(db.settings, m.id);
    const failed = (meta.headers['x-failed-recipients'] || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
    let leadId = threadToLead.get(m.threadId);
    if (!leadId) for (const f of failed) if (emailToLead.has(f)) leadId = emailToLead.get(f);
    if (!leadId) {
      for (const [e, id] of emailToLead) if (meta.snippet.toLowerCase().includes(e)) { leadId = id; break; }
    }
    if (leadId) findings.push({ leadId, msgId: m.id, kind: 'bounce', from: addrOf(meta.headers.from), subject: meta.headers.subject || '', snippet: meta.snippet.slice(0, 280), at: meta.internalDate });
  }

  const counts = { reply: 0, auto_reply: 0, bounce: 0, opt_out: 0 };
  await mutateDb((d) => {
    const done = new Set();
    for (const l of d.leads) for (const h of l.history || []) if (h.msgId) done.add(h.msgId);
    for (const f of findings) {
      if (done.has(f.msgId)) continue;
      const l = d.leads.find((x) => x.id === f.leadId);
      if (!l) continue;
      done.add(f.msgId);
      counts[f.kind]++;
      if (f.kind === 'bounce') {
        addEvent(l, { type: 'bounce', msgId: f.msgId, snippet: f.snippet, at: f.at });
        l.verification = { ...(l.verification || {}), status: 'rejected', reason: 'Bounced', checkedAt: Date.now() };
        setStatus(l, 'bounced', true);
        l.nextFollowUpAt = null;
      } else if (f.kind === 'auto_reply') {
        addEvent(l, { type: 'auto_reply', msgId: f.msgId, from: f.from, subject: f.subject, snippet: f.snippet, at: f.at });
      } else if (f.kind === 'opt_out') {
        addEvent(l, { type: 'reply', msgId: f.msgId, from: f.from, subject: f.subject, snippet: f.snippet, at: f.at, optOut: true });
        setStatus(l, 'do_not_contact', true);
        l.nextFollowUpAt = null;
      } else {
        addEvent(l, { type: 'reply', msgId: f.msgId, from: f.from, subject: f.subject, snippet: f.snippet, at: f.at });
        l.needsResponse = true;
        l.nextFollowUpAt = null;
        advance(l, 'replied');
      }
    }
    d.sync = { lastSyncAt: Date.now(), lastResult: counts };
  });
  return counts;
}
