export const TZ = 'America/Chicago';

export const STATUSES = ['new', 'contacted', 'replied', 'meeting', 'client', 'lost', 'bounced', 'do_not_contact'];
// Statuses that block any further email.
export const NO_EMAIL = new Set(['bounced', 'do_not_contact', 'client', 'lost']);

export const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'att.net', 'sbcglobal.net', 'comcast.net', 'verizon.net',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'charter.net', 'cox.net',
]);

export function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function weekdayInTZ(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d); // Mon..Sun
}

export function addBusinessDays(ts, n) {
  const d = new Date(ts);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = weekdayInTZ(d);
    if (wd !== 'Sat' && wd !== 'Sun') added++;
  }
  return d.getTime();
}

export function domainOf(s) {
  if (!s) return '';
  let v = String(s).trim().toLowerCase();
  if (v.includes('@')) v = v.split('@').pop();
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '');
  v = v.split(/[/?#:]/)[0];
  return v.replace(/\.$/, '');
}

export function defaultTemplates() {
  return [
    {
      id: 'first-touch',
      name: 'First email',
      kind: 'first',
      subject: 'Quick question about {company}',
      body:
        'Hi {first_name},\n\n' +
        "[Write your intro here: who you are, what you do for local businesses, one proof point.]\n\n" +
        "I'd like to see whether something similar would help {company}.\n\n" +
        'Would you be open to a 15-minute call next week?',
    },
    {
      id: 'follow-up',
      name: 'Follow-up',
      kind: 'followup',
      subject: 'Re: Quick question about {company}',
      body:
        'Hi {first_name},\n\n' +
        'Following up on my note below. If it helps, I can send two or three specific ideas for {company} before we talk, so you can judge whether a call is worth your time.\n\n' +
        'Thanks for reading either way.',
    },
  ];
}

export function defaultDb() {
  return {
    schema: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: {
      fromName: '',
      signature: '',
      mailingAddress: '',
      dailyCap: 30,
      followUpDays: 3,
      maxFollowUps: 1,
      allowRoleEmails: false,
      reverifyDays: 30,
      autopilot: { enabled: false, firstTouchPerDay: 20, includeFollowUps: true },
      verifier: { provider: 'millionverifier', apiKeyEnc: null },
      google: { clientId: '', clientSecretEnc: null },
    },
    templates: defaultTemplates(),
    leads: [],
    suppression: { emails: [], domains: [] },
    importLog: [],
    sync: { lastSyncAt: 0, lastResult: null },
    autopilotLog: [],
  };
}

export function migrate(db) {
  const d = defaultDb();
  db.settings = { ...d.settings, ...(db.settings || {}) };
  db.settings.autopilot = { ...d.settings.autopilot, ...(db.settings.autopilot || {}) };
  db.settings.verifier = { ...d.settings.verifier, ...(db.settings.verifier || {}) };
  db.settings.google = { ...d.settings.google, ...(db.settings.google || {}) };
  db.templates ||= d.templates;
  db.leads ||= [];
  db.suppression ||= { emails: [], domains: [] };
  db.suppression.phones ||= [];
  db.suppression.names ||= [];
  db.importLog ||= [];
  db.sync ||= d.sync;
  db.autopilotLog ||= [];
  return db;
}

export function render(template, lead, settings) {
  const first = (lead.firstName || '').trim();
  const vars = {
    first_name: first || 'there',
    last_name: lead.lastName || '',
    company: lead.company || 'your business',
    city: lead.city || '',
    industry: lead.industry || '',
    title: lead.title || '',
    my_name: settings.fromName || '',
    detail: (lead.detail || '').trim(),
    task: (lead.task || '').trim(),
  };
  const fill = (s) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] !== '' ? vars[k] : m));
  return { subject: fill(template.subject).trim(), body: fill(template.body) };
}

// Any {...} left after filling means the email would ship with literal placeholder text.
export function unfilled(msg) {
  return [...new Set(`${msg.subject}\n${msg.body}`.match(/\{[^{}\n]{1,60}\}/g) || [])];
}

