// Adi Outreach — single-page front end (no build step).
const root = document.getElementById('root');
const TZ = 'America/Chicago';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s);
const unent = (s) => { const t = document.createElement('textarea'); t.innerHTML = String(s ?? ''); return t.value; };
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let D = null;
const UI = {
  q: '', status: 'all', verif: 'all', section: 'all', limit: 200, verifying: null,
  dialFilter: 'new', dialIndex: 0, dialNote: '',
  lead: null, batch: null, tplId: null, range: 7,
  csvRows: null, csvMap: null, importing: false, importResults: [], importStop: false,
  flash: null,
};

const SECTIONS = { main: 'Main', 'sammy-ut': 'Sammy alumni: UT Austin', 'sammy-other': 'Sammy alumni: other chapters', 'ut-alumni': 'UT Austin alumni (general)' };
const MANUAL = new Set(['sammy-ut', 'sammy-other', 'ut-alumni']);
const secOf = (l) => (l.section in SECTIONS ? l.section : 'main');
const manualOnly = (l) => MANUAL.has(secOf(l));
const STATUS_LABEL = { new: 'New', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting', client: 'Client', lost: 'Lost', bounced: 'Bounced', do_not_contact: 'Do not contact' };
const BOARD = ['new', 'contacted', 'replied', 'meeting', 'client', 'lost'];
const OUTCOMES = [
  ['no_answer', 'No answer'], ['voicemail', 'Voicemail'], ['talked', 'Talked'], ['booked', 'Booked meeting'],
  ['call_back', 'Call back'], ['not_interested', 'Not interested'], ['wrong_number', 'Wrong number'],
];

// ---------- helpers ----------
const dayKey = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
function ago(t) {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 0) { const d = Math.ceil(-s / 86400); return d <= 1 ? 'today' : `in ${d}d`; }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const when = (t) => new Date(t).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pill = (s) => `<span class="pill ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
function vpill(l) {
  const v = l.verification?.status || 'unverified';
  const label = v === 'valid' ? 'Verified' : v === 'rejected' ? 'Failed check' : 'Not verified';
  return `<span class="pill ${esc(v)}" title="${esc(l.verification?.reason || '')}">${label}</span>`;
}
const person = (l) => [l.firstName, l.lastName].filter(Boolean).join(' ');
const sent = (l) => (l.history || []).filter((h) => h.type === 'email_sent');
const replied = (l) => (l.history || []).some((h) => h.type === 'reply');
const lastTouch = (l) => Math.max(0, ...(l.history || []).filter((h) => ['email_sent', 'call', 'reply'].includes(h.type)).map((h) => h.t));
const tplFirst = () => D.templates.find((t) => t.kind === 'first') || D.templates[0];
const tplFollow = () => D.templates.find((t) => t.kind === 'followup');

function renderTpl(t, l) {
  const s = D.settings;
  const vars = { first_name: (l.firstName || '').trim() || 'there', last_name: l.lastName || '', company: l.company || 'your business', city: l.city || '', industry: l.industry || '', title: l.title || '', my_name: s.fromName || '', detail: (l.detail || '').trim(), task: (l.task || '').trim() };
  const fill = (x) => String(x || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] !== '' ? vars[k] : m));
  return { subject: fill(t.subject), body: `${fill(t.body).trim()}\n\n${(s.signature || '').trim()}` };
}

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 401) { D = null; renderLogin(); throw Object.assign(new Error('Signed out'), { status: 401 }); }
  if (!r.ok || j.ok === false) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
  return j;
}
async function act(action, payload = {}, quiet = false) {
  try {
    const j = await api('/api/data', { method: 'POST', body: { action, ...payload } });
    if (j.data) D = j.data;
    render();
    if (!quiet) toast('Saved');
    return j;
  } catch (e) { if (e.status !== 401) toast(e.message, true); throw e; }
}
async function refresh() { D = await api('/api/data'); render(); }

// Derived lists
const isDueFollow = (l) => !manualOnly(l) && l.status === 'contacted' && l.nextFollowUpAt && l.nextFollowUpAt <= Date.now() && !replied(l) && sent(l).filter((h) => h.kind === 'followup').length < (D.settings.maxFollowUps ?? 1) && !l.sendUnknown;
const isReady = (l) => !manualOnly(l) && l.status === 'new' && l.verification?.status === 'valid' && !sent(l).length && !l.sendUnknown;

// ---------- login ----------
async function boot() {
  const s = await fetch('/api/session').then((r) => r.json()).catch(() => ({}));
  if (!s.secretSet || !s.passcodeSet) {
    root.innerHTML = `<div class="login card"><h1>Almost ready</h1><p class="sub">This app needs ${!s.passcodeSet ? '<b>APP_PASSCODE</b>' : ''}${!s.passcodeSet && !s.secretSet ? ' and ' : ''}${!s.secretSet ? '<b>APP_SECRET</b>' : ''} set in Vercel → Project → Settings → Environment Variables, then a redeploy.</p></div>`;
    return;
  }
  if (!s.authed) return renderLogin();
  await refresh();
  syncQuietly();
}
function renderLogin() {
  root.innerHTML = `<form class="login card" id="login"><h1>Outreach</h1><p class="sub">Enter your passcode.</p>
    <input type="password" id="pass" autocomplete="current-password" autofocus><div class="row" style="margin-top:12px"><button class="btn primary">Sign in</button></div></form>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/session', { method: 'POST', body: { passcode: $('#pass').value } }); await refresh(); syncQuietly(); } catch (err) { toast(err.message, true); }
  };
}
async function syncQuietly() {
  if (!D?.gmail?.connected) return;
  if (Date.now() - (D.sync?.lastSyncAt || 0) < 5 * 60 * 1000) return;
  try {
    const r = await api('/api/sync', { method: 'POST' });
    const s = r.sync || {};
    await refresh();
    const n = (s.reply || 0) + (s.bounce || 0) + (s.opt_out || 0);
    if (n) toast(`Inbox checked: ${s.reply || 0} new repl${s.reply === 1 ? 'y' : 'ies'}${s.bounce ? `, ${s.bounce} bounce${s.bounce > 1 ? 's' : ''}` : ''}${s.opt_out ? `, ${s.opt_out} unsubscribe` : ''}`);
  } catch (e) { if (e.status !== 401) console.warn(e); }
}

// ---------- shell ----------
function route() {
  const h = (location.hash || '#today').slice(1);
  const [name, qs] = h.split('?');
  return { name: name || 'today', params: new URLSearchParams(qs || '') };
}
function render() {
  if (!D) return;
  const { name } = route();
  const replies = D.leads.filter((l) => l.needsResponse).length;
  const views = { today: vToday, dialer: vDialer, leads: vLeads, pipeline: vPipeline, results: vResults, clients: vClients, templates: vTemplates, import: vImport, settings: vSettings };
  const nav = [['today', 'Today', replies], ['dialer', 'Dialer'], ['leads', 'Leads'], ['pipeline', 'Pipeline'], ['results', 'Results'], ['clients', 'Clients'], ['templates', 'Templates'], ['import', 'Import'], ['settings', 'Settings']];
  const scroll = $('main')?.scrollTop;
  root.innerHTML = `<div class="app">
    <nav class="side"><div class="brand">${esc(D.settings.fromName ? D.settings.fromName.split(" ")[0] + " Outreach" : "Outreach")}<small>${esc(D.gmail.connected ? D.gmail.email : 'Gmail not connected')}</small></div>
      ${nav.map(([k, label, c]) => `<a href="#${k}" class="${name === k ? 'on' : ''}">${label}${c ? `<span class="count">${c}</span>` : ''}</a>`).join('')}
      <div class="foot">${D.sentToday}/${D.settings.dailyCap} emails today<br>Inbox checked ${ago(D.sync?.lastSyncAt)}</div>
    </nav>
    <main>${(views[name] || vToday)()}</main></div>
    ${UI.lead ? drawer() : ''}`;
  if (scroll) $('main').scrollTop = scroll;
  after(name);
}
window.addEventListener('hashchange', () => { UI.flash = null; render(); window.scrollTo(0, 0); });

