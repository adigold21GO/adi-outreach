import { loadDb, mutateDb } from './db.js';
import { HttpError } from './http.js';
import { sendMail } from './gmail.js';
import { verifyEmail } from './verify.js';
import {
  NO_EMAIL, FREE_MAIL, phoneKey, render, footer, sentToday, followUpsSent, firstTouchSent, addEvent, advance, addBusinessDays, suppressed,
} from './model.js';

const LOCK_MS = 10 * 60 * 1000;

function hasReplied(lead) {
  return (lead.history || []).some((h) => h.type === 'reply' || h.type === 'call' && ['talked', 'booked'].includes(h.outcome));
}

export function eligibility(db, lead, template) {
  if (!lead) return 'Lead not found';
  if (!template) return 'Template not found';
  if (NO_EMAIL.has(lead.status)) return `Lead is marked ${lead.status.replace(/_/g, ' ')}`;
  if (!lead.email) return 'No email address';
  if (lead.verification?.status !== 'valid') return 'Email is not verified. Run Verify on this lead first.';
  // The exclusion list only guards first contact; follow-ups to people we already emailed are fine.
  // Leads imported from your own Volvera pipeline are themselves in the exclusion list (their phone,
  // name and site), so for them only an exact email match means "already contacted".
  const alreadyEmailed = (lead.history || []).some((h) => h.type === 'email_sent');
  if (!alreadyEmailed) {
    const own = String(lead.externalId || '').startsWith('volvera-');
    const sup = own
      ? (db.suppression.emails.includes(lead.email.toLowerCase()) ? 'this address was already emailed by Volvera' : null)
      : suppressed(db, lead.email, { website: lead.website });
    if (sup) return `Blocked: ${sup}`;
  }
  if (!db.settings.fromName?.trim() || !db.settings.signature?.trim()) return 'Set your From name and signature in Settings first.';
  if (/\[Write your intro here/.test(template.body)) return 'Finish the email template first (Templates page).';
  if (!db.settings.mailingAddress?.trim()) return 'Add your mailing address in Settings first (required by law for cold email).';
  if (lead.sending && Date.now() - lead.sending < LOCK_MS) return 'A send to this lead is already in progress';
  if (lead.sendUnknown) return 'A previous send may have gone out. Check Gmail Sent, then clear the warning on this lead.';
  if (template.kind === 'followup') {
    if (!firstTouchSent(lead)) return 'Send the first email before a follow-up';
    if (hasReplied(lead)) return 'This lead already replied';
    if (followUpsSent(lead) >= (db.settings.maxFollowUps ?? 1)) return 'Follow-up limit reached for this lead';
  } else if (firstTouchSent(lead)) {
    return 'First email already sent to this lead. Use the follow-up template.';
  }
  return null;
}

function lockedCount(db) {
  return db.leads.filter((l) => l.sending && Date.now() - l.sending < LOCK_MS).length;
}

export async function sendToLead(leadId, templateId, { source = 'manual' } = {}) {
  let { db } = await loadDb();
  let lead = db.leads.find((l) => l.id === leadId);
  const template = db.templates.find((t) => t.id === templateId);
  const why = eligibility(db, lead, template);
  if (why) throw new HttpError(why, 409);

  // Re-verify stale verifications before sending.
  const ageDays = (Date.now() - (lead.verification.checkedAt || 0)) / 864e5;
  if (ageDays > (db.settings.reverifyDays || 30)) {
    const v = await verifyEmail(db.settings, lead.email);
    await mutateDb((d) => {
      const l = d.leads.find((x) => x.id === leadId);
      if (!l) return;
      if (v.ok || v.status !== 'error') {
        l.verification = { status: v.ok ? 'valid' : 'rejected', reason: v.reason, checkedAt: v.checkedAt, provider: v.provider };
        addEvent(l, { type: 'verified', result: l.verification.status, reason: v.reason });
      }
    });
    if (!v.ok) throw new HttpError(`Re-check before sending failed: ${v.reason}`, 409);
  }

  // Take a lock and re-check the daily cap atomically.
  await mutateDb((d) => {
    const l = d.leads.find((x) => x.id === leadId);
    const t = d.templates.find((x) => x.id === templateId);
    const w = eligibility(d, l, t);
    if (w) throw new HttpError(w, 409);
    if (sentToday(d) + lockedCount(d) >= d.settings.dailyCap) {
      throw new HttpError(`Daily limit of ${d.settings.dailyCap} emails reached. It resets at midnight Central.`, 429);
    }
    l.sending = Date.now();
  });

  ({ db } = await loadDb());
  lead = db.leads.find((l) => l.id === leadId);
  const isFollow = template.kind === 'followup';
  const msg = render(template, lead, db.settings);
  const text = `${msg.body.trim()}\n\n${footer(db.settings)}\n`;
  const lastSent = [...(lead.history || [])].reverse().find((h) => h.type === 'email_sent');

  let sent;
  try {
    sent = await sendMail(db.settings, {
      to: lead.email,
      subject: msg.subject,
      text,
      threadId: isFollow ? lastSent?.threadId : undefined,
      inReplyTo: isFollow ? lastSent?.messageIdHeader : undefined,
      references: isFollow ? lastSent?.messageIdHeader : undefined,
    });
  } catch (e) {
    // Gmail rejected it before sending (or the request failed). Release the lock.
    const definite = e instanceof HttpError && e.status !== 502;
    await mutateDb((d) => {
      const l = d.leads.find((x) => x.id === leadId);
      if (!l) return;
      delete l.sending;
      if (!definite) l.sendUnknown = Date.now();
      addEvent(l, { type: 'send_failed', reason: e.message, source });
    });
    throw e;
  }

  const { db: after } = await mutateDb((d) => {
    const l = d.leads.find((x) => x.id === leadId);
    delete l.sending;
    addEvent(l, {
      type: 'email_sent', kind: isFollow ? 'followup' : 'first', templateId, subject: msg.subject,
      gmailId: sent.id, threadId: sent.threadId, messageIdHeader: sent.messageIdHeader, source,
    });
    l.threadIds = Array.from(new Set([...(l.threadIds || []), sent.threadId]));
    l.lastContactAt = Date.now();
    const more = followUpsSent(l) < (d.settings.maxFollowUps ?? 1);
    l.nextFollowUpAt = more ? addBusinessDays(Date.now(), d.settings.followUpDays || 3) : null;
    advance(l, 'contacted');
    // Never contact this company again from a future import.
    const dom = l.email.split('@')[1];
    if (!d.suppression.emails.includes(l.email)) d.suppression.emails.push(l.email);
    if (dom && !FREE_MAIL.has(dom) && !d.suppression.domains.includes(dom)) d.suppression.domains.push(dom);
    const pk = phoneKey(l.phone); if (pk && !d.suppression.phones.includes(pk)) d.suppression.phones.push(pk);
    return l;
  });
  return { lead: after.leads.find((l) => l.id === leadId), sentToday: sentToday(after) };
}

// Leads ready for a first email, in list order.
export function readyForFirst(db) {
  return db.leads.filter((l) => l.status === 'new' && l.verification?.status === 'valid' && !firstTouchSent(l) && !l.sending && !l.sendUnknown);
}

export function dueFollowUps(db, now = Date.now()) {
  return db.leads.filter((l) => l.status === 'contacted' && l.nextFollowUpAt && l.nextFollowUpAt <= now && !hasReplied(l)
    && followUpsSent(l) < (db.settings.maxFollowUps ?? 1) && !l.sending && !l.sendUnknown);
}
