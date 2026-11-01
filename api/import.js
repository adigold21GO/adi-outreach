import { readFile } from 'node:fs/promises';
import { json, guarded, body, HttpError } from '../lib/http.js';
import { loadDb, mutateDb } from '../lib/db.js';
import { randomId } from '../lib/crypto.js';
import { verifyEmail, normalizeEmail, syntaxOk, hasMx, isDisposable } from '../lib/verify.js';
import { domainOf, suppressed, FREE_MAIL, addEvent, STATUSES, phoneKey, nameKey } from '../lib/model.js';

const MAX_PER_CALL = 25;
const STR = (v, n = 300) => (v == null ? '' : String(v).trim().slice(0, n));

function clean(c) {
  return {
    company: STR(c.company, 200),
    firstName: STR(c.firstName || c.first_name, 80),
    lastName: STR(c.lastName || c.last_name, 80),
    title: STR(c.title, 120),
    email: normalizeEmail(c.email),
    phone: STR(c.phone, 40),
    website: STR(c.website, 200),
    industry: STR(c.industry, 80),
    city: STR(c.city, 80),
    state: STR(c.state, 40),
    linkedin: STR(c.linkedin, 300),
    notes: STR(c.notes, 2000),
    detail: STR(c.detail, 200),
    task: STR(c.task, 120),
    source: STR(c.source, 80),
  };
}