// ---------- Today ----------
function setupChecklist() {
  const items = [
    [D.gmail.connected, 'Connect Gmail (adigold21@gmail.com)', '#settings'],
    [D.settings.verifier.hasKey, 'Add your email verification API key', '#settings'],
    [D.leads.length > 0, 'Import leads', '#import'],
  ];
  if (items.every((i) => i[0])) return '';
  return `<div class="card"><h2>Finish setup</h2><ul class="list">${items.map(([ok, label, href]) => `<li><span>${ok ? '✓' : '○'}</span><div class="main">${ok ? `<span class="muted">${label}</span>` : `<a href="${href}">${label}</a>`}</div></li>`).join('')}</ul></div>`;
}
function vToday() {
  if (D.gmail.broken) UI.flash ||= ['bad', 'Google signed this app out of Gmail. Reconnect it in Settings to keep sending and tracking replies.'];
  const today = dayKey();
  const calls = D.leads.reduce((n, l) => n + (l.history || []).filter((h) => h.type === 'call' && dayKey(h.t) === today).length, 0);
  const needs = D.leads.filter((l) => l.needsResponse).sort((a, b) => lastTouch(b) - lastTouch(a));
  const due = D.leads.filter(isDueFollow);
  const ready = D.leads.filter(isReady);
  const callbacks = D.leads.filter((l) => l.callbackAt && l.callbackAt <= Date.now() + 864e5 && !['client', 'lost', 'do_not_contact'].includes(l.status));
  const unknown = D.leads.filter((l) => l.sendUnknown);
  const left = Math.max(0, D.settings.dailyCap - D.sentToday);
  const events = [];
  for (const l of D.leads) for (const h of l.history || []) if (['email_sent', 'reply', 'call', 'bounce', 'status'].includes(h.type) && !(h.type === 'status' && h.auto)) events.push({ l, h });
  events.sort((a, b) => b.h.t - a.h.t);
  const b = UI.batch;
  return `<h1>Today</h1><p class="sub">${new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' })}</p>
  ${flash()}
  ${unknown.length ? `<div class="notice warn">${unknown.length} send${unknown.length > 1 ? 's' : ''} may or may not have gone out. Open ${unknown.map((l) => `<a href="#" data-lead="${l.id}">${esc(l.company)}</a>`).join(', ')} and confirm against Gmail Sent.</div>` : ''}
  <div class="kpis">
    <div class="kpi"><div class="n">${D.sentToday}<span class="muted" style="font-size:15px"> / ${D.settings.dailyCap}</span></div><div class="l">Emails sent today</div></div>
    <div class="kpi"><div class="n">${needs.length}</div><div class="l">Replies to answer</div></div>
    <div class="kpi"><div class="n">${due.length}</div><div class="l">Follow-ups due</div></div>
    <div class="kpi"><div class="n">${calls}</div><div class="l">Calls today</div></div>
    <div class="kpi"><div class="n">${ready.length}</div><div class="l">Verified, not yet emailed</div></div>
  </div>
  ${setupChecklist()}
  <div class="grid g2">
    <div>
      <div class="card"><h2>Replies to answer</h2>${needs.length ? `<ul class="list">${needs.slice(0, 12).map((l) => {
        const r = [...l.history].reverse().find((h) => h.type === 'reply');
        return `<li><div class="main"><a href="#" data-lead="${l.id}"><b>${esc(l.company)}</b></a> <span class="muted">${esc(person(l))}</span><div class="muted small clip">${esc(unent(r?.snippet || ''))}</div></div><span class="muted small">${ago(r?.at || r?.t)}</span></li>`;
      }).join('')}</ul>` : '<div class="empty">No unanswered replies. Replies are pulled from Gmail automatically.</div>'}</div>
      <div class="card"><div class="row"><h2 style="margin:0">Send emails</h2><span class="spacer"></span><span class="muted small">${left} left today</span></div>
        ${b ? batchView() : `
        <p class="muted small" style="margin:6px 0 12px">Sends one at a time with a short random pause, the way a person would. Follow-ups go first, in the original thread.</p>
        <div class="row"><button class="btn" data-act="batch" data-kind="follow" ${due.length && left && tplFollow() ? '' : 'disabled'}>Send ${Math.min(due.length, left)} follow-up${Math.min(due.length, left) === 1 ? '' : 's'}</button>
        <span class="muted">or</span>
        <input type="number" id="batchN" min="1" max="${left}" value="${Math.min(ready.length, left, 30)}" style="width:80px">
        <button class="btn primary" data-act="batch" data-kind="first" ${ready.length && left ? '' : 'disabled'}>Send first emails</button></div>
        ${!D.gmail.connected ? '<p class="muted small">Connect Gmail in Settings to send.</p>' : ''}`}
      </div>
    </div>
    <div>
      <div class="card"><h2>Follow-ups due</h2>${due.length ? `<ul class="list">${due.slice(0, 10).map((l) => `<li><div class="main"><a href="#" data-lead="${l.id}"><b>${esc(l.company)}</b></a> <span class="muted">${esc(person(l))}</span></div><span class="muted small">emailed ${ago(l.lastContactAt)}</span></li>`).join('')}</ul>${due.length > 10 ? `<div class="muted small">+${due.length - 10} more</div>` : ''}` : '<div class="empty">Nothing due. Follow-ups come up ' + D.settings.followUpDays + ' business days after the first email if there is no reply.</div>'}</div>
      ${callbacks.length ? `<div class="card"><h2>Call backs</h2><ul class="list">${callbacks.map((l) => `<li><div class="main"><a href="#" data-lead="${l.id}"><b>${esc(l.company)}</b></a> <span class="muted">${esc(l.phone || '')}</span></div><span class="muted small">${ago(l.callbackAt)}</span></li>`).join('')}</ul></div>` : ''}
      <div class="card"><h2>Recent activity</h2>${events.length ? `<ul class="list">${events.slice(0, 14).map(({ l, h }) => `<li><div class="main clip">${evText(h)} · <a href="#" data-lead="${l.id}">${esc(l.company)}</a></div><span class="muted small">${ago(h.t)}</span></li>`).join('')}</ul>` : '<div class="empty">Activity shows up here as you email and call.</div>'}</div>
    </div>
  </div>`;
}
function evText(h) {
  switch (h.type) {
    case 'email_sent': return h.kind === 'followup' ? 'Follow-up sent' : 'Email sent';
    case 'reply': return h.optOut ? 'Unsubscribed' : 'Reply received';
    case 'auto_reply': return 'Auto-reply';
    case 'bounce': return 'Bounced';
    case 'call': return `Call: ${(OUTCOMES.find((o) => o[0] === h.outcome) || [0, h.outcome])[1]}`;
    case 'status': return `Moved to ${STATUS_LABEL[h.to] || h.to}`;
    case 'note': return 'Note';
    case 'verified': return h.result === 'valid' ? 'Email verified' : 'Email failed verification';
    case 'imported': return 'Added';
    case 'send_failed': return 'Send failed';
    case 'responded': return 'Marked as answered';
    default: return h.type;
  }
}
function flash() {
  if (!UI.flash) return '';
  return `<div class="notice ${UI.flash[0]}">${esc(UI.flash[1])}</div>`;
}
function batchView() {
  const b = UI.batch;
  const pct = Math.round((b.i / b.queue.length) * 100);
  return `<div style="margin-top:10px"><div class="row"><b>${b.done ? 'Finished' : 'Sending'}</b><span class="muted">${b.sent} sent${b.failed ? `, ${b.failed} skipped` : ''} of ${b.queue.length}</span><span class="spacer"></span>
    ${b.done ? '<button class="btn small" data-act="batchClose">Close</button>' : '<button class="btn small" data-act="batchStop">Stop</button>'}</div>
    <div class="progress" style="margin:8px 0"><div style="width:${pct}%"></div></div>
    <div class="muted small">${esc(b.status || '')}</div>
    ${b.log.length ? `<ul class="list small" style="max-height:180px;overflow:auto">${b.log.slice().reverse().map((x) => `<li><span>${x.ok ? '✓' : '✕'}</span><div class="main clip">${esc(x.company)}${x.ok ? '' : ` <span class="muted">— ${esc(x.err)}</span>`}</div></li>`).join('')}</ul>` : ''}</div>`;
}
async function runBatch(kind) {
  const left = Math.max(0, D.settings.dailyCap - D.sentToday);
  let queue;
  if (kind === 'follow') queue = D.leads.filter(isDueFollow).slice(0, left).map((l) => ({ leadId: l.id, templateId: tplFollow().id, company: l.company }));
  else {
    const n = Math.max(1, Math.min(left, Number($('#batchN')?.value) || 0));
    queue = D.leads.filter(isReady).slice(0, n).map((l) => ({ leadId: l.id, templateId: tplFirst().id, company: l.company }));
  }
  if (!queue.length) return;
  if (!confirm(`Send ${queue.length} email${queue.length > 1 ? 's' : ''} from ${D.gmail.email || 'Gmail'}? Keep this tab open until it finishes.`)) return;
  UI.batch = { queue, i: 0, sent: 0, failed: 0, log: [], stop: false, done: false, status: '' };
  render();
  for (const item of queue) {
    const b = UI.batch;
    if (!b || b.stop) break;
    b.status = `Sending to ${item.company}…`; if (route().name === 'today') render();
    try {
      const r = await api('/api/send', { method: 'POST', body: { leadId: item.leadId, templateId: item.templateId } });
      const i = D.leads.findIndex((l) => l.id === item.leadId); if (i >= 0) D.leads[i] = r.lead;
      D.sentToday = r.sentToday; b.sent++; b.log.push({ ok: true, company: item.company });
    } catch (e) {
      b.failed++; b.log.push({ ok: false, company: item.company, err: e.message });
      if (e.status === 429 || e.status === 401 || /Gmail is not connected|signed this app out|mailing address/.test(e.message)) { b.status = e.message; break; }
    }
    b.i++;
    if (b.i < queue.length && !b.stop) {
      const wait = 8 + Math.floor(Math.random() * 8);
      for (let s = wait; s > 0 && !b.stop; s--) { b.status = `Next email in ${s}s`; if (route().name === 'today') render(); await new Promise((r) => setTimeout(r, 1000)); }
    }
  }
  if (UI.batch) { UI.batch.done = true; UI.batch.i = UI.batch.queue.length; UI.batch.status = UI.batch.stop ? 'Stopped.' : (UI.batch.status.startsWith('Next') || UI.batch.status.startsWith('Sending') ? 'Done.' : UI.batch.status); }
  await refresh();
}

