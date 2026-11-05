import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const P = '/home/claude/adi-outreach';
process.env.APP_SECRET = 'x'.repeat(40);
process.env.APP_PASSCODE = 'secret-pass';
process.env.CRON_SECRET = 'cron123';
process.env.ALLOWED_GMAIL = 'adigold21@gmail.com';

// ---- in-memory blob store with etag semantics ----
const store = new Map(); let etagN = 0;
class BlobPreconditionFailedError extends Error {}
class BlobNotFoundError extends Error {}
mock.module('@vercel/blob', {
  namedExports: {
    BlobPreconditionFailedError, BlobNotFoundError,
    // Like production: the GET response's ETag header differs from the metadata ETag that put() checks.
    async get(path) {
      const v = store.get(path); if (!v) return null;
      return { statusCode: 200, stream: new Response(v.body).body, blob: { etag: `"cdn-${v.etag}"` } };
    },
    async head(path) {
      const v = store.get(path); if (!v) throw new BlobNotFoundError('not found');
      return { etag: v.etag };
    },
    async put(path, body, opts) {
      const cur = store.get(path);
      if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw new BlobPreconditionFailedError('precondition');
      if (!opts.ifMatch && !opts.allowOverwrite && cur) throw new Error('This blob already exists');
      const etag = `e${++etagN}`; store.set(path, { body, etag }); return { etag };
    },
  },
});
// ---- DNS: only "dead.com" lacks MX ----
mock.module('node:dns', {
  defaultExport: { promises: { Resolver: class { setServers() {} async resolveMx(d) { if (d === 'dead.com') { const e = new Error('nodata'); e.code = 'ENODATA'; throw e; } return [{ exchange: 'mx.' + d, priority: 10 }]; } } } },
});

