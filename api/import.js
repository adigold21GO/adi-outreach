import { readFile } from 'node:fs/promises';
import { json, guarded, body, HttpError } from '../lib/http.js';
import { loadDb, mutateDb } from '../lib/db.js';
import { randomId } from '../lib/crypto.js';
import { domainOf, FREE_MAIL, STATUSES, phoneKey, nameKey } from '../lib/model.js';
import { importCandidates, clean, MAX_PER_CALL } from '../lib/importer.js';

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
  if (b.mode === 'seed' || (b.mode === 'verified' && b.fromSeed)) {
    const file = b.mode === 'seed' ? '../seed/candidates.json' : '../seed/verified.json';
    const all = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    seedTotal = all.length;
    const offset = Math.max(0, Number(b.offset) || 0);
    raw = all.slice(offset, offset + MAX_PER_CALL);
  }
  const results = await importCandidates(raw, { preVerified: b.mode === 'verified' });
  return json({
    ok: true,
    results: results.map(({ email, company, added, status, reason }) => ({ email, company, added, status, reason })),
    added: results.filter((r) => r.added).length,
    seedTotal,
  });
});