// ---------- Dialer ----------
function dialList() {
  const f = UI.dialFilter;
  const hasPhone = (l) => l.phone && !l.phoneBad && !['client', 'lost', 'do_not_contact'].includes(l.status);
  const notCalledToday = (l) => !l.lastCallAt || dayKey(l.lastCallAt) !== dayKey();
  let list = D.leads.filter(hasPhone);
  if (f === 'new') list = list.filter((l) => l.status === 'new' && notCalledToday(l));
  if (f === 'emailed') list = list.filter((l) => l.status === 'contacted' && !replied(l) && notCalledToday(l));
  if (f === 'callbacks') list = list.filter((l) => l.callbackAt && l.callbackAt <= Date.now() + 864e5);
  if (f === 'engaged') list = list.filter((l) => ['replied', 'meeting'].includes(l.status));
  return list;
}
function vDialer() {
  const list = dialList();
  if (UI.dialIndex >= list.length) UI.dialIndex = Math.max(0, list.length - 1);
  const l = list[UI.dialIndex];
  const filters = [['new', 'New leads'], ['emailed', 'Emailed, no reply'], ['callbacks', 'Call backs'], ['engaged', 'Replied / meeting'], ['all', 'Everyone with a phone']];
  return `<h1>Dialer</h1><p class="sub">Work through calls one lead at a time. Press 1–7 to log the outcome.</p>
  <div class="row" style="margin-bottom:14px"><select id="dialFilter" style="width:auto">${filters.map(([k, v]) => `<option value="${k}" ${UI.dialFilter === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <span class="muted">${list.length ? `${UI.dialIndex + 1} of ${list.length}` : ''}</span></div>
  ${!l ? '<div class="card empty">No one in this queue.</div>' : `
  <div class="card dial">
    <div class="row"><div><h1>${esc(l.company)}</h1><div class="muted">${esc([person(l), l.title].filter(Boolean).join(', '))}${l.city ? ` · ${esc(l.city)}${l.state ? `, ${esc(l.state)}` : ''}` : ''}</div></div><span class="spacer"></span>${pill(l.status)}</div>
    <div class="row" style="margin:16px 0"><a class="phone" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a><a class="btn primary" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">Call</a>
      ${l.website ? `<a class="btn" href="${esc(/^https?:/.test(l.website) ? l.website : `https://${l.website}`)}" target="_blank" rel="noopener">Website</a>` : ''}
      <button class="btn" data-lead="${l.id}">Open lead</button></div>
    <div class="muted small">${l.email ? `${esc(l.email)} ${vpill(l)}` : 'No email'} · ${l.callCount ? `called ${l.callCount}×, last ${ago(l.lastCallAt)}` : 'never called'} · ${sent(l).length ? `emailed ${ago(sent(l).at(-1).t)}` : 'not emailed'}</div>
    ${l.notes ? `<div class="preview" style="margin-top:10px">${esc(l.notes)}</div>` : ''}
    <label>Call note</label><textarea id="dialNote" placeholder="What happened, who to ask for, best time…">${esc(UI.dialNote)}</textarea>
    <div id="cbWrap" style="display:none"><label>Call back on</label><input type="datetime-local" id="cbAt"></div>
    <label>Outcome</label>
    <div class="outcomes">${OUTCOMES.map(([k, v], i) => `<button class="btn" data-act="dialOutcome" data-outcome="${k}">${v}<kbd>${i + 1}</kbd></button>`).join('')}</div>
    <div class="row" style="margin-top:14px"><button class="btn" data-act="dialPrev" ${UI.dialIndex ? '' : 'disabled'}>← Previous</button><span class="spacer"></span><button class="btn" data-act="dialSkip">Skip →</button></div>
    ${(l.history || []).length ? `<div class="section"><h2>History</h2>${timeline(l, 5)}</div>` : ''}
  </div>`}`;
}
async function dialOutcome(outcome) {
  const list = dialList(); const l = list[UI.dialIndex];
  if (!l) return;
  const payload = { id: l.id, outcome, note: $('#dialNote')?.value || '' };
  if (outcome === 'call_back') {
    const wrap = $('#cbWrap');
    if (wrap.style.display === 'none') { wrap.style.display = 'block'; $('#cbAt').focus(); toast('Pick a time, then press Call back again'); return; }
    const v = $('#cbAt').value; if (!v) return toast('Pick a call-back time', true);
    payload.callbackAt = new Date(v).getTime();
  }
  UI.dialNote = '';
  const before = list.length;
  await act('logCall', payload, true);
  toast(`Logged: ${OUTCOMES.find((o) => o[0] === outcome)[1]}`);
  if (dialList().length >= before) UI.dialIndex++;
  render();
}

// ---------- Leads ----------
function filteredLeads() {
  const q = UI.q.trim().toLowerCase();
  return D.leads.filter((l) => {
    if (UI.status !== 'all' && l.status !== UI.status) return false;
    if (UI.verif !== 'all' && (l.verification?.status || 'unverified') !== UI.verif) return false;
    if (UI.section !== 'all' && secOf(l) !== UI.section) return false;
    if (!q) return true;
    return [l.company, l.firstName, l.lastName, l.email, l.phone, l.city, l.industry, l.title].some((v) => (v || '').toLowerCase().includes(q));
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function vLeads() {
  const list = filteredLeads();
  const counts = {}; for (const l of D.leads) counts[l.status] = (counts[l.status] || 0) + 1;
  const secCount = {}; for (const l of D.leads) secCount[secOf(l)] = (secCount[secOf(l)] || 0) + 1;
  const toVerify = list.filter(needsVerify);
  const vb = UI.verifying;
  return `<div class="row"><h1>Leads</h1><span class="muted">${D.leads.length} total</span><span class="spacer"></span>
    <button class="btn" data-act="export">Export CSV</button><a class="btn primary" href="#import">Add leads</a></div>
  <div class="row tabs" style="margin-top:12px">${[['all', 'All sections', D.leads.length], ...Object.entries(SECTIONS).map(([k, v]) => [k, v, secCount[k] || 0])].map(([k, v, n]) => `<button class="btn small${UI.section === k ? ' primary' : ''}" data-act="section" data-s="${k}">${esc(v)} (${n})</button>`).join('')}</div>
  ${MANUAL.has(UI.section) ? '<div class="notice warn" style="margin-top:10px">Manual-only section. Autopilot and batch sends skip these leads. Open a lead to review its personal email and send it yourself.</div>' : ''}
  <div class="row" style="margin-top:10px">${vb ? `<b>Verifying</b><span class="muted">${vb.done} of ${vb.total} checked · ${vb.valid} verified · ${vb.rejected} failed${vb.errors ? ` · ${vb.errors} errors` : ''}</span>${vb.running ? '<button class="btn small" data-act="verifyStop">Stop</button>' : '<button class="btn small" data-act="verifyClose">Close</button>'}${vb.msg ? `<span class="muted small">${esc(vb.msg)}</span>` : ''}`
    : `<button class="btn" data-act="verifyAll" ${toVerify.length && D.settings.verifier.hasKey ? '' : 'disabled'}>Verify ${toVerify.length} unverified with ${D.settings.verifier.provider === 'zerobounce' ? 'ZeroBounce' : 'MillionVerifier'}</button><span class="muted small">Uses one credit per lead. Applies to the leads shown.</span>`}</div>
  <div class="row" style="margin:14px 0">
    <input id="q" placeholder="Search company, name, email, city…" value="${esc(UI.q)}" style="max-width:340px">
    <select id="fStatus" style="width:auto"><option value="all">All statuses</option>${Object.keys(STATUS_LABEL).map((s) => `<option value="${s}" ${UI.status === s ? 'selected' : ''}>${STATUS_LABEL[s]} (${counts[s] || 0})</option>`).join('')}</select>
    <select id="fVerif" style="width:auto">${[['all', 'Any verification'], ['valid', 'Verified'], ['unverified', 'Not verified'], ['rejected', 'Failed check']].map(([k, v]) => `<option value="${k}" ${UI.verif === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <span class="muted">${list.length} shown</span></div>
  <div class="tablewrap"><table><thead><tr><th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th>Status</th><th>Last touch</th></tr></thead><tbody>
  ${list.slice(0, UI.limit).map((l) => `<tr data-lead="${l.id}"><td><b>${esc(l.company)}</b>${manualOnly(l) ? ` <span class="pill">${({ 'sammy-ut': 'Sammy UT', 'sammy-other': 'Sammy', 'ut-alumni': 'UT alum' })[secOf(l)]}</span>` : ''}<div class="muted small">${esc([l.industry, l.city].filter(Boolean).join(' · '))}</div></td>
    <td>${esc(person(l))}<div class="muted small">${esc(l.title || '')}</div></td>
    <td class="small">${esc(l.email)}<div>${vpill(l)}</div></td><td class="small">${esc(l.phone || '')}</td>
    <td>${pill(l.status)}${l.needsResponse ? ' <span class="pill replied">Needs reply</span>' : ''}</td><td class="small muted">${ago(lastTouch(l))}</td></tr>`).join('')}
  </tbody></table>${list.length > UI.limit ? `<div style="padding:12px"><button class="btn" data-act="more">Show more</button></div>` : ''}${!list.length ? '<div class="empty" style="padding:16px">No leads match.</div>' : ''}</div>`;
}
const needsVerify = (l) => l.email && !['valid', 'rejected'].includes(l.verification?.status || 'unverified') && !['bounced', 'do_not_contact'].includes(l.status);
async function runVerifyAll() {
  const ids = filteredLeads().filter(needsVerify).map((l) => l.id);
  if (!ids.length) return;
  if (!confirm(`Verify ${ids.length} email${ids.length > 1 ? 's' : ''} with ${D.settings.verifier.provider === 'zerobounce' ? 'ZeroBounce' : 'MillionVerifier'}? This uses about ${ids.length} credit${ids.length > 1 ? 's' : ''}.`)) return;
  UI.verifying = { total: ids.length, done: 0, valid: 0, rejected: 0, errors: 0, running: true, stop: false, msg: '' };
  render();
  for (let i = 0; i < ids.length; i += 10) {
    const vb = UI.verifying; if (!vb || vb.stop) break;
    try {
      const r = await api('/api/data', { method: 'POST', body: { action: 'verifyBatch', ids: ids.slice(i, i + 10) } });
      for (const x of r.results) { vb.done++; if (x.status === 'error') vb.errors++; else if (x.ok) vb.valid++; else vb.rejected++; }
    } catch (e) { vb.msg = e.message; break; }
    if (route().name === 'leads') render();
  }
  if (UI.verifying) { UI.verifying.running = false; if (!UI.verifying.msg) UI.verifying.msg = UI.verifying.stop ? 'Stopped.' : 'Done.'; }
  await refresh();
}
function exportCsv() {
  const cols = ['company', 'firstName', 'lastName', 'title', 'email', 'phone', 'website', 'industry', 'city', 'state', 'section', 'status', 'verification', 'emailsSent', 'replied', 'lastTouch', 'notes'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = D.leads.map((l) => [l.company, l.firstName, l.lastName, l.title, l.email, l.phone, l.website, l.industry, l.city, l.state, SECTIONS[secOf(l)], l.status, l.verification?.status, sent(l).length, replied(l) ? 'yes' : 'no', lastTouch(l) ? new Date(lastTouch(l)).toISOString() : '', l.notes].map(q).join(','));
  const blob = new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `leads-${dayKey()}.csv`; a.click();
}

// ---------- Lead drawer ----------
function timeline(l, max = 100) {
  const items = [...(l.history || [])].reverse().slice(0, max);
  return `<ul class="timeline">${items.map((h) => {
    let extra = '';
    if (h.type === 'email_sent') extra = h.subject ? `“${esc(h.subject)}”` : '';
    if (['reply', 'auto_reply', 'bounce'].includes(h.type)) extra = esc(unent(h.snippet || ''));
    if (h.type === 'call' || h.type === 'note') extra = esc(h.note || h.text || '');
    if (h.type === 'verified' || h.type === 'send_failed') extra = esc(h.reason || '');
    return `<li><b>${evText(h)}</b>${h.source === 'volvera' ? ' <span class="pill">Volvera</span>' : ''}${h.source === 'autopilot' ? ' <span class="pill">Autopilot</span>' : ''} <span class="when">${when(h.t)}</span>${extra ? `<div class="muted">${extra}</div>` : ''}</li>`;
  }).join('')}</ul>`;
}
function drawer() {
  const l = D.leads.find((x) => x.id === UI.lead);
  if (!l) { UI.lead = null; return ''; }
  const tpls = D.templates;
  const hasFirst = sent(l).some((h) => h.kind !== 'followup');
  const defTpl = (hasFirst ? tplFollow() : tplFirst()) || tpls[0];
  const tid = UI.drawerTpl && tpls.some((t) => t.id === UI.drawerTpl) ? UI.drawerTpl : defTpl.id;
  const msg = renderTpl(tpls.find((t) => t.id === tid), l);
  const f = (k, label, type = 'text') => `<div><label>${label}</label><input data-f="${k}" type="${type}" value="${esc(l[k] || '')}"></div>`;
  return `<div class="drawer-bg" data-act="closeLead"></div><aside class="drawer">
    <div class="row"><h1 style="flex:1">${esc(l.company)}</h1><button class="btn small" data-act="closeLead">Close</button></div>
    <div class="row" style="margin-top:6px"><select id="dSection" style="width:auto">${Object.entries(SECTIONS).map(([k, v]) => `<option value="${k}" ${secOf(l) === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><select id="dStatus" style="width:auto">${Object.keys(STATUS_LABEL).map((s) => `<option value="${s}" ${l.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
      ${vpill(l)} <button class="btn small" data-act="verify">Verify email</button>
      ${l.needsResponse ? '<button class="btn small" data-act="responded">Mark reply answered</button>' : ''}</div>
    ${l.sendUnknown ? `<div class="notice warn" style="margin-top:12px">A send to this lead was interrupted. Check Gmail Sent for ${esc(l.email)}.<div class="row" style="margin-top:8px"><button class="btn small" data-act="sendUnknown" data-went="1">It went out</button><button class="btn small" data-act="sendUnknown" data-went="0">It did not go out</button></div></div>` : ''}
    <div class="muted small" style="margin-top:6px">${esc(l.verification?.reason || '')}${l.verification?.checkedAt ? ` · checked ${ago(l.verification.checkedAt)}` : ''}</div>

    <div class="section"><h2>Contact</h2><div class="fields">
      ${f('firstName', 'First name')}${f('lastName', 'Last name')}${f('title', 'Title')}${f('email', 'Email', 'email')}${f('phone', 'Phone', 'tel')}${f('website', 'Website')}${f('industry', 'Industry')}${f('city', 'City')}</div>
      <label>Personalization: {detail} (something specific you noticed about them)</label><input data-f="detail" value="${esc(l.detail || '')}" placeholder="e.g. you run three locations and take bookings by phone">
      <label>Personalization: {task} (the job you'd help with)</label><input data-f="task" value="${esc(l.task || '')}" placeholder="e.g. after-hours calls and appointment requests">
      <label>Notes</label><textarea data-f="notes">${esc(l.notes || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="saveLead">Save changes</button>
      ${l.phone ? `<a class="btn" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">Call ${esc(l.phone)}</a>` : ''}</div></div>

    ${l.status === 'client' ? `<div class="section"><h2>Client</h2><div class="fields"><div><label>Monthly value ($)</label><input id="cMonthly" type="number" min="0" value="${esc(l.client?.monthly || 0)}"></div><div><label>Client since</label><input id="cSince" type="date" value="${l.client?.since ? dayKey(l.client.since) : ''}"></div></div>
      <label>Client notes</label><textarea id="cNotes">${esc(l.client?.notes || '')}</textarea><div style="margin-top:8px"><button class="btn" data-act="saveClient">Save</button></div></div>` : ''}

    ${manualOnly(l) ? `<div class="section"><h2>Personal email (manual only)</h2>
      <p class="muted small">This lead is never emailed by Autopilot or a batch send. Edit the draft, then send it yourself. Your signature is added under it.</p>
      <label>Subject</label><input id="drSubject" value="${esc(l.draft?.subject || '')}">
      <label>Body</label><textarea id="drBody" style="min-height:220px">${esc(l.draft?.body || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="saveDraft">Save draft</button><button class="btn" data-act="copyDraft">Copy</button>
        <button class="btn primary" data-act="sendDraft" ${l.draft?.body && !sent(l).some((h) => h.kind !== 'followup') ? '' : 'disabled'}>Send from ${esc(D.gmail.email || 'Gmail')}</button></div></div>` : ''}
    <div class="section"><h2>${manualOnly(l) ? 'Template email' : 'Email'}</h2>
      <select id="dTpl">${tpls.map((t) => `<option value="${t.id}" ${t.id === tid ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <div class="preview" style="margin-top:8px"><b>${esc(msg.subject)}</b>\n\n${esc(msg.body)}</div>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="sendOne" data-tpl="${tid}">Send from ${esc(D.gmail.email || 'Gmail')}</button><span class="muted small">${D.sentToday}/${D.settings.dailyCap} sent today</span></div></div>

    <div class="section"><h2>Log a call</h2><textarea id="dCallNote" placeholder="Optional note"></textarea>
      <div class="outcomes" style="margin-top:8px">${OUTCOMES.filter((o) => o[0] !== 'call_back').map(([k, v]) => `<button class="btn small" data-act="drawerCall" data-outcome="${k}">${v}</button>`).join('')}</div></div>

    <div class="section"><h2>Add a note</h2><textarea id="dNote"></textarea><div style="margin-top:8px"><button class="btn" data-act="addNote">Add note</button></div></div>
    <div class="section"><h2>History</h2>${(l.history || []).length ? timeline(l) : '<div class="empty">Nothing yet.</div>'}</div>
    <div class="section"><button class="btn danger small" data-act="deleteLead">Delete lead</button></div>
  </aside>`;
}
function openLead(id) { UI.lead = id; UI.drawerTpl = null; render(); }

// ---------- Pipeline ----------
function vPipeline() {
  const by = {}; for (const s of BOARD) by[s] = [];
  for (const l of D.leads) if (by[l.status]) by[l.status].push(l);
  const emailed = D.leads.filter((l) => sent(l).length);
  const rep = emailed.filter(replied);
  const meetings = D.leads.filter((l) => ['meeting', 'client'].includes(l.status));
  const clients = D.leads.filter((l) => l.status === 'client');
  const mrr = clients.reduce((n, l) => n + (Number(l.client?.monthly) || 0), 0);
  const bounced = D.leads.filter((l) => l.status === 'bounced').length;
  const days = []; for (let i = 13; i >= 0; i--) days.push(dayKey(Date.now() - i * 864e5));
  const series = Object.fromEntries(days.map((d) => [d, { e: 0, r: 0, c: 0 }]));
  for (const l of D.leads) for (const h of l.history || []) {
    const k = dayKey(h.t); if (!series[k]) continue;
    if (h.type === 'email_sent') series[k].e++; else if (h.type === 'reply') series[k].r++; else if (h.type === 'call') series[k].c++;
  }
  const max = Math.max(1, ...days.map((d) => Math.max(series[d].e, series[d].r, series[d].c)));
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return `<h1>Pipeline</h1><p class="sub">Updates itself as you send, call, and get replies. Drag a card to change its stage.</p>
  <div class="kpis">
    <div class="kpi"><div class="n">${emailed.length}</div><div class="l">Leads emailed</div></div>
    <div class="kpi"><div class="n">${pct(rep.length, emailed.length)}</div><div class="l">Reply rate (${rep.length})</div></div>
    <div class="kpi"><div class="n">${meetings.length}</div><div class="l">Meetings booked</div></div>
    <div class="kpi"><div class="n">${clients.length}</div><div class="l">Clients</div></div>
    <div class="kpi"><div class="n">$${mrr.toLocaleString()}</div><div class="l">Monthly revenue</div></div>
    <div class="kpi"><div class="n">${pct(bounced, emailed.length)}</div><div class="l">Bounce rate (${bounced})</div></div>
  </div>
  <div class="card" style="margin-bottom:14px"><h2>Last 14 days</h2><div class="bars">${days.map((d) => `<div class="day" title="${d}: ${series[d].e} emails, ${series[d].r} replies, ${series[d].c} calls">
    <div class="row" style="gap:2px;align-items:flex-end;height:100%;width:100%;justify-content:center">
    <div class="b" style="height:${(series[d].e / max) * 100}%;background:var(--accent)"></div><div class="b" style="height:${(series[d].r / max) * 100}%;background:var(--good)"></div><div class="b" style="height:${(series[d].c / max) * 100}%;background:var(--warn)"></div></div>
    <span class="lbl">${Number(d.slice(8))}</span></div>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--accent)"></i>Emails</span><span><i style="background:var(--good)"></i>Replies</span><span><i style="background:var(--warn)"></i>Calls</span></div></div>
  <div class="board">${BOARD.map((s) => `<div class="col" data-col="${s}"><h3>${STATUS_LABEL[s]}<span class="muted">${by[s].length}</span></h3>
    ${by[s].sort((a, b) => lastTouch(b) - lastTouch(a)).slice(0, 60).map((l) => `<div class="tile" draggable="true" data-drag="${l.id}" data-lead="${l.id}"><b>${esc(l.company)}</b><div class="muted">${esc(person(l) || l.email)}</div><div class="muted">${ago(lastTouch(l))}</div></div>`).join('')}
    ${by[s].length > 60 ? `<div class="muted small">+${by[s].length - 60} more in Leads</div>` : ''}</div>`).join('')}</div>`;
}

// ---------- Results ----------
function vResults() {
  const days = UI.range; // 7, 30, or 0 = all time
  const since = days ? new Date(`${dayKey(Date.now() - (days - 1) * 864e5)}T00:00:00-06:00`).getTime() : 0;
  const inR = (t) => t >= since;
  const tOf = (h) => h.at || h.t;
  const rows = {}; const rowFor = (t) => (rows[dayKey(t)] ||= { first: 0, follow: 0, reply: 0, bounce: 0 });
  let first = 0; let follow = 0; let bounces = 0; let optOuts = 0;
  const emailed = new Set(); const repliedLeads = []; const ind = {};
  const afterFollow = { first: 0, follow: 0 };
  for (const l of D.leads) {
    const hs = l.history || [];
    const mine = hs.filter((h) => h.type === 'email_sent' && inR(h.t));
    for (const h of mine) { if (h.kind === 'followup') { follow++; rowFor(h.t).follow++; } else { first++; rowFor(h.t).first++; } }
    if (mine.length) emailed.add(l.id);
    for (const h of hs) if (h.type === 'bounce' && inR(tOf(h))) { bounces++; rowFor(tOf(h)).bounce++; }
    const reps = hs.filter((h) => h.type === 'reply' && inR(tOf(h)));
    for (const h of reps) rowFor(tOf(h)).reply++;
    const real = reps.filter((h) => !h.optOut);
    if (reps.some((h) => h.optOut)) optOuts++;
    if (real.length) {
      const r = real.at(-1);
      const before = hs.filter((h) => h.type === 'email_sent' && h.t <= tOf(real[0]));
      if (before.length) afterFollow[before.at(-1).kind === 'followup' ? 'follow' : 'first']++;
      repliedLeads.push({ l, r });
    }
    if (mine.length) {
      const k = (l.industry || 'Other').trim() || 'Other';
      const x = (ind[k] ||= { n: 0, r: 0 }); x.n++; if (real.length) x.r++;
    }
  }
  repliedLeads.sort((a, b) => tOf(b.r) - tOf(a.r));
  const reached = emailed.size;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const interested = repliedLeads.filter(({ l }) => ['meeting', 'client'].includes(l.status)).length;
  const notNow = repliedLeads.filter(({ l }) => ['lost', 'do_not_contact'].includes(l.status)).length;
  const open = repliedLeads.length - interested - notNow;
  const dayList = Object.keys(rows).sort().reverse();
  const fmtDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const industries = Object.entries(ind).sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  const runs = (D.autopilotLog || []).filter((r) => inR(r.t)).slice(-12).reverse();
  const chip = (n, label) => `<button class="btn${UI.range === n ? ' primary' : ''}" data-act="range" data-n="${n}">${label}</button>`;
  return `<h1>Results</h1><p class="sub">How your outreach is doing. Updates every time the inbox is checked.</p>
  <div class="row" style="margin-bottom:14px">${chip(7, 'Last 7 days')}${chip(30, 'Last 30 days')}${chip(0, 'All time')}</div>
  <div class="kpis">
    <div class="kpi"><div class="n">${first + follow}</div><div class="l">Emails sent (${first} first, ${follow} follow-up)</div></div>
    <div class="kpi"><div class="n">${reached}</div><div class="l">Businesses reached</div></div>
    <div class="kpi"><div class="n">${repliedLeads.length}</div><div class="l">Replied (${pct(repliedLeads.length, reached)})</div></div>
    <div class="kpi"><div class="n">${interested}</div><div class="l">Meetings or clients</div></div>
    <div class="kpi"><div class="n">${bounces}</div><div class="l">Bounced (${pct(bounces, first + follow)})</div></div>
    <div class="kpi"><div class="n">${optOuts}</div><div class="l">Asked to stop</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>Replies</h2>
      ${repliedLeads.length ? `<div class="muted small" style="margin-bottom:6px">${open} open, ${interested} meeting or client, ${notNow} not interested. ${afterFollow.first} replied to the first email, ${afterFollow.follow} to a follow-up.</div>
      <ul class="list">${repliedLeads.slice(0, 40).map(({ l, r }) => `<li><div class="main"><a href="#" data-lead="${l.id}"><b>${esc(l.company)}</b></a> ${pill(l.status)}<div class="muted small clip">${esc(unent(r.snippet || ''))}</div></div><span class="muted small">${ago(tOf(r))}</span></li>`).join('')}</ul>`
      : '<div class="empty">No replies in this period yet.</div>'}</div>
    <div class="card"><h2>By day</h2>
      ${dayList.length ? `<table><thead><tr><th>Day</th><th>First</th><th>Follow-up</th><th>Replies</th><th>Bounces</th></tr></thead><tbody>
      ${dayList.map((k) => `<tr><td>${fmtDay(k)}</td><td>${rows[k].first}</td><td>${rows[k].follow}</td><td>${rows[k].reply}</td><td>${rows[k].bounce}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nothing sent in this period.</div>'}</div>
    <div class="card"><h2>By industry</h2>
      ${industries.length ? `<table><thead><tr><th>Industry</th><th>Emailed</th><th>Replied</th><th>Rate</th></tr></thead><tbody>
      ${industries.map(([k, x]) => `<tr><td>${esc(k)}</td><td>${x.n}</td><td>${x.r}</td><td>${pct(x.r, x.n)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nothing sent in this period.</div>'}</div>
    <div class="card"><h2>Autopilot runs</h2>
      ${runs.length ? `<table><thead><tr><th>When</th><th>Sent</th><th>Skipped</th><th>Note</th></tr></thead><tbody>
      ${runs.map((r) => `<tr><td>${when(r.t)}</td><td>${r.sent}</td><td>${r.failed}</td><td class="small muted">${esc((r.errors || [])[0] || '')}</td></tr>`).join('')}</tbody></table>`
      : `<div class="empty">No Autopilot runs in this period.${D.settings.autopilot?.enabled ? '' : ' Autopilot is off.'}</div>`}</div>
  </div>`;
}

// ---------- Clients ----------
function vClients() {
  const clients = D.leads.filter((l) => l.status === 'client');
  const mrr = clients.reduce((n, l) => n + (Number(l.client?.monthly) || 0), 0);
  return `<h1>Clients</h1><p class="sub">Leads you've moved to Client, from the lead panel or the pipeline board.</p>
  <div class="kpis"><div class="kpi"><div class="n">${clients.length}</div><div class="l">Clients</div></div><div class="kpi"><div class="n">$${mrr.toLocaleString()}</div><div class="l">Monthly revenue</div></div></div>
  ${clients.length ? `<div class="tablewrap"><table><thead><tr><th>Company</th><th>Contact</th><th>Since</th><th>Monthly</th><th>Notes</th></tr></thead><tbody>
  ${clients.map((l) => `<tr data-lead="${l.id}"><td><b>${esc(l.company)}</b></td><td>${esc(person(l))}<div class="muted small">${esc(l.email)} ${esc(l.phone || '')}</div></td><td>${l.client?.since ? new Date(l.client.since).toLocaleDateString() : '—'}</td><td>$${Number(l.client?.monthly || 0).toLocaleString()}</td><td class="small">${esc(l.client?.notes || '')}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="card empty">No clients yet.</div>'}`;
}

// ---------- Templates ----------
function vTemplates() {
  const t = D.templates.find((x) => x.id === UI.tplId) || D.templates[0];
  UI.tplId = t?.id;
  const sample = D.leads.find((l) => l.firstName && l.company) || { firstName: 'Maria', company: 'Lone Star Dental', city: 'Dallas', industry: 'Dental' };
  const m = t ? renderTpl(t, sample) : { subject: '', body: '' };
  return `<h1>Templates</h1><p class="sub">Merge fields: <code>{first_name}</code> <code>{company}</code> <code>{city}</code> <code>{industry}</code> <code>{title}</code> <code>{detail}</code> <code>{task}</code> (the last two are filled per lead). Any field left unfilled blocks the send. Your signature is added automatically.</p>
  <div class="grid g2"><div class="card">
    <div class="row">${D.templates.map((x) => `<button class="btn small ${x.id === t?.id ? 'primary' : ''}" data-act="pickTpl" data-id="${x.id}">${esc(x.name)}</button>`).join('')}<button class="btn small" data-act="newTpl">+ New</button></div>
    ${t ? `<label>Name</label><input id="tName" value="${esc(t.name)}">
    <label>Type</label><select id="tKind"><option value="first" ${t.kind !== 'followup' ? 'selected' : ''}>First email (new thread)</option><option value="followup" ${t.kind === 'followup' ? 'selected' : ''}>Follow-up (replies in the same thread)</option></select>
    <label>Subject</label><input id="tSubject" value="${esc(t.subject)}">
    <label>Body</label><textarea id="tBody" style="min-height:240px">${esc(t.body)}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary" data-act="saveTpl">Save template</button><span class="spacer"></span>${D.templates.length > 1 ? '<button class="btn danger small" data-act="delTpl">Delete</button>' : ''}</div>` : ''}
  </div><div class="card"><h2>Preview</h2><div class="muted small">Using ${esc(sample.company)}</div><div class="preview" id="tPrev" style="margin-top:8px;max-height:none"><b>${esc(m.subject)}</b>\n\n${esc(m.body)}</div></div></div>`;
}

// ---------- Import ----------
const SYN = {
  company: ['company', 'companyname', 'business', 'businessname', 'organization', 'organizationname', 'account', 'accountname'],
  firstName: ['firstname', 'first', 'fname', 'givenname'],
  lastName: ['lastname', 'last', 'lname', 'surname'],
  fullName: ['name', 'fullname', 'contactname', 'contact', 'owner', 'ownername'],
  title: ['title', 'jobtitle', 'position', 'role'],
  email: ['email', 'emailaddress', 'workemail', 'mail', 'contactemail'],
  phone: ['phone', 'phonenumber', 'mobile', 'tel', 'telephone', 'directphone', 'companyphone', 'workphone'],
  website: ['website', 'domain', 'url', 'site', 'companywebsite', 'companydomain', 'web'],
  industry: ['industry', 'category', 'vertical', 'type'],
  city: ['city', 'town'], state: ['state', 'region', 'province'],
  linkedin: ['linkedin', 'linkedinurl', 'personlinkedinurl'],
  notes: ['notes', 'note', 'comments', 'description'],
  detail: ['detail'], task: ['task'],
  draftSubject: ['draftsubject', 'emailsubject', 'subject'], draftBody: ['draftbody', 'emailbody', 'body', 'email_body'],
};
function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
function mapHeaders(h) {
  const norm = h.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const map = {};
  for (const [k, syns] of Object.entries(SYN)) { const i = norm.findIndex((x) => syns.includes(x)); if (i >= 0) map[k] = i; }
  return map;
}
function csvCandidates() {
  if (!UI.csvRows) return [];
  const [, ...rows] = UI.csvRows; const m = UI.csvMap;
  return rows.map((r) => {
    const g = (k) => (m[k] != null ? (r[m[k]] || '').trim() : '');
    let first = g('firstName'); let last = g('lastName');
    if (!first && g('fullName')) { const p = g('fullName').split(/\s+/); first = p.shift(); last = p.join(' '); }
    return { company: g('company'), firstName: first, lastName: last, title: g('title'), email: g('email'), phone: g('phone'), website: g('website'), industry: g('industry'), city: g('city'), state: g('state'), linkedin: g('linkedin'), notes: g('notes'), detail: g('detail'), task: g('task'), draftSubject: g('draftSubject'), draftBody: g('draftBody'), section: UI.importSection || 'main', source: 'csv' };
  });
}
function vImport() {
  const cands = csvCandidates();
  const res = UI.importResults;
  const added = res.filter((r) => r.added).length;
  const why = {}; for (const r of res) if (!r.added) why[r.reason] = (why[r.reason] || 0) + 1;
  return `<h1>Import leads</h1><p class="sub">Every email is checked before it's added: format, real mail server, not a generic or throwaway inbox, mailbox confirmed by ${esc(D.settings.verifier.provider === 'zerobounce' ? 'ZeroBounce' : 'MillionVerifier')}, and not already contacted. Anything that fails is left out.</p>
  ${!D.settings.verifier.hasKey ? '<div class="notice warn">Add your verification API key in Settings first. Nothing is imported without a mailbox check.</div>' : ''}
  <div class="card"><h2>1. Paste or upload a CSV</h2>
    <div class="row"><input type="file" id="csvFile" accept=".csv,.tsv,text/csv" style="width:auto"></div>
    <label>…or paste rows (first row = headers like Company, First name, Email, Phone, Website, City)</label>
    <textarea id="csvText" style="min-height:110px" placeholder="Company,First name,Last name,Email,Phone,Website,City"></textarea>
    <label>Add these leads to</label><select id="impSection" style="width:auto">${Object.entries(SECTIONS).map(([k, v]) => `<option value="${k}" ${(UI.importSection || 'main') === k ? 'selected' : ''}>${esc(v)}${MANUAL.has(k) ? ' (manual only)' : ''}</option>`).join('')}</select>
    <div class="row" style="margin-top:8px"><button class="btn" data-act="parseCsv">Read rows</button></div>
    ${UI.csvRows ? `<div class="section"><b>${cands.length} rows.</b> <span class="muted">Columns found: ${Object.keys(UI.csvMap).map((k) => `<code>${k}</code>`).join(' ') || 'none'}</span>
      ${UI.csvMap.email == null || UI.csvMap.company == null ? '<div class="notice bad" style="margin-top:8px">Needs at least a Company and an Email column.</div>' : `
      <div class="tablewrap" style="max-height:200px;margin-top:8px"><table><thead><tr><th>Company</th><th>Name</th><th>Email</th><th>Phone</th></tr></thead><tbody>${cands.slice(0, 5).map((c) => `<tr><td>${esc(c.company)}</td><td>${esc(`${c.firstName} ${c.lastName}`)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td></tr>`).join('')}</tbody></table></div>
      <div class="row" style="margin-top:10px">${UI.importing ? `<button class="btn" data-act="stopImport">Stop</button><span class="muted">Checking ${res.length} of ${cands.length}…</span>` : `<button class="btn primary" data-act="runImport" ${D.settings.verifier.hasKey ? '' : 'disabled'}>Verify &amp; import ${cands.length}</button>`}</div>
      ${UI.importing || res.length ? `<div class="progress" style="margin-top:8px"><div style="width:${Math.round((res.length / Math.max(1, cands.length)) * 100)}%"></div></div>` : ''}`}</div>` : ''}
  </div>
  ${res.length ? `<div class="card"><h2>Results: ${added} added, ${res.length - added} left out</h2>
    ${Object.keys(why).length ? `<ul class="list">${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<li><div class="main">${esc(k)}</div><b>${n}</b></li>`).join('')}</ul>` : ''}</div>` : ''}
  <div class="card"><h2>Exclusion list</h2><p class="muted small">${D.suppressionCount.emails} emails and ${D.suppressionCount.domains} company domains are blocked from being imported again. Add more (one per line, emails or domains):</p>
    <textarea id="supText" placeholder="owner@business.com\nbusiness.com"></textarea><div class="row" style="margin-top:8px"><button class="btn" data-act="addSup">Add to exclusion list</button></div></div>
  ${D.importLog.length ? `<div class="card"><h2>Recent import checks</h2><div class="tablewrap" style="max-height:340px"><table><thead><tr><th>When</th><th>Company</th><th>Email</th><th>Result</th></tr></thead><tbody>
    ${D.importLog.slice(-150).reverse().map((r) => `<tr><td class="small muted">${ago(r.t)}</td><td class="small">${esc(r.company)}</td><td class="small">${esc(r.email)}</td><td class="small">${r.status === 'added' ? '<span class="pill valid">Added</span>' : `<span class="muted">${esc(r.reason)}</span>`}</td></tr>`).join('')}
  </tbody></table></div></div>` : ''}`;
}
async function runImport() {
  const cands = csvCandidates();
  UI.importing = true; UI.importStop = false; UI.importResults = []; render();
  for (let i = 0; i < cands.length && !UI.importStop; i += 20) {
    try {
      const r = await api('/api/import', { method: 'POST', body: { candidates: cands.slice(i, i + 20) } });
      UI.importResults.push(...r.results);
    } catch (e) { toast(e.message, true); break; }
    if (route().name === 'import') render();
  }
  UI.importing = false;
  await refresh();
  toast(`${UI.importResults.filter((r) => r.added).length} verified leads added`);
}

// ---------- Settings ----------
function vSettings() {
  const p = route().params;
  if (p.get('gmail')) UI.flash = [p.get('gmail') === 'ok' ? 'good' : 'bad', p.get('msg') || ''];
  const s = D.settings;
  const redirect = `${location.origin}/api/google`;
  return `<h1>Settings</h1><p class="sub">Keys you save here are encrypted before they're stored.</p>${flash()}
  <div class="grid g2"><div>
  <div class="card"><h2>Gmail</h2>
    ${D.gmail.connected ? `<div class="notice good">Sending as <b>${esc(D.gmail.email)}</b> · connected ${ago(D.gmail.connectedAt)}</div><div class="row"><button class="btn" data-act="gmailConnect">Reconnect</button><button class="btn danger" data-act="gmailDisconnect">Disconnect</button><button class="btn" data-act="syncNow">Check inbox now</button></div>`
      : `${D.gmail.broken ? '<div class="notice bad">Google signed this app out. Reconnect below.</div>' : ''}<div class="row"><button class="btn primary" data-act="gmailConnect" ${s.google.clientId && s.google.hasSecret ? '' : 'disabled'}>Connect Gmail</button>${s.google.clientId && s.google.hasSecret ? '' : '<span class="muted small">Save the Google client ID and secret first</span>'}</div>`}
    <label>Google OAuth client ID</label><input id="gId" value="${esc(s.google.clientId)}" placeholder="…apps.googleusercontent.com">
    <label>Google OAuth client secret ${s.google.hasSecret ? '<span class="pill valid">saved</span>' : ''}</label><input id="gSecret" type="password" placeholder="${s.google.hasSecret ? 'Leave blank to keep the saved secret' : 'GOCSPX-…'}">
    <label>Authorized redirect URI (paste this into Google Cloud)</label><div class="copy mono">${esc(redirect)}</div>
    <details style="margin-top:10px"><summary class="small">How to get the client ID and secret (about 5 minutes)</summary><ol class="steps small">
      <li>Go to <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> signed in as adigold21@gmail.com and create a project named “Adi Outreach”.</li>
      <li>Open <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a> and click Enable.</li>
      <li>Open <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a> → Get started. App name “Adi Outreach”, support email yours, Audience <b>External</b>, contact email yours, accept, Create.</li>
      <li>Audience → Test users → add adigold21@gmail.com.</li>
      <li>Clients → Create client → Web application. Under Authorized redirect URIs add the URI above. Create, then copy the client ID and secret here and Save.</li>
      <li>Click Connect Gmail. Google will warn the app isn't verified; that's expected for your own app. Click Continue and allow both Gmail permissions.</li>
      <li>Optional: on the Audience page, click “Publish app”. While it's in Testing, Google signs you out every 7 days and you'd click Reconnect here.</li></ol></details>
  </div>
  <div class="card"><h2>Email verification</h2>
    <label>Service</label><select id="vProv"><option value="millionverifier" ${s.verifier.provider === 'millionverifier' ? 'selected' : ''}>MillionVerifier</option><option value="zerobounce" ${s.verifier.provider === 'zerobounce' ? 'selected' : ''}>ZeroBounce</option></select>
    <label>API key ${s.verifier.hasKey ? '<span class="pill valid">saved</span>' : ''}</label><input id="vKey" type="password" placeholder="${s.verifier.hasKey ? 'Leave blank to keep the saved key' : 'Paste API key'}">
    <div class="row" style="margin-top:8px"><button class="btn small" data-act="credits" ${s.verifier.hasKey ? '' : 'disabled'}>Check credits</button><span id="creditOut" class="muted small"></span></div>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="allowRole" ${s.allowRoleEmails ? 'checked' : ''}> Allow generic inboxes (info@, contact@…) if the mailbox checks out</label>
    <label>Re-check an email before sending if its last check is older than (days)</label><input id="reverify" type="number" min="1" max="180" value="${s.reverifyDays}">
  </div></div><div>
  <div class="card"><h2>Sending</h2>
    <label>From name</label><input id="fromName" value="${esc(s.fromName)}">
    <label>Signature</label><textarea id="sig">${esc(s.signature)}</textarea>
    <div class="fields"><div><label>Max emails per day</label><input id="cap" type="number" min="1" max="150" value="${s.dailyCap}"></div>
    <div><label>Follow up after (business days)</label><input id="fuDays" type="number" min="1" max="30" value="${s.followUpDays}"></div>
    <div><label>Follow-ups per lead</label><input id="fuMax" type="number" min="0" max="3" value="${s.maxFollowUps}"></div></div>
  </div>
  <div class="card"><h2>Autopilot</h2><p class="muted small">Each weekday around 9 a.m. Central, sends due follow-ups and up to N first emails to verified leads, within your daily max. Off by default.</p>
    <label class="check"><input type="checkbox" id="apOn" ${s.autopilot.enabled ? 'checked' : ''}> Turn on autopilot</label>
    <div class="fields"><div><label>First emails per day</label><input id="apN" type="number" min="0" max="150" value="${s.autopilot.firstTouchPerDay}"></div></div>
    <label class="check"><input type="checkbox" id="apFu" ${s.autopilot.includeFollowUps ? 'checked' : ''}> Include follow-ups</label>
    ${D.autopilotLog.length ? `<div class="small muted" style="margin-top:8px">Last run ${ago(D.autopilotLog.at(-1).t)}: ${D.autopilotLog.at(-1).sent} sent${D.autopilotLog.at(-1).failed ? `, ${D.autopilotLog.at(-1).failed} skipped` : ''}</div>` : ''}
  </div>
  <div class="card"><div class="row"><button class="btn primary" data-act="saveSettings">Save settings</button><span class="spacer"></span><button class="btn" data-act="logout">Sign out</button></div></div>
  </div></div>`;
}
function settingsPayload() {
  const v = (id) => $(id)?.value;
  const out = {
    fromName: v('#fromName'), signature: v('#sig'), dailyCap: v('#cap'), followUpDays: v('#fuDays'), maxFollowUps: v('#fuMax'),
    reverifyDays: v('#reverify'), allowRoleEmails: $('#allowRole').checked, verifierProvider: v('#vProv'), googleClientId: v('#gId'),
    autopilot: { enabled: $('#apOn').checked, firstTouchPerDay: v('#apN'), includeFollowUps: $('#apFu').checked },
  };
  if (v('#vKey')) out.verifierKey = v('#vKey');
  if (v('#gSecret')) out.googleClientSecret = v('#gSecret');
  return out;
}

// ---------- events ----------
function after(name) {
  if (name === 'leads') {
    const q = $('#q'); if (q) { q.oninput = () => { UI.q = q.value; UI.limit = 200; const pos = q.selectionStart; render(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); }; }
    $('#fStatus').onchange = (e) => { UI.status = e.target.value; render(); };
    $('#fVerif').onchange = (e) => { UI.verif = e.target.value; render(); };
  }
  if (name === 'dialer') {
    const f = $('#dialFilter'); if (f) f.onchange = () => { UI.dialFilter = f.value; UI.dialIndex = 0; render(); };
    const n = $('#dialNote'); if (n) n.oninput = () => { UI.dialNote = n.value; };
  }
  if (name === 'templates') {
    const upd = () => {
      const t = { subject: $('#tSubject').value, body: $('#tBody').value };
      const sample = D.leads.find((l) => l.firstName && l.company) || { firstName: 'Maria', company: 'Lone Star Dental', city: 'Dallas', industry: 'Dental' };
      const m = renderTpl(t, sample); $('#tPrev').innerHTML = `<b>${esc(m.subject)}</b>\n\n${esc(m.body)}`;
    };
    for (const id of ['#tSubject', '#tBody']) { const el = $(id); if (el) el.oninput = upd; }
  }
  if (name === 'import') {
    const fi = $('#csvFile'); if (fi) fi.onchange = async () => { const file = fi.files[0]; if (!file) return; $('#csvText').value = await file.text(); loadCsv(); };
  }
  if (name === 'pipeline') {
    for (const t of $$('[data-drag]')) t.ondragstart = (e) => e.dataTransfer.setData('text/plain', t.dataset.drag);
    for (const c of $$('[data-col]')) {
      c.ondragover = (e) => { e.preventDefault(); c.classList.add('drop'); };
      c.ondragleave = () => c.classList.remove('drop');
      c.ondrop = async (e) => { e.preventDefault(); c.classList.remove('drop'); const id = e.dataTransfer.getData('text/plain'); const l = D.leads.find((x) => x.id === id); if (l && l.status !== c.dataset.col) await act('setStatus', { id, status: c.dataset.col }, true); };
    }
  }
  const ds = $('#dStatus'); if (ds) ds.onchange = () => act('setStatus', { id: UI.lead, status: ds.value });
  const dsec = $('#dSection'); if (dsec) dsec.onchange = () => act('updateLead', { id: UI.lead, patch: { section: dsec.value } });
  const isec = $('#impSection'); if (isec) isec.onchange = () => { UI.importSection = isec.value; };
  const dt = $('#dTpl'); if (dt) dt.onchange = () => { UI.drawerTpl = dt.value; render(); };
}
function loadCsv() {
  const rows = parseCsv($('#csvText').value || '');
  if (rows.length < 2) return toast('Need a header row and at least one data row', true);
  UI.csvRows = rows; UI.csvMap = mapHeaders(rows[0]); UI.importResults = []; render();
}

root.addEventListener('click', async (e) => {
  const leadEl = e.target.closest('[data-lead]');
  const actEl = e.target.closest('[data-act]');
  if (leadEl && !actEl && !e.target.closest('a[href^="tel:"]')) { e.preventDefault(); return openLead(leadEl.dataset.lead); }
  if (!actEl) return;
  const a = actEl.dataset.act;
  const btn = actEl.tagName === 'BUTTON' ? actEl : null;
  const busy = async (fn) => { if (btn) btn.disabled = true; try { await fn(); } catch { /* toasted */ } finally { if (btn && document.body.contains(btn)) btn.disabled = false; } };
  switch (a) {
    case 'closeLead': UI.lead = null; render(); break;
    case 'batch': runBatch(actEl.dataset.kind); break;
    case 'batchStop': if (UI.batch) UI.batch.stop = true; break;
    case 'batchClose': UI.batch = null; render(); break;
    case 'more': UI.limit += 300; render(); break;
    case 'section': UI.section = actEl.dataset.s; UI.limit = 200; render(); break;
    case 'verifyAll': if (!UI.verifying) runVerifyAll(); break;
    case 'verifyStop': if (UI.verifying) UI.verifying.stop = true; break;
    case 'verifyClose': UI.verifying = null; render(); break;
    case 'saveDraft': busy(() => act('updateLead', { id: UI.lead, patch: { draft: { subject: $('#drSubject').value, body: $('#drBody').value } } })); break;
    case 'copyDraft': { const l = D.leads.find((x) => x.id === UI.lead); const txt = `Subject: ${$('#drSubject').value}\n\n${$('#drBody').value}\n\n${(D.settings.signature || '').trim()}`; navigator.clipboard.writeText(txt).then(() => toast('Copied'), () => toast('Copy failed', true)); break; }
    case 'sendDraft': busy(async () => {
      const l = D.leads.find((x) => x.id === UI.lead);
      await act('updateLead', { id: UI.lead, patch: { draft: { subject: $('#drSubject').value, body: $('#drBody').value } } }, true);
      if (!confirm(`Send your personal email to ${l.email}?`)) return;
      try {
        const r = await api('/api/send', { method: 'POST', body: { leadId: UI.lead, useDraft: true, manualConfirm: true } });
        const i = D.leads.findIndex((x) => x.id === UI.lead); D.leads[i] = r.lead; D.sentToday = r.sentToday; render(); toast('Sent');
      } catch (err) { toast(err.message, true); await refresh(); }
    }); break;
    case 'range': UI.range = Number(actEl.dataset.n); render(); break;
    case 'export': exportCsv(); break;
    case 'dialOutcome': busy(() => dialOutcome(actEl.dataset.outcome)); break;
    case 'dialPrev': UI.dialIndex = Math.max(0, UI.dialIndex - 1); UI.dialNote = ''; render(); break;
    case 'dialSkip': UI.dialIndex++; UI.dialNote = ''; render(); break;
    case 'verify': busy(async () => {
      const r = await api('/api/data', { method: 'POST', body: { action: 'verifyLead', id: UI.lead } }).catch((err) => { toast(err.message, true); throw err; });
      D = r.data; render(); toast(r.result.ok ? 'Verified: mailbox exists' : `Failed: ${r.result.reason}`, !r.result.ok);
    }); break;
    case 'responded': busy(() => act('markResponded', { id: UI.lead })); break;
    case 'sendUnknown': busy(() => act('clearSendWarning', { id: UI.lead, wentOut: actEl.dataset.went === '1' })); break;
    case 'saveLead': busy(() => {
      const patch = {}; for (const el of $$('.drawer [data-f]')) patch[el.dataset.f] = el.value;
      return act('updateLead', { id: UI.lead, patch });
    }); break;
    case 'saveClient': busy(() => act('updateLead', { id: UI.lead, patch: { client: { monthly: Number($('#cMonthly').value) || 0, since: $('#cSince').value ? new Date(`${$('#cSince').value}T12:00:00`).getTime() : Date.now(), notes: $('#cNotes').value } } })); break;
    case 'sendOne': busy(async () => {
      const l = D.leads.find((x) => x.id === UI.lead);
      if (!confirm(`Send this email to ${l.email}?`)) return;
      try {
        const r = await api('/api/send', { method: 'POST', body: { leadId: UI.lead, templateId: actEl.dataset.tpl, manualConfirm: true } });
        const i = D.leads.findIndex((x) => x.id === UI.lead); D.leads[i] = r.lead; D.sentToday = r.sentToday; UI.drawerTpl = null; render(); toast('Sent');
      } catch (err) { toast(err.message, true); await refresh(); }
    }); break;
    case 'drawerCall': busy(() => act('logCall', { id: UI.lead, outcome: actEl.dataset.outcome, note: $('#dCallNote').value })); break;
    case 'addNote': busy(() => act('addNote', { id: UI.lead, text: $('#dNote').value })); break;
    case 'deleteLead': if (confirm('Delete this lead? If it was emailed, the address stays on the exclusion list.')) { const id = UI.lead; UI.lead = null; busy(() => act('deleteLead', { id })); } break;
    case 'pickTpl': UI.tplId = actEl.dataset.id; render(); break;
    case 'newTpl': busy(async () => { await act('saveTemplate', { template: { name: 'New template', subject: 'Subject', body: 'Hi {first_name},\n\n', kind: 'first' } }, true); UI.tplId = D.templates.at(-1).id; render(); }); break;
    case 'saveTpl': busy(() => act('saveTemplate', { template: { id: UI.tplId, name: $('#tName').value, kind: $('#tKind').value, subject: $('#tSubject').value, body: $('#tBody').value } })); break;
    case 'delTpl': if (confirm('Delete this template?')) busy(async () => { await act('deleteTemplate', { id: UI.tplId }); UI.tplId = null; render(); }); break;
    case 'parseCsv': loadCsv(); break;
    case 'runImport': if (!UI.importing) runImport(); break;
    case 'stopImport': UI.importStop = true; break;
    case 'addSup': busy(async () => {
      const lines = ($('#supText').value || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      await act('addSuppression', { emails: lines.filter((x) => x.includes('@')), domains: lines.filter((x) => !x.includes('@')) });
    }); break;
    case 'saveSettings': busy(() => act('saveSettings', { settings: settingsPayload() })); break;
    case 'credits': busy(async () => { const r = await api('/api/data', { method: 'POST', body: { action: 'credits' } }).catch((err) => { toast(err.message, true); throw err; }); $('#creditOut').textContent = `${Number(r.credits).toLocaleString()} credits left`; }); break;
    case 'gmailConnect': location.href = '/api/google'; break;
    case 'gmailDisconnect': if (confirm('Disconnect Gmail? Sending and reply tracking stop until you reconnect.')) busy(async () => { await api('/api/google', { method: 'DELETE' }); await refresh(); }); break;
    case 'syncNow': busy(async () => { const r = await api('/api/sync', { method: 'POST' }); await refresh(); const s = r.sync || {}; toast(s.skipped || `Checked: ${s.reply || 0} replies, ${s.bounce || 0} bounces`); }); break;
    case 'logout': await api('/api/session', { method: 'DELETE' }).catch(() => {}); D = null; renderLogin(); break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && UI.lead) { UI.lead = null; render(); return; }
  if (route().name !== 'dialer' || UI.lead) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const n = Number(e.key);
  if (n >= 1 && n <= OUTCOMES.length) { e.preventDefault(); dialOutcome(OUTCOMES[n - 1][0]); }
});

setInterval(() => { if (D && document.visibilityState === 'visible' && !UI.batch && !UI.importing && !UI.lead) syncQuietly(); }, 10 * 60 * 1000);
boot();