// Reasons a candidate can't be added, checked before spending a verification credit.
function preCheck(db, c, batchDomains, batchEmails) {
  if (!c.email) return 'No email';
  if (!syntaxOk(c.email)) return 'Not a valid email format';
  if (!c.company) return 'Missing company name';
  if (db.leads.some((l) => l.email === c.email) || batchEmails.has(c.email)) return 'Already in your list';
  const sup = suppressed(db, c.email, c);
  if (sup) return `Skipped: ${sup}`;
  const pk = phoneKey(c.phone);
  if (pk && db.leads.some((l) => phoneKey(l.phone) === pk)) return 'Company already in your list (same phone)';
  const doms = new Set([domainOf(c.email), domainOf(c.website)].filter((x) => x && !FREE_MAIL.has(x)));
  for (const dmn of doms) {
    if (db.suppression.domains.includes(dmn)) return 'Skipped: company already contacted before';
    if (batchDomains.has(dmn) || db.leads.some((l) => domainOf(l.email) === dmn || domainOf(l.website) === dmn)) return 'Company already in your list';
  }
  return null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export const POST = guarded(async (request) => {
  const b = await body(request);

  // Import past outreach (already contacted) without sending anything.
  if (b.mode === 'history') {
    const rows = (b.rows || []).slice(0, 500);
    const { result } = await mutateDb((d) => {
      let added = 0; let updated = 0;
      for (const r of rows) {
        const c = clean(r);
        if (!c.company && !c.email) continue;
        const dom = domainOf(c.email);
        if (c.email && !d.suppression.emails.includes(c.email)) d.suppression.emails.push(c.email);
        if (dom && !FREE_MAIL.has(dom) && !d.suppression.domains.includes(dom)) d.suppression.domains.push(dom);
        const wd = domainOf(c.website);
        if (wd && !FREE_MAIL.has(wd) && !d.suppression.domains.includes(wd)) d.suppression.domains.push(wd);
        const pk = phoneKey(c.phone); if (pk && !d.suppression.phones.includes(pk)) d.suppression.phones.push(pk);
        const nk = nameKey(c.company); if (nk.length > 3 && !d.suppression.names.includes(nk)) d.suppression.names.push(nk);
        let l = d.leads.find((x) => (c.email && x.email === c.email) || (r.externalId && x.externalId === r.externalId));
        if (!l) {
          l = { id: randomId(), ...c, externalId: r.externalId || null, status: 'new', createdAt: Date.now(), updatedAt: Date.now(), history: [], verification: { status: 'unverified', reason: 'Imported from Volvera dialer, verify before emailing again', checkedAt: 0 } };
          d.leads.push(l); added++;
        } else updated++;
        const status = STATUSES.includes(r.status) ? r.status : 'contacted';
        l.status = status;
        for (const h of r.history || []) {
          if (l.history.some((x) => x.extId && x.extId === h.extId)) continue;
          l.history.push({ ...h, t: Number(h.t) || Date.now(), source: 'volvera' });
        }
        l.history.sort((x, y) => x.t - y.t);
        const lastSend = [...l.history].reverse().find((h) => h.type === 'email_sent');
        if (lastSend) l.lastContactAt = lastSend.t;
      }
      return { added, updated };
    });
    return json({ ok: true, ...result });
  }

  // Seed mode: rows bundled with the deployment (seed/candidates.json), processed in slices.
  let raw = b.candidates || [];
  let seedTotal = null;
  if (b.mode === 'seed') {
    const all = JSON.parse(await readFile(new URL('../seed/candidates.json', import.meta.url), 'utf8'));
    seedTotal = all.length;
    const offset = Math.max(0, Number(b.offset) || 0);
    raw = all.slice(offset, offset + MAX_PER_CALL);
  }
  const candidates = raw.map(clean);
  if (candidates.length > MAX_PER_CALL) throw new HttpError(`Send at most ${MAX_PER_CALL} rows per request`);
  const { db } = await loadDb();
  // 'verified' mode: rows already mailbox-checked outside the app (e.g. Apollo). Each row must carry
  // the provider and reason; the app still runs format, duplicate, exclusion and mail-server checks.
  const preVerified = b.mode === 'verified';
  if (preVerified) {
    raw.forEach((x, i) => {
      if (!x.verifiedBy || !x.verifiedReason) throw new HttpError(`Row ${i + 1}: verifiedBy and verifiedReason are required in verified mode`);
      candidates[i].verifiedBy = String(x.verifiedBy).slice(0, 60);
      candidates[i].verifiedReason = String(x.verifiedReason).slice(0, 300);
    });
  } else if (!db.settings.verifier.apiKeyEnc) {
    throw new HttpError('Add your verification service API key in Settings before importing. Nothing gets added unverified.', 409);
  }

  const batchDomains = new Set(); const batchEmails = new Set();
  const plan = candidates.map((c) => {
    const why = preCheck(db, c, batchDomains, batchEmails);
    if (!why) { batchEmails.add(c.email); const dm = domainOf(c.email); if (!FREE_MAIL.has(dm)) batchDomains.add(dm); }
    return { c, why };
  });

  const results = await pool(plan, 5, async ({ c, why }) => {
    if (why) return { email: c.email, company: c.company, added: false, status: 'skipped', reason: why };
    if (c.verifiedBy) {
      const dm = domainOf(c.email);
      if (isDisposable(c.email)) return { email: c.email, company: c.company, added: false, status: 'rejected', reason: 'Disposable address' };
      if (!(await hasMx(dm))) return { email: c.email, company: c.company, added: false, status: 'rejected', reason: `${dm} has no mail server` };
      const v = { ok: true, reason: c.verifiedReason, checkedAt: Date.now(), provider: c.verifiedBy };
      delete c.verifiedBy; delete c.verifiedReason;
      return { email: c.email, company: c.company, added: true, status: 'added', reason: v.reason, v, c };
    }
    const v = await verifyEmail(db.settings, c.email);
    return { email: c.email, company: c.company, added: v.ok, status: v.ok ? 'added' : v.status, reason: v.reason, v, c };
  });

  if (results.some((r) => r.status === 'error') && !results.some((r) => r.added)) {
    // Likely an API key / credit problem: surface it instead of silently rejecting.
    const first = results.find((r) => r.status === 'error');
    if (/key|credit|api|unreachable/i.test(first.reason)) throw new HttpError(first.reason, 502);
  }

  await mutateDb((d) => {
    for (const r of results) {
      if (r.added) {
        // Re-check in case something changed while verifying.
        const dm = domainOf(r.c.email);
        const dupDomain = !FREE_MAIL.has(dm) && d.leads.some((l) => domainOf(l.email) === dm);
        if (dupDomain || d.leads.some((l) => l.email === r.c.email) || suppressed(d, r.c.email, r.c)) { r.added = false; r.status = 'skipped'; r.reason = 'Already in your list'; continue; }
        const lead = {
          id: randomId(), ...r.c, status: 'new', createdAt: Date.now(), updatedAt: Date.now(), history: [],
          verification: { status: 'valid', reason: r.v.reason, checkedAt: r.v.checkedAt, provider: r.v.provider },
        };
        addEvent(lead, { type: 'imported', source: r.c.source || 'import' });
        addEvent(lead, { type: 'verified', result: 'valid', reason: r.v.reason });
        d.leads.push(lead);
      }
      d.importLog.push({ t: Date.now(), email: r.email, company: r.company, status: r.status, reason: r.reason });
    }
    if (d.importLog.length > 3000) d.importLog = d.importLog.slice(-3000);
  });

  return json({
    ok: true,
    results: results.map(({ email, company, added, status, reason }) => ({ email, company, added, status, reason })),
    added: results.filter((r) => r.added).length,
    seedTotal,
  });
});