export function footer(settings) {
  const parts = [];
  if (settings.signature) parts.push(settings.signature.trim());
  const legal = [];
  if (settings.mailingAddress) legal.push(settings.mailingAddress.trim());
  legal.push('If you would rather not hear from me, reply "unsubscribe" and I won\'t email again.');
  parts.push(legal.join('\n'));
  return parts.join('\n\n');
}

export function sentToday(db, now = new Date()) {
  const key = dayKey(now);
  let n = 0;
  for (const l of db.leads) for (const h of l.history || []) if (h.type === 'email_sent' && dayKey(new Date(h.t)) === key) n++;
  return n;
}

export function followUpsSent(lead) {
  return (lead.history || []).filter((h) => h.type === 'email_sent' && h.kind === 'followup').length;
}

export function firstTouchSent(lead) {
  return (lead.history || []).some((h) => h.type === 'email_sent' && h.kind !== 'followup');
}

export function addEvent(lead, ev) {
  lead.history ||= [];
  lead.history.push({ t: Date.now(), ...ev });
  lead.updatedAt = Date.now();
}

const RANK = { new: 0, contacted: 1, replied: 2, meeting: 3, client: 4 };
// Move status forward only (never downgrade an engaged lead automatically).
export function advance(lead, status) {
  const cur = lead.status || 'new';
  if (['bounced', 'do_not_contact', 'lost'].includes(cur) && !['client', 'meeting'].includes(status)) return;
  if (status in RANK && cur in RANK && RANK[status] <= RANK[cur]) return;
  if (cur !== status) {
    addEvent(lead, { type: 'status', from: cur, to: status, auto: true });
    lead.status = status;
  }
}

export function setStatus(lead, status, auto = false) {
  if (!STATUSES.includes(status)) throw new Error('Unknown status');
  if (lead.status === status) return;
  addEvent(lead, { type: 'status', from: lead.status, to: status, auto });
  lead.status = status;
  if (status === 'client' && !lead.client) lead.client = { since: Date.now(), monthly: 0, notes: '' };
}

export function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

export function nameKey(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(llc|inc|co|corp|company|the|pllc|pc|ltd)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// `lead` may carry phone / company / website for a stricter company-level match.
export function suppressed(db, email, lead = {}) {
  const e = (email || '').toLowerCase();
  const dom = domainOf(e);
  const sup = db.suppression;
  if (sup.emails.includes(e)) return 'on the exclusion list';
  if (!FREE_MAIL.has(dom) && sup.domains.includes(dom)) return 'company already contacted before';
  const wd = domainOf(lead.website);
  if (wd && !FREE_MAIL.has(wd) && sup.domains.includes(wd)) return 'company already contacted before';
  const pk = phoneKey(lead.phone);
  if (pk && (sup.phones || []).includes(pk)) return 'phone number already contacted before';
  const nk = nameKey(lead.company);
  if (nk && nk.length > 3 && (sup.names || []).includes(nk)) return 'business name already contacted before';
  return null;
}

// Public view of the DB (no secrets).
export function publicDb(db, auth) {
  const s = db.settings;
  return {
    settings: {
      ...s,
      verifier: { provider: s.verifier.provider, hasKey: !!s.verifier.apiKeyEnc },
      google: { clientId: s.google.clientId, hasSecret: !!s.google.clientSecretEnc },
    },
    templates: db.templates,
    leads: db.leads,
    suppressionCount: { emails: db.suppression.emails.length, domains: db.suppression.domains.length, phones: (db.suppression.phones || []).length, names: (db.suppression.names || []).length },
    importLog: db.importLog.slice(-400),
    sync: db.sync,
    autopilotLog: db.autopilotLog.slice(-30),
    gmail: auth ? { connected: !!auth.refreshEnc && !auth.broken, email: auth.email, broken: !!auth.broken, connectedAt: auth.connectedAt } : { connected: false },
    sentToday: sentToday(db),
    today: dayKey(),
  };
}
