import { json, guarded, body, HttpError } from '../lib/http.js';
import { loadDb, mutateDb, loadAuth } from '../lib/db.js';
import { encrypt } from '../lib/crypto.js';
import { verifyEmail, providerCredits, normalizeEmail } from '../lib/verify.js';
import { publicDb, addEvent, advance, setStatus, domainOf, STATUSES, phoneKey, nameKey } from '../lib/model.js';

const LEAD_FIELDS = ['company', 'firstName', 'lastName', 'title', 'email', 'phone', 'website', 'industry', 'city', 'state', 'notes', 'tags', 'linkedin'];
const CALL_OUTCOMES = ['no_answer', 'voicemail', 'talked', 'booked', 'not_interested', 'wrong_number', 'call_back'];

async function view() {
  const [{ db }, { auth }] = await Promise.all([loadDb(), loadAuth()]);
  return publicDb(db, auth);
}

export const GET = guarded(async () => json(await view()));

function findLead(d, id) {
  const l = d.leads.find((x) => x.id === id);
  if (!l) throw new HttpError('Lead not found', 404);
  return l;
}

export const POST = guarded(async (request) => {
  const b = await body(request);
  const a = b.action;

  if (a === 'verifyLead') {
    const { db } = await loadDb();
    const lead = findLead(db, b.id);
    const v = await verifyEmail(db.settings, lead.email);
    if (v.status === 'error') throw new HttpError(v.reason, 502);
    await mutateDb((d) => {
      const l = findLead(d, b.id);
      l.verification = { status: v.ok ? 'valid' : 'rejected', reason: v.reason, checkedAt: v.checkedAt, provider: v.provider || null };
      addEvent(l, { type: 'verified', result: l.verification.status, reason: v.reason });
    });
    return json({ ok: true, result: v, data: await view() });
  }

  if (a === 'credits') {
    const { db } = await loadDb();
    return json({ ok: true, credits: await providerCredits(db.settings) });
  }

  await mutateDb((d) => {
    switch (a) {
      case 'updateLead': {
        const l = findLead(d, b.id);
        for (const k of LEAD_FIELDS) {
          if (!(k in (b.patch || {}))) continue;
          let v = b.patch[k];
          if (typeof v === 'string') v = v.trim();
          if (k === 'email') {
            v = normalizeEmail(v);
            if (v !== l.email) {
              if (d.leads.some((x) => x.id !== l.id && x.email === v)) throw new HttpError('Another lead already has that email', 409);
              l.verification = { status: 'unverified', reason: 'Email changed, verify before sending', checkedAt: 0 };
            }
          }
          l[k] = v;
        }
        if ('client' in (b.patch || {})) l.client = { ...(l.client || {}), ...b.patch.client };
        l.updatedAt = Date.now();
        break;
      }
      case 'setStatus': {
        const l = findLead(d, b.id);
        if (!STATUSES.includes(b.status)) throw new HttpError('Unknown status');
        setStatus(l, b.status, false);
        if (['replied', 'meeting', 'client', 'lost', 'do_not_contact', 'bounced'].includes(b.status)) l.nextFollowUpAt = null;
        if (b.status === 'do_not_contact' && l.email && !d.suppression.emails.includes(l.email)) d.suppression.emails.push(l.email);
        break;
      }
      case 'logCall': {
        const l = findLead(d, b.id);
        if (!CALL_OUTCOMES.includes(b.outcome)) throw new HttpError('Unknown call outcome');
        addEvent(l, { type: 'call', outcome: b.outcome, note: (b.note || '').slice(0, 2000) });
        l.lastCallAt = Date.now();
        l.callCount = (l.callCount || 0) + 1;
        if (b.outcome === 'talked') advance(l, 'replied');
        else if (b.outcome === 'booked') { advance(l, 'meeting'); l.nextFollowUpAt = null; }
        else if (b.outcome === 'not_interested') { setStatus(l, 'lost', true); l.nextFollowUpAt = null; }
        else if (b.outcome === 'wrong_number') l.phoneBad = true;
        else advance(l, 'contacted');
        if (b.outcome === 'call_back' && b.callbackAt) l.callbackAt = Number(b.callbackAt);
        break;
      }
      case 'addNote': {
        const l = findLead(d, b.id);
        if (!b.text?.trim()) throw new HttpError('Note is empty');
        addEvent(l, { type: 'note', text: b.text.trim().slice(0, 4000) });
        break;
      }
      case 'markResponded': {
        const l = findLead(d, b.id);
        l.needsResponse = false;
        addEvent(l, { type: 'responded' });
        break;
      }
      case 'clearSendWarning': {
        const l = findLead(d, b.id);
        if (b.wentOut) {
          addEvent(l, { type: 'email_sent', kind: 'first', subject: '(confirmed from Gmail)', source: 'manual-confirm' });
          l.lastContactAt = Date.now();
          advance(l, 'contacted');
        }
        delete l.sendUnknown;
        delete l.sending;
        break;
      }
      case 'deleteLead': {
        const i = d.leads.findIndex((x) => x.id === b.id);
        if (i < 0) throw new HttpError('Lead not found', 404);
        const [l] = d.leads.splice(i, 1);
        // Keep the company on the exclusion list if it was ever contacted.
        if ((l.history || []).some((h) => h.type === 'email_sent') && l.email && !d.suppression.emails.includes(l.email)) d.suppression.emails.push(l.email);
        break;
      }
      case 'saveTemplate': {
        const t = b.template || {};
        if (!t.name?.trim() || !t.subject?.trim() || !t.body?.trim()) throw new HttpError('Template needs a name, subject and body');
        const clean = { id: t.id || `t-${Date.now().toString(36)}`, name: t.name.trim(), subject: t.subject.trim(), body: t.body, kind: t.kind === 'followup' ? 'followup' : 'first' };
        const i = d.templates.findIndex((x) => x.id === clean.id);
        if (i >= 0) d.templates[i] = clean; else d.templates.push(clean);
        break;
      }
      case 'deleteTemplate': {
        if (d.templates.length <= 1) throw new HttpError('Keep at least one template');
        d.templates = d.templates.filter((t) => t.id !== b.id);
        break;
      }
      case 'saveSettings': {
        const s = b.settings || {};
        const st = d.settings;
        for (const k of ['fromName', 'signature', 'mailingAddress']) if (k in s) st[k] = String(s[k] || '');
        if ('dailyCap' in s) st.dailyCap = Math.max(1, Math.min(150, Number(s.dailyCap) || 30));
        if ('followUpDays' in s) st.followUpDays = Math.max(1, Math.min(30, Number(s.followUpDays) || 3));
        if ('maxFollowUps' in s) st.maxFollowUps = Math.max(0, Math.min(3, Number(s.maxFollowUps) || 0));
        if ('reverifyDays' in s) st.reverifyDays = Math.max(1, Math.min(180, Number(s.reverifyDays) || 30));
        if ('allowRoleEmails' in s) st.allowRoleEmails = !!s.allowRoleEmails;
        if (s.autopilot) {
          st.autopilot.enabled = !!s.autopilot.enabled;
          st.autopilot.firstTouchPerDay = Math.max(0, Math.min(150, Number(s.autopilot.firstTouchPerDay) || 0));
          st.autopilot.includeFollowUps = !!s.autopilot.includeFollowUps;
        }
        if (s.verifierProvider && ['millionverifier', 'zerobounce'].includes(s.verifierProvider)) st.verifier.provider = s.verifierProvider;
        if (s.verifierKey) st.verifier.apiKeyEnc = encrypt(String(s.verifierKey).trim());
        if ('googleClientId' in s) st.google.clientId = String(s.googleClientId || '').trim();
        if (s.googleClientSecret) st.google.clientSecretEnc = encrypt(String(s.googleClientSecret).trim());
        break;
      }
      case 'addSuppression': {
        for (const e of b.emails || []) { const v = normalizeEmail(e); if (v.includes('@') && !d.suppression.emails.includes(v)) d.suppression.emails.push(v); }
        for (const x of b.domains || []) { const v = domainOf(x); if (v.includes('.') && !d.suppression.domains.includes(v)) d.suppression.domains.push(v); }
        for (const x of b.phones || []) { const v = phoneKey(x); if (v && !d.suppression.phones.includes(v)) d.suppression.phones.push(v); }
        for (const x of b.names || []) { const v = nameKey(x); if (v.length > 3 && !d.suppression.names.includes(v)) d.suppression.names.push(v); }
        break;
      }
      default:
        throw new HttpError(`Unknown action: ${a}`);
    }
  });
  return json({ ok: true, data: await view() });
});