// ---- fetch mock: Google, Gmail, MillionVerifier ----
const sentRaw = []; let inbox = [];
const verdicts = { 'catch@catch.com': 'catch_all', 'nobody@real.com': 'invalid' };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.host === 'api.millionverifier.com') {
    if (u.pathname.endsWith('/credits')) return J({ credits: 900, bulk_credits: 0 });
    const e = u.searchParams.get('email');
    return J({ email: e, result: verdicts[e] || 'ok', error: '' });
  }
  if (u.host === 'oauth2.googleapis.com') {
    const b = new URLSearchParams(init.body);
    if (b.get('grant_type') === 'authorization_code') return J({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' });
    return J({ access_token: 'at2', expires_in: 3600 });
  }
  if (u.host === 'gmail.googleapis.com') {
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return J({ emailAddress: 'adigold21@gmail.com' });
    if (p === '/messages/send') { const b = JSON.parse(init.body); sentRaw.push(b); const n = sentRaw.length; return J({ id: `m${n}`, threadId: b.threadId || `t${n}` }); }
    if (p === '/messages') {
      const q = u.searchParams.get('q');
      const list = inbox.filter((m) => (q.includes('mailer-daemon') ? m.bounce : !m.bounce));
      return J({ messages: list.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const id = p.split('/')[2];
    if (id && id.startsWith('m')) return J({ id, threadId: 't1', payload: { headers: [{ name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } });
    const m = inbox.find((x) => x.id === id);
    if (m) return J({ id: m.id, threadId: m.threadId, snippet: m.snippet, internalDate: String(Date.now()), payload: { headers: m.headers } });
    return J({ error: { message: 'not found' } }, 404);
  }
  throw new Error('unexpected fetch ' + url);
};

const session = await import(`${P}/api/session.js`);
const data = await import(`${P}/api/data.js`);
const imp = await import(`${P}/api/import.js`);
const send = await import(`${P}/api/send.js`);
const google = await import(`${P}/api/google.js`);
const sync = await import(`${P}/api/sync.js`);

let cookie = '';
const req = (path, method = 'GET', body, extraHeaders = {}) => new Request(`https://app.test${path}`, { method, headers: { cookie, 'content-type': 'application/json', ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
const call = async (fn, ...a) => { const r = await fn(req(...a)); const t = await r.text(); return { status: r.status, j: t ? JSON.parse(t) : {}, r }; };

test('end to end', async () => {
  // auth
  assert.equal((await call(data.GET, '/api/data')).status, 401);
  assert.equal((await call(session.POST, '/api/session', 'POST', { passcode: 'nope' })).status, 401);
  const login = await session.POST(req('/api/session', 'POST', { passcode: 'secret-pass' }));
  cookie = login.headers.get('set-cookie').split(';')[0];
  let d = (await call(data.GET, '/api/data')).j;
  assert.equal(d.leads.length, 0); assert.equal(d.gmail.connected, false);

  // import without key -> blocked
  let r = await call(imp.POST, '/api/import', 'POST', { candidates: [{ company: 'A', email: 'a@a.com' }] });
  assert.equal(r.status, 409);

  // settings + exclusion list
  r = await call(data.POST, '/api/data', 'POST', { action: 'saveSettings', settings: { verifierKey: 'mvkey', googleClientId: 'cid.apps', googleClientSecret: 'sec', mailingAddress: 'PO Box 1, Austin TX', dailyCap: 3 } });
  await call(data.POST, '/api/data', 'POST', { action: 'saveTemplate', template: { id: 'first-touch', name: 'First email', kind: 'first', subject: 'Quick question about {company}', body: 'Hi {first_name},\n\nShort intro.' } });
  assert.equal(r.status, 200); assert.equal(r.j.data.settings.verifier.hasKey, true);
  assert.ok(!JSON.stringify(r.j.data).includes('mvkey'), 'secret must not leak');
  await call(data.POST, '/api/data', 'POST', { action: 'addSuppression', emails: ['old@volv.com'], domains: ['contacted.com'] });

  // history import (Volvera)
  r = await call(imp.POST, '/api/import', 'POST', { mode: 'history', rows: [{ company: 'Prev Co', email: 'owner@prevco.com', status: 'contacted', externalId: 'atx-1', history: [{ type: 'email_sent', kind: 'first', t: Date.now() - 864e5 * 5, extId: 'atx-1-s' }] }] });
  assert.equal(r.j.added, 1);

  // import mix
  r = await call(imp.POST, '/api/import', 'POST', { candidates: [
    { company: 'Good Co', firstName: 'Ann', email: 'ann@goodco.com', phone: '512-555-0101', website: 'goodco.com' },
    { company: 'Good Co dup', firstName: 'Bob', email: 'bob@goodco.com' },
    { company: 'Role Co', email: 'info@roleco.com' },
    { company: 'Dead', email: 'x@dead.com' },
    { company: 'Catch', email: 'catch@catch.com' },
    { company: 'Real', email: 'nobody@real.com' },
    { company: 'Prev again', email: 'someone@prevco.com' },
    { company: 'Contacted', email: 'z@contacted.com' },
    { company: 'Bad', email: 'not-an-email' },
    { company: 'Gmail Co', firstName: 'Cy', email: 'cy.owner@gmail.com' },
    { company: 'Third Co', firstName: 'Di', email: 'di@third.com' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const byEmail = Object.fromEntries(r.j.results.map((x) => [x.email, x]));
  assert.equal(byEmail['ann@goodco.com'].added, true);
  assert.equal(byEmail['bob@goodco.com'].added, false);
  assert.match(byEmail['info@roleco.com'].reason, /Generic/);
  assert.match(byEmail['x@dead.com'].reason, /no mail server/);
  assert.match(byEmail['catch@catch.com'].reason, /Catch-all/);
  assert.match(byEmail['nobody@real.com'].reason, /does not exist/);
  assert.match(byEmail['someone@prevco.com'].reason, /already contacted/);
  assert.match(byEmail['z@contacted.com'].reason, /already contacted/);
  assert.equal(byEmail['cy.owner@gmail.com'].added, true);
  assert.equal(r.j.added, 3);
  d = (await call(data.GET, '/api/data')).j;
  const ann = d.leads.find((l) => l.email === 'ann@goodco.com');
  assert.equal(ann.verification.status, 'valid');

  // a template with a non-merge placeholder never ships
  await call(data.POST, '/api/data', 'POST', { action: 'saveSettings', settings: { fromName: 'Test Sender', signature: 'Test Sender' } });
  await call(data.POST, '/api/data', 'POST', { action: 'saveTemplate', template: { id: 'first-touch', name: 'First email', kind: 'first', subject: 'Quick question about {company}', body: 'Hi {first_name}, I noticed {specific detail about their business}. How do you handle {task}?' } });
  r = await call(send.POST, '/api/send', 'POST', { leadId: ann.id, templateId: 'first-touch' });
  assert.match(r.j.error, /unfilled text: \{specific detail about their business\}, \{task\}/);
  await call(data.POST, '/api/data', 'POST', { action: 'saveTemplate', template: { id: 'first-touch', name: 'First email', kind: 'first', subject: 'Quick question about {company}', body: 'Hi {first_name},\n\nShort intro about {task}.' } });
  await call(data.POST, '/api/data', 'POST', { action: 'updateLead', id: ann.id, patch: { task: 'after-hours calls' } });
  await call(data.POST, '/api/data', 'POST', { action: 'saveSettings', settings: { fromName: '', signature: '' } });
  // blocked until sender identity is set
  r = await call(send.POST, '/api/send', 'POST', { leadId: ann.id, templateId: 'first-touch' });
  assert.equal(r.status, 409); assert.match(r.j.error, /From name and signature/);
  await call(data.POST, '/api/data', 'POST', { action: 'saveSettings', settings: { fromName: 'Test Sender', signature: 'Test Sender' } });
  // send before gmail connected
  r = await call(send.POST, '/api/send', 'POST', { leadId: ann.id, templateId: 'first-touch' });
  assert.equal(r.status, 409); assert.match(r.j.error, /Gmail is not connected/);
  d = (await call(data.GET, '/api/data')).j;
  assert.ok(!d.leads.find((l) => l.id === ann.id).sending, 'lock released');

  // OAuth start + callback
  let g = await google.GET(req('/api/google'));
  assert.equal(g.status, 302);
  const loc = new URL(g.headers.get('location'));
  assert.equal(loc.host, 'accounts.google.com');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://app.test/api/google');
  const state = loc.searchParams.get('state');
  const oauthCookie = g.headers.get('set-cookie').split(';')[0];
  const saved = cookie; cookie = `${saved}; ${oauthCookie}`;
  g = await google.GET(req(`/api/google?code=abc&state=${state}`));
  cookie = saved;
  assert.match(g.headers.get('location'), /gmail=ok/);
  d = (await call(data.GET, '/api/data')).j;
  assert.equal(d.gmail.connected, true); assert.equal(d.gmail.email, 'adigold21@gmail.com');

  // send first email
  r = await call(send.POST, '/api/send', 'POST', { leadId: ann.id, templateId: 'first-touch' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.lead.status, 'contacted');
  const mime = Buffer.from(sentRaw[0].raw, 'base64url').toString();
  assert.match(mime, /To: ann@goodco.com/); assert.match(mime, /Subject: Quick question about Good Co/);
  const bodyText = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
  assert.match(bodyText, /^Hi Ann,/); assert.match(bodyText, /Short intro about after-hours calls\./); assert.doesNotMatch(bodyText, /PO Box 1/); assert.doesNotMatch(bodyText, /unsubscribe/i);
  // duplicate first send blocked
  r = await call(send.POST, '/api/send', 'POST', { leadId: ann.id, templateId: 'first-touch' });
  assert.equal(r.status, 409); assert.match(r.j.error, /already sent/);
  // follow-up threads correctly
  r = await call(send.POST, '/api/send', 'POST', { leadId: ann.id, templateId: 'follow-up' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(sentRaw[1].threadId, 't1');
  assert.match(Buffer.from(sentRaw[1].raw, 'base64url').toString(), /In-Reply-To: <m1@mail.gmail.com>/);
  // max follow-ups
  r = await call(send.POST, '/api/send', 'POST', { leadId: ann.id, templateId: 'follow-up' });
  assert.equal(r.status, 409);
  // cap = 3
  const cy = d.leads.find((l) => l.email === 'cy.owner@gmail.com');
  const di = d.leads.find((l) => l.email === 'di@third.com');
  r = await call(send.POST, '/api/send', 'POST', { leadId: cy.id, templateId: 'first-touch' });
  assert.match(r.j.error, /unfilled text: \{task\}/);
  for (const x of [cy, di]) await call(data.POST, '/api/data', 'POST', { action: 'updateLead', id: x.id, patch: { task: 'booking' } });
  r = await call(send.POST, '/api/send', 'POST', { leadId: cy.id, templateId: 'first-touch' });
  assert.equal(r.status, 200);
  r = await call(send.POST, '/api/send', 'POST', { leadId: di.id, templateId: 'first-touch' });
  assert.equal(r.status, 429, JSON.stringify(r.j));
  // unverified (history) lead blocked
  const prev = d.leads.find((l) => l.email === 'owner@prevco.com');
  r = await call(send.POST, '/api/send', 'POST', { leadId: prev.id, templateId: 'follow-up' });
  assert.equal(r.status, 409); assert.match(r.j.error, /not verified/);

  // replies, bounce, opt-out via sync (cron)
  inbox = [
    { id: 'r1', threadId: 't1', snippet: 'Sure, call me Tuesday', headers: [{ name: 'From', value: 'Ann <ann@goodco.com>' }, { name: 'Subject', value: 'Re: Quick question' }] },
    { id: 'b1', threadId: 'zz', bounce: true, snippet: 'Address not found cy.owner@gmail.com', headers: [{ name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, { name: 'X-Failed-Recipients', value: 'cy.owner@gmail.com' }, { name: 'Subject', value: 'Delivery Status Notification (Failure)' }] },
  ];
  assert.equal((await sync.GET(new Request('https://app.test/api/sync?cron=1'))).status, 401);
  const sr = await sync.GET(new Request('https://app.test/api/sync?cron=1', { headers: { authorization: 'Bearer cron123' } }));
  const sj = await sr.json();
  assert.equal(sj.sync.reply, 1, JSON.stringify(sj)); assert.equal(sj.sync.bounce, 1);
  d = (await call(data.GET, '/api/data')).j;
  assert.equal(d.leads.find((l) => l.id === ann.id).status, 'replied');
  assert.equal(d.leads.find((l) => l.id === ann.id).needsResponse, true);
  assert.equal(d.leads.find((l) => l.id === cy.id).status, 'bounced');
  // second sync is idempotent
  const sj2 = await (await sync.POST(req('/api/sync', 'POST'))).json();
  assert.equal(sj2.sync.reply, 0);

  // call logging + pipeline
  r = await call(data.POST, '/api/data', 'POST', { action: 'logCall', id: di.id, outcome: 'booked', note: 'Tue 3pm' });
  assert.equal(r.j.data.leads.find((l) => l.id === di.id).status, 'meeting');
  r = await call(data.POST, '/api/data', 'POST', { action: 'setStatus', id: di.id, status: 'client' });
  assert.ok(r.j.data.leads.find((l) => l.id === di.id).client);

  // concurrent writes don't lose data
  await Promise.all(Array.from({ length: 6 }, (_, i) => call(data.POST, '/api/data', 'POST', { action: 'addNote', id: di.id, text: `n${i}` })));
  d = (await call(data.GET, '/api/data')).j;
  assert.equal(d.leads.find((l) => l.id === di.id).history.filter((h) => h.type === 'note').length, 6);
  // verified mode: pre-checked rows still go through duplicate, exclusion and MX checks
  r = await call(imp.POST, '/api/import', 'POST', { mode: 'verified', candidates: [{ company: 'NoProof', email: 'a@noproof.com' }] });
  assert.equal(r.status, 400);
  r = await call(imp.POST, '/api/import', 'POST', { mode: 'verified', candidates: [
    { company: 'Pre Co', firstName: 'Pat', email: 'pat@preco.com', verifiedBy: 'apollo-leadmagic', verifiedReason: 'validated' },
    { company: 'Dead Pre', email: 'x@dead.com', verifiedBy: 'apollo-leadmagic', verifiedReason: 'validated' },
    { company: 'Good Co again', email: 'other@goodco.com', verifiedBy: 'apollo-leadmagic', verifiedReason: 'validated' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.results.map((x) => x.added), [true, false, false]);
  d = (await call(data.GET, '/api/data')).j;
  assert.equal(d.leads.find((l) => l.email === 'pat@preco.com').verification.provider, 'apollo-leadmagic');
  // seed mode reads the bundled research leads in slices
  r = await call(imp.POST, '/api/import', 'POST', { mode: 'seed', offset: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(r.j.seedTotal >= 100, 'seed file bundled');
  assert.ok(r.j.results.length > 0 && r.j.results.length <= 25);
  console.log('emails sent in test:', sentRaw.length);
});

test('sammy sections are manual-only, verifyBatch updates leads', async () => {
  const { readyForFirst, dueFollowUps } = await import(`${P}/lib/outreach.js`);
  await call(data.POST, '/api/data', 'POST', { action: 'saveSettings', settings: { dailyCap: 50, autopilot: { enabled: true, firstTouchPerDay: 20, includeFollowUps: true } } });
  let r = await call(imp.POST, '/api/import', 'POST', { candidates: [
    { company: 'Brother Co', firstName: 'Sam', email: 'sam@brotherco.com', section: 'sammy-ut', draftSubject: 'Fellow Sammy at UT', draftBody: 'Hi Sam,\n\nPersonal note for Sam.' },
    { company: 'Other Chapter LLC', firstName: 'Oz', email: 'oz@otherchapter.com', section: 'sammy-other', draftSubject: 'Sammy to Sammy', draftBody: 'Hi Oz,\n\nNote for Oz.' },
    { company: 'Main Biz', firstName: 'Mo', email: 'mo@mainbiz.com', task: 'calls' },
    { company: 'Longhorn Co', firstName: 'Lu', email: 'lu@longhornco.com', section: 'ut-alumni', draftSubject: 'Fellow Longhorn', draftBody: 'Hi Lu,\n\nNote.' },
  ] });
  assert.equal(r.j.added, 4, JSON.stringify(r.j));
  let d = (await call(data.GET, '/api/data')).j;
  const sam = d.leads.find((l) => l.email === 'sam@brotherco.com');
  const oz = d.leads.find((l) => l.email === 'oz@otherchapter.com');
  const mo = d.leads.find((l) => l.email === 'mo@mainbiz.com');
  assert.equal(sam.section, 'sammy-ut'); assert.equal(oz.section, 'sammy-other'); assert.equal(mo.section, 'main');
  assert.equal(sam.draft.subject, 'Fellow Sammy at UT');

  // autopilot / batch queues never include Sammy leads
  const { loadDb } = await import(`${P}/lib/db.js`);
  const { db } = await loadDb();
  const ready = readyForFirst(db).map((l) => l.email);
  assert.ok(ready.includes('mo@mainbiz.com'));
  assert.ok(!ready.includes('sam@brotherco.com') && !ready.includes('oz@otherchapter.com') && !ready.includes('lu@longhornco.com'));
  assert.ok(!dueFollowUps(db, Date.now() + 1e12).some((l) => l.section && l.section !== 'main'));

  // a send without the explicit manual confirmation is refused, with or without the draft
  r = await call(send.POST, '/api/send', 'POST', { leadId: sam.id, templateId: 'first-touch' });
  assert.equal(r.status, 409); assert.match(r.j.error, /Manual-only/);
  r = await call(send.POST, '/api/send', 'POST', { leadId: sam.id, useDraft: true });
  assert.equal(r.status, 409); assert.match(r.j.error, /Manual-only/);

  // manual send of the personal draft works and adds the signature
  const before = sentRaw.length;
  r = await call(send.POST, '/api/send', 'POST', { leadId: sam.id, useDraft: true, manualConfirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const mime = Buffer.from(sentRaw[before].raw, 'base64url').toString();
  assert.match(mime, /Subject: Fellow Sammy at UT/);
  const bodyText = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
  assert.match(bodyText, /Personal note for Sam\./); assert.match(bodyText, /Test Sender/);

  // autopilot run (cron) never touches oz
  await sync.GET(new Request('https://app.test/api/sync?cron=1', { headers: { authorization: 'Bearer cron123' } }));
  d = (await call(data.GET, '/api/data')).j;
  assert.ok(!d.leads.find((l) => l.id === oz.id).history.some((h) => h.type === 'email_sent'), 'autopilot must skip sammy');

  // verifyBatch updates unverified leads
  const { mutateDb } = await import(`${P}/lib/db.js`);
  await mutateDb((x) => { const l = x.leads.find((y) => y.id === oz.id); l.verification = { status: 'unverified', reason: 'test', checkedAt: 0 }; });
  r = await call(data.POST, '/api/data', 'POST', { action: 'verifyBatch', ids: [oz.id] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.results[0].ok, true);
  d = (await call(data.GET, '/api/data')).j;
  assert.equal(d.leads.find((l) => l.id === oz.id).verification.status, 'valid');

  // section can be changed from the lead panel
  r = await call(data.POST, '/api/data', 'POST', { action: 'updateLead', id: mo.id, patch: { section: 'sammy-other' } });
  assert.equal(r.j.data.leads.find((l) => l.id === mo.id).section, 'sammy-other');
});
