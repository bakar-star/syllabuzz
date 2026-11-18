(function () {
"use strict";
/* Syllabuzz remote features (3.2). Everything here is controlled from the dashboard, no new app build needed:
     - maintenance mode and "update required / available" screens      (config/app)
     - feature switches with rollout % and platform targeting          (config/flags)
     - announcements: banners and pop-ups, scheduled and targeted      (announcements)
     - direct messages to one user                                     (users/{uid}/inbox)
     - campus resources and tip of the day                             (content)
     - feedback with replies from the admin                            (feedback)
   Needs auth.js (it announces `sb-fire` when Firebase is ready and `sb-user` on login/logout). */
const CFG = window.SB_CONFIG || {};
if (!CFG.firebase || !CFG.firebase.apiKey || /^YOUR_/.test(CFG.firebase.apiKey)) return;
const APP = !!window.AndroidBridge;
const VER = window.SB_VER || '3.2';
const PLAT = APP ? 'android' : 'web';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lget = k => { try { return localStorage.getItem(k) } catch (e) { return null } };
const lput = (k, v) => { try { localStorage.setItem(k, v) } catch (e) {} };
const jget = (k, d) => { try { return JSON.parse(lget(k) || '') || d } catch (e) { return d } };
const cmp = (a, b) => { a = String(a || '0').split('.'); b = String(b || '0').split('.'); for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = +a[i] || 0, y = +b[i] || 0; if (x !== y) return x < y ? -1 : 1 } return 0 };
const KIND = { info: '#6366f1', success: '#16a34a', warning: '#d97706', urgent: '#dc2626', promo: '#c026d3' };

let H = null, cfgApp = {}, flags = {}, anns = [], content = [], inbox = [], mine = [];
let uid = '', isAdmin = false, adminChecked = false, bypass = false, panel = '', inboxReady = false;
let unsubs = [], unsubCfg = [], unsubMine = null, rTimer = null;

/* ---------- small helpers ---------- */
function openLink(u) {
  u = String(u || ''); if (!/^(https?:|mailto:|tel:)/i.test(u)) return;
  if (APP && /^https:/i.test(u)) { try { AndroidBridge.openExternal(u); return } catch (e) {} }
  if (APP || /^(mailto|tel):/i.test(u)) location.href = u; else window.open(u, '_blank', 'noopener');
}
window.sbOpenLink = openLink;
const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) };
const when = ms => { const d = new Date(ms); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
const tsMs = t => t && t.toMillis ? t.toMillis() : (+t || 0);
function icons() {
  if (typeof P === 'undefined') return;
  P.sbmega = '<path d="M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/>';
  P.sbcompass = '<circle cx="12" cy="12" r="10"/><path d="M16 8l-2 6-6 2 2-6z"/>';
  P.sbmsg = '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>';
  P.sbx = '<path d="M18 6L6 18M6 6l12 12"/>';
  P.sbback = '<path d="M15 18l-6-6 6-6"/>';
  P.sblink = '<path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>';
}
const ic = (n, c) => (typeof I === 'function' && typeof P !== 'undefined' && P[n]) ? I(n, c) : '';

/* ---------- feature switches ---------- */
const TABS = { tab_week: 'Week', tab_stats: 'Stats', tab_tasks: 'Tasks', tab_study: 'Study' };
const TABVIEW = { tab_week: 'week', tab_stats: 'stats', tab_tasks: 'tasks', tab_study: 'study' };
function flagOn(k, def) {
  const f = flags[k];
  if (!f) return def === undefined ? true : !!def;
  if (f.on === false) return false;
  if (f.platform && f.platform !== 'all' && f.platform !== PLAT) return false;
  const r = f.rollout == null ? 100 : +f.rollout;
  if (r >= 100) return true; if (r <= 0) return false;
  return hash((uid || lget('sb_dev') || 'x') + k) % 100 < r;
}
window.SBFlag = flagOn;
function applyFlags() {
  let css = '';
  Object.keys(TABS).forEach(k => { if (!flagOn(k)) css += '.nv[aria-label="' + TABS[k] + '"]{display:none!important}' });
  let st = $('sbFlagCss'); if (!st) { st = document.createElement('style'); st.id = 'sbFlagCss'; document.head.appendChild(st) }
  st.textContent = css;
  const root = document.documentElement;
  Object.keys(flags).forEach(k => root.classList.toggle('sbf-off-' + k, !flagOn(k)));
  document.querySelectorAll('[data-flag]').forEach(e => { e.style.display = flagOn(e.getAttribute('data-flag')) ? '' : 'none' });
  Object.keys(TABVIEW).forEach(k => { if (!flagOn(k) && window.view === TABVIEW[k]) { try { window.go('day') } catch (e) {} } });
}

/* ---------- overlays (maintenance, update) ---------- */
const CSS = `
#sbAnn{display:grid;gap:8px;margin:0 0 12px}#sbAnn:empty{display:none}
.sbbn{display:flex;gap:10px;align-items:flex-start;padding:12px 12px 12px 14px;border-radius:16px;color:#fff;box-shadow:0 8px 22px -12px #0006;border:1px solid #ffffff26}
.sbbn .tx{flex:1;min-width:0;font-size:.88rem;line-height:1.35}.sbbn b{display:block;font-size:.95rem;margin-bottom:2px}.sbbn .tx span{white-space:pre-wrap;word-break:break-word;opacity:.95}
.sbbn button{background:#ffffff2e;color:#fff;border:0;border-radius:10px;padding:6px 11px;font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;flex:none}
.sbbn .x{width:30px;height:30px;padding:0;display:grid;place-items:center;background:none}.sbbn .x svg{width:16px;height:16px}
.sbbn .lk{margin-top:7px}
.sbtip{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:16px;background:var(--card,#fff);border:1px solid var(--line,#e6e8f2);color:var(--tx,#14152a);font-size:.86rem}
.sbtip i{font-style:normal;font-size:1.2rem;line-height:1}.sbtip .tx{flex:1}.sbtip b{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ac,#6366f1);margin-bottom:2px}
.sbtip button{background:none;border:0;color:var(--mut,#6a6f8a);cursor:pointer;padding:2px}.sbtip button svg{width:16px;height:16px}
.sbov{position:fixed;inset:0;z-index:400;display:grid;place-items:center;padding:calc(var(--sat,0px) + 20px) 20px calc(var(--sab,0px) + 20px);background:var(--bg,#f5f6fb);color:var(--tx,#14152a);overflow:auto;text-align:center}
.sbov .bx{width:min(100%,400px)}.sbov .em{width:72px;height:72px;border-radius:22px;margin:0 auto 18px;display:grid;place-items:center;font-size:2rem;background:linear-gradient(135deg,#6366f1,#a855f7);box-shadow:0 14px 30px -12px #6366f180}
.sbov h2{margin:0 0 8px;font-size:1.4rem}.sbov p{margin:0 0 18px;color:var(--mut,#6a6f8a);white-space:pre-wrap}
.sbov button{display:block;width:100%;margin:8px 0 0;font:inherit;font-weight:600;border:0;border-radius:12px;padding:13px;background:var(--ac,#6366f1);color:#fff;cursor:pointer}
.sbov button.g{background:none;color:var(--mut,#6a6f8a);font-weight:500;font-size:.85rem}
.sbpop{position:fixed;inset:0;z-index:260;display:grid;place-items:center;padding:20px;background:#000a}
.sbpop .cd{width:min(100%,380px);background:var(--card,#fff);color:var(--tx,#14152a);border-radius:22px;overflow:hidden;box-shadow:0 30px 60px -20px #000a}
.sbpop .hd{height:8px}.sbpop .bd{padding:20px}.sbpop h3{margin:0 0 8px;font-size:1.2rem}.sbpop p{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--mut,#6a6f8a);font-size:.95rem}
.sbpop .ac{display:flex;gap:8px;padding:0 20px 20px}.sbpop .ac button{flex:1;font:inherit;font-weight:600;border:0;border-radius:12px;padding:12px;cursor:pointer;background:var(--ac,#6366f1);color:#fff}.sbpop .ac button.g{background:var(--bg,#f5f6fb);color:var(--tx,#14152a)}
#sbPanel{position:fixed;inset:0;z-index:250;background:var(--bg,#f5f6fb);color:var(--tx,#14152a);display:flex;flex-direction:column}
#sbPanel[hidden]{display:none}
.sbph{display:flex;align-items:center;gap:8px;padding:calc(var(--sat,0px) + 10px) 12px 10px;border-bottom:1px solid var(--line,#e6e8f2);background:var(--card,#fff)}
.sbph button{width:40px;height:40px;border-radius:12px;border:1px solid var(--line,#e6e8f2);background:var(--bg,#f5f6fb);color:var(--tx,#14152a);display:grid;place-items:center;cursor:pointer;padding:0}.sbph button svg{width:20px;height:20px}
.sbph h2{margin:0;font-size:1.1rem}
.sbpb{flex:1;overflow:auto;padding:16px 16px calc(var(--sab,0px) + 24px);max-width:640px;width:100%;margin:0 auto}
.sbit{background:var(--card,#fff);border:1px solid var(--line,#e6e8f2);border-radius:16px;padding:13px 14px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start}
.sbit.un{border-color:var(--ac,#6366f1);box-shadow:0 0 0 3px color-mix(in srgb,var(--ac,#6366f1) 14%,transparent)}
.sbit .em{font-size:1.5rem;line-height:1.1;flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:color-mix(in srgb,var(--ac,#6366f1) 12%,transparent)}
.sbit .tx{flex:1;min-width:0}.sbit b{display:block}.sbit small{color:var(--mut,#6a6f8a);display:block}.sbit p{margin:4px 0 0;font-size:.88rem;color:var(--mut,#6a6f8a);white-space:pre-wrap;word-break:break-word}
.sbit a,.sbit .lb{display:inline-block;margin-top:8px;color:var(--ac,#6366f1);font-weight:600;font-size:.86rem;cursor:pointer;text-decoration:none}
.sbh{margin:18px 2px 8px;font-size:.74rem;text-transform:uppercase;letter-spacing:.07em;color:var(--mut,#6a6f8a);font-weight:700}
.sbemp{text-align:center;color:var(--mut,#6a6f8a);padding:36px 12px}
.sbfm label{display:block;font-size:.82rem;font-weight:600;margin:12px 0 6px}
.sbfm select,.sbfm textarea{width:100%;font:inherit;font-size:16px;padding:12px;border-radius:12px;border:1.5px solid var(--line,#e6e8f2);background:var(--card,#fff);color:var(--tx,#14152a)}
.sbfm textarea{min-height:120px;resize:vertical}
.sbfm .pri{margin-top:14px;width:100%;font:inherit;font-weight:600;border:0;border-radius:12px;padding:13px;background:var(--ac,#6366f1);color:#fff;cursor:pointer}.sbfm .pri:disabled{opacity:.6}
.sbrep{margin-top:8px;padding:9px 11px;border-radius:12px;background:color-mix(in srgb,#16a34a 12%,transparent);font-size:.86rem}.sbrep b{color:#16a34a;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em}
.sbbadge{display:inline-block;min-width:18px;padding:1px 6px;border-radius:999px;background:#ef4444;color:#fff;font-size:.7rem;font-weight:700;text-align:center;margin-left:6px;vertical-align:middle}
.sbchip{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--sab,0px) + 78px);z-index:240;background:#d97706;color:#fff;padding:6px 12px;border-radius:999px;font-size:.78rem;font-weight:600;box-shadow:0 6px 16px -6px #0007}
`;
function gate(id, o) {
  let e = $(id);
  if (!o) { if (e) e.remove(); return }
  if (!e) { e = document.createElement('div'); e.id = id; e.className = 'sbov'; document.body.appendChild(e) }
  const sig = JSON.stringify(o); if (e.dataset.sig === sig) return; e.dataset.sig = sig;
  e.innerHTML = '<div class="bx"><div class="em">' + esc(o.emoji || '⚙') + '</div><h2>' + esc(o.title) + '</h2><p>' + esc(o.body) + '</p>' +
    (o.btn ? '<button id="' + id + 'B">' + esc(o.btn) + '</button>' : '') + (o.sec ? '<button class="g" id="' + id + 'S">' + esc(o.sec) + '</button>' : '') + '</div>';
  if (o.btn) $(id + 'B').onclick = o.fn; if (o.sec) $(id + 'S').onclick = o.fn2;
}
function checkGates() {
  const m = cfgApp.maintenance || {};
  const pass = bypass && (!uid || !adminChecked || isAdmin);
  if (m.on && !pass) gate('sbMaint', {
    emoji: '🛠', title: m.title || 'Back soon', body: m.message || 'Syllabuzz is being updated. Please check back in a little while.',
    btn: 'Try again', fn: () => location.reload(), sec: 'I am an admin', fn2: () => { bypass = true; checkGates() }
  }); else gate('sbMaint', null);
  const pl = cfgApp[PLAT] || {};
  const need = pl.minVersion && cmp(VER, pl.minVersion) < 0;
  if (need && !(isAdmin && bypass)) gate('sbUpd', {
    emoji: '⬆', title: 'Update required', body: pl.message || 'This version of Syllabuzz is no longer supported. Please update to keep using the app.',
    btn: APP ? 'Update now' : 'Reload', fn: () => { if (APP && pl.updateUrl) openLink(pl.updateUrl); else location.reload() }
  }); else gate('sbUpd', null);
  admChip();
}
function admChip() {
  const m = cfgApp.maintenance || {}; let c = $('sbChip');
  if (m.on && isAdmin && bypass) { if (!c) { c = document.createElement('div'); c.id = 'sbChip'; c.className = 'sbchip'; c.textContent = 'Maintenance is ON (admin view)'; document.body.appendChild(c) } }
  else if (c) c.remove();
}

/* ---------- announcements, tip ---------- */
const seen = () => jget('sb_ann_seen', {});
function markSeen(id) { const s = seen(); s[id] = Date.now(); lput('sb_ann_seen', JSON.stringify(s)) }
function annOk(a) {
  if (a.active === false) return false;
  const n = Date.now();
  if (a.startsAt && n < a.startsAt) return false;
  if (a.endsAt && n > a.endsAt) return false;
  const aud = a.audience || 'all';
  if (aud === 'android' && !APP) return false;
  if (aud === 'web' && APP) return false;
  if (aud === 'role' && (((window.SBProfile || {}).role || '') !== (a.role || '\u0000'))) return false;
  if (a.minVersion && cmp(VER, a.minVersion) < 0) return false;
  if (a.maxVersion && cmp(VER, a.maxVersion) > 0) return false;
  return true;
}
const visible = () => anns.filter(annOk).sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || tsMs(b.createdAt) - tsMs(a.createdAt));
function ensureHost() {
  let h = $('sbAnn'); if (h) return h;
  const out = $('out'); if (!out || !out.parentNode) return null;
  h = document.createElement('div'); h.id = 'sbAnn'; out.parentNode.insertBefore(h, out); return h;
}
function tipOfDay() {
  if (!flagOn('feat_tips')) return null;
  const t = content.filter(c => c.type === 'tip' && c.active !== false); if (!t.length) return null;
  const d = new Date(); const n = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
  return t[n % t.length];
}
function drawBanners() {
  const h = ensureHost(); if (!h) return;
  if (!uid) { h.innerHTML = ''; return }
  const s = seen(); let html = '';
  visible().filter(a => (a.style || 'banner') === 'banner' && !(a.dismissible !== false && s[a.id])).forEach(a => {
    const c = KIND[a.kind] || KIND.info;
    html += '<div class="sbbn" style="background:' + c + '"><div class="tx"><b>' + esc(a.title) + '</b><span>' + esc(a.body || '') + '</span>' +
      (a.link ? '<div class="lk"><button data-l="' + esc(a.link) + '">' + esc(a.linkText || 'Open') + '</button></div>' : '') + '</div>' +
      (a.dismissible !== false ? '<button class="x" data-x="' + esc(a.id) + '" aria-label="Dismiss">' + ic('sbx') + '</button>' : '') + '</div>';
  });
  const up = (cfgApp[PLAT] || {}).latestVersion;
  if (up && cmp(VER, up) < 0 && !s['upd' + up]) html += '<div class="sbbn" style="background:#4f46e5"><div class="tx"><b>Update available</b><span>Version ' + esc(up) + ' is out.</span>' + ((cfgApp[PLAT] || {}).updateUrl ? '<div class="lk"><button data-l="' + esc(cfgApp[PLAT].updateUrl) + '">Get it</button></div>' : '') + '</div><button class="x" data-x="upd' + esc(up) + '" aria-label="Dismiss">' + ic('sbx') + '</button></div>';
  const tp = tipOfDay(), day = new Date().toDateString();
  if (tp && lget('sb_tip_seen') !== day) html += '<div class="sbtip"><i>' + esc(tp.emoji || '💡') + '</i><div class="tx"><b>Tip of the day</b>' + esc(tp.title) + (tp.body ? ' – ' + esc(tp.body) : '') + '</div><button data-t="1" aria-label="Dismiss">' + ic('sbx') + '</button></div>';
  h.innerHTML = html;
  h.querySelectorAll('[data-l]').forEach(b => b.onclick = () => openLink(b.dataset.l));
  h.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { markSeen(b.dataset.x); drawBanners(); rerender() });
  h.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { lput('sb_tip_seen', day); drawBanners() });
}
function nextPopup() {
  if ($('sbPop') || $('sbMaint') || $('sbUpd') || !uid) return;
  const a0 = $('sbAuth'); if (a0 && !a0.hidden) return;
  const tr = $('tr'); if (tr && !tr.hidden) return;                /* wait until the first-run tour is closed */
  const dg = document.querySelector('dialog[open]'); if (dg) return;
  const s = seen();
  const a = visible().find(x => x.style === 'popup' && !s[x.id]); if (!a) return;
  const c = KIND[a.kind] || KIND.info, p = document.createElement('div'); p.id = 'sbPop'; p.className = 'sbpop';
  p.innerHTML = '<div class="cd" role="dialog" aria-modal="true"><div class="hd" style="background:' + c + '"></div><div class="bd"><h3>' + esc(a.title) + '</h3><p>' + esc(a.body || '') + '</p></div><div class="ac">' +
    '<button class="g" id="sbPopX">' + (a.link ? 'Close' : 'Got it') + '</button>' + (a.link ? '<button id="sbPopL">' + esc(a.linkText || 'Open') + '</button>' : '') + '</div></div>';
  document.body.appendChild(p);
  const done = () => { markSeen(a.id); p.remove(); rerender(); setTimeout(nextPopup, 300) };
  $('sbPopX').onclick = done; if (a.link) $('sbPopL').onclick = () => { openLink(a.link); done() };
}

/* ---------- settings rows + panels ---------- */
const unread = () => inbox.filter(m => !m.read).length;
const noticeCount = () => unread() + visible().filter(a => !seen()[a.id]).length;
window.sbNoticeCount = noticeCount;
function row(icon, title, sub, fn) {
  return '<button class="g sr" onclick="' + fn + '"><span class="si">' + ic(icon) + '</span><span class="sx"><b>' + title + '</b><small>' + sub + '</small></span>' + ic('right', 'ch') + '</button>';
}
window.sbExtraRows = function () {
  if (!uid) return '';
  let h = '';
  if (flagOn('feat_notices')) { const n = noticeCount(); h += row('sbmega', 'Notices' + (n ? '<span class="sbbadge">' + n + '</span>' : ''), 'Announcements and messages', "sbPanel('notices')") }
  if (flagOn('feat_resources') && content.some(c => c.type === 'resource' && c.active !== false)) h += row('sbcompass', 'Campus resources', 'Useful links and guides', "sbPanel('resources')");
  if (flagOn('feat_feedback')) h += row('sbmsg', 'Send feedback', 'Report a problem or suggest an idea', "sbPanel('feedback')");
  return h;
};
function rerender() { try { window.sbRerender && window.sbRerender() } catch (e) {} }
function shell(title) {
  let p = $('sbPanel');
  if (!p) { p = document.createElement('div'); p.id = 'sbPanel'; document.body.appendChild(p) }
  p.hidden = false;
  p.innerHTML = '<div class="sbph"><button id="sbPb" aria-label="Back">' + ic('sbback') + '</button><h2>' + esc(title) + '</h2></div><div class="sbpb" id="sbPbd"></div>';
  $('sbPb').onclick = closePanel; return $('sbPbd');
}
function closePanel() { const p = $('sbPanel'); if (p) p.hidden = true; panel = ''; if (unsubMine) { unsubMine(); unsubMine = null } rerender() }
window.sbRemoteBack = () => { const p = $('sbPanel'); if (p && !p.hidden) { closePanel(); return true } const o = $('sbPop'); if (o) { o.querySelector('#sbPopX').click(); return true } return false };
window.sbPanel = function (name) { panel = name; draw() };
function draw() {
  if (!panel) return;
  if (panel === 'notices') drawNotices(); else if (panel === 'resources') drawResources(); else if (panel === 'feedback') drawFeedback();
}
function bindLinks(b) { b.querySelectorAll('[data-l]').forEach(e => e.onclick = () => openLink(e.dataset.l)) }
function drawNotices() {
  const b = shell('Notices'); let h = '';
  const ms = inbox.slice().sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
  if (ms.length) {
    h += '<div class="sbh">Messages for you</div>';
    ms.forEach(m => { h += '<div class="sbit' + (m.read ? '' : ' un') + '"><div class="em">✉</div><div class="tx"><b>' + esc(m.title || 'Message') + '</b><small>' + when(tsMs(m.createdAt) || Date.now()) + '</small>' + (m.body ? '<p>' + esc(m.body) + '</p>' : '') + (m.link ? '<a data-l="' + esc(m.link) + '">' + esc(m.linkText || 'Open') + '</a>' : '') + '</div></div>' });
  }
  const as = visible();
  if (as.length) {
    h += '<div class="sbh">Announcements</div>';
    as.forEach(a => { h += '<div class="sbit"><div class="em" style="background:' + (KIND[a.kind] || KIND.info) + '22">' + ({ success: '✅', warning: '⚠', urgent: '🚨', promo: '🎉' }[a.kind] || '📣') + '</div><div class="tx"><b>' + esc(a.title) + '</b><small>' + when(tsMs(a.createdAt) || Date.now()) + '</small>' + (a.body ? '<p>' + esc(a.body) + '</p>' : '') + (a.link ? '<a data-l="' + esc(a.link) + '">' + esc(a.linkText || 'Open') + '</a>' : '') + '</div></div>' });
  }
  if (!ms.length && !as.length) h = '<div class="sbemp">🔔<br>You are all caught up.</div>';
  b.innerHTML = h; bindLinks(b);
  as.forEach(a => markSeen(a.id));
  if (H && uid) inbox.filter(m => !m.read).forEach(m => { try { H.F.updateDoc(H.F.doc(H.db, 'users', uid, 'inbox', m.id), { read: true }) } catch (e) {} });
}
function drawResources() {
  const b = shell('Campus resources'); let h = '';
  const tp = tipOfDay(); if (tp) h += '<div class="sbtip" style="margin-bottom:14px"><i>' + esc(tp.emoji || '💡') + '</i><div class="tx"><b>Tip of the day</b>' + esc(tp.title) + (tp.body ? ' – ' + esc(tp.body) : '') + '</div></div>';
  const rs = content.filter(c => c.type === 'resource' && c.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.title).localeCompare(b.title));
  const cats = {}; rs.forEach(r => { (cats[r.category || 'General'] = cats[r.category || 'General'] || []).push(r) });
  Object.keys(cats).forEach(c => {
    h += '<div class="sbh">' + esc(c) + '</div>';
    cats[c].forEach(r => { h += '<div class="sbit"><div class="em">' + esc(r.emoji || '🔗') + '</div><div class="tx"><b>' + esc(r.title) + '</b>' + (r.body ? '<p>' + esc(r.body) + '</p>' : '') + (r.url ? '<a data-l="' + esc(r.url) + '">Open</a>' : '') + '</div></div>' });
  });
  if (!rs.length) h += '<div class="sbemp">Nothing here yet.</div>';
  b.innerHTML = h; bindLinks(b);
}
function drawFeedback() {
  const b = shell('Send feedback'), sup = cfgApp.support || {};
  let h = '<form class="sbfm" id="sbFbF"><label for="sbFbK">What is it about?</label><select id="sbFbK"><option value="idea">An idea</option><option value="bug">A problem</option><option value="question">A question</option><option value="other">Something else</option></select>' +
    '<label for="sbFbM">Your message</label><textarea id="sbFbM" maxlength="1000" placeholder="Tell us what happened or what you would like to see…"></textarea>' +
    '<button class="pri" id="sbFbS" type="submit">Send</button></form>';
  if (sup.email || sup.whatsapp) {
    h += '<div class="sbh">Need a faster answer?</div>';
    if (sup.email) h += '<div class="sbit"><div class="em">✉</div><div class="tx"><b>Email support</b><small>' + esc(sup.email) + '</small><a data-l="mailto:' + esc(sup.email) + '">Write an email</a></div></div>';
    if (sup.whatsapp) h += '<div class="sbit"><div class="em">💬</div><div class="tx"><b>WhatsApp</b><small>' + esc(sup.whatsapp) + '</small><a data-l="https://wa.me/' + esc(String(sup.whatsapp).replace(/\D/g, '')) + '">Chat with us</a></div></div>';
  }
  h += '<div id="sbFbL"></div>';
  b.innerHTML = h; bindLinks(b);
  $('sbFbF').onsubmit = async e => {
    e.preventDefault(); const m = $('sbFbM').value.trim(); if (m.length < 3) return;
    if (Date.now() - (+lget('sb_fb_t') || 0) < 20000) return window.toast && toast('Please wait a moment', 'before sending another message.');
    $('sbFbS').disabled = true;
    try {
      const u = window.SBUser || {};
      await H.F.addDoc(H.F.collection(H.db, 'feedback'), { uid, email: u.email || '', name: u.name || '', kind: $('sbFbK').value, message: m, platform: PLAT, appVersion: VER, createdAt: H.F.serverTimestamp(), status: 'new' });
      lput('sb_fb_t', String(Date.now())); $('sbFbM').value = ''; window.toast && toast('Thank you!', 'Your message was sent.');
    } catch (x) { window.toast && toast('Could not send', 'Check your connection and try again.') }
    $('sbFbS').disabled = false;
  };
  if (unsubMine) unsubMine();
  unsubMine = H.F.onSnapshot(H.F.query(H.F.collection(H.db, 'feedback'), H.F.where('uid', '==', uid)), s => {
    mine = s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
    const L = $('sbFbL'); if (!L || panel !== 'feedback') return;
    L.innerHTML = mine.length ? '<div class="sbh">Your messages</div>' + mine.map(f => '<div class="sbit"><div class="em">' + ({ bug: '🐞', idea: '💡', question: '❓' }[f.kind] || '💬') + '</div><div class="tx"><small>' + when(tsMs(f.createdAt) || Date.now()) + ' · ' + (f.status === 'done' ? 'Resolved' : f.status === 'seen' ? 'Seen' : 'Sent') + '</small><p style="margin-top:2px">' + esc(f.message) + '</p>' + (f.reply ? '<div class="sbrep"><b>Reply</b><br>' + esc(f.reply) + '</div>' : '') + '</div></div>').join('') : '';
  }, () => {});
}

/* ---------- data listeners ---------- */
function stopAll(list) { list.forEach(u => { try { u() } catch (e) {} }); list.length = 0 }
let lastSig = '';
function refreshUi() {
  clearTimeout(rTimer);
  rTimer = setTimeout(() => {
    applyFlags(); checkGates(); drawBanners(); nextPopup(); if (panel === 'notices' || panel === 'resources') draw();
    const sig = [noticeCount(), content.length, JSON.stringify(flags), (cfgApp.support || {}).email].join('|');
    try { if (window.updNtBadge) window.updNtBadge() } catch (e) {}
    if (sig !== lastSig) { lastSig = sig; rerender() }      /* only redraw Settings when its rows changed */
  }, 120);
}
function startConfig() {
  stopAll(unsubCfg); const { F, db } = H;
  unsubCfg.push(F.onSnapshot(F.doc(db, 'config', 'app'), s => { cfgApp = s.exists() ? s.data() : {}; refreshUi() }, () => {}));
  unsubCfg.push(F.onSnapshot(F.doc(db, 'config', 'flags'), s => { flags = (s.exists() && s.data().items) || {}; refreshUi() }, () => {}));
}
function startUser() {
  stopAll(unsubs); const { F, db } = H;
  unsubs.push(F.onSnapshot(F.collection(db, 'announcements'), s => { anns = s.docs.map(d => Object.assign({ id: d.id }, d.data())); refreshUi() }, () => {}));
  unsubs.push(F.onSnapshot(F.collection(db, 'content'), s => { content = s.docs.map(d => Object.assign({ id: d.id }, d.data())); refreshUi() }, () => {}));
  inboxReady = false;
  unsubs.push(F.onSnapshot(F.collection(db, 'users', uid, 'inbox'), s => {
    const fresh = inboxReady ? s.docChanges().filter(c => c.type === 'added' && !c.doc.data().read && !c.doc.metadata.hasPendingWrites) : [];
    inbox = s.docs.map(d => Object.assign({ id: d.id }, d.data())); inboxReady = true;
    fresh.forEach(c => { try { window.toast(c.doc.data().title || 'New message', c.doc.data().body || '') } catch (e) {} });
    refreshUi();
  }, () => {}));
  F.getDoc(F.doc(db, 'admins', uid)).then(d => { isAdmin = d.exists(); adminChecked = true; refreshUi() }).catch(() => { adminChecked = true });
}
function userChanged() {
  const u = window.SBUser; const nu = u ? u.uid : '';
  if (nu === uid) return; uid = nu;
  if (!H) return;
  if (uid) startUser(); else { stopAll(unsubs); anns = []; content = []; inbox = []; isAdmin = false; adminChecked = false; closePanel(); refreshUi() }
}
function init() {
  if (H || !window.SBFire) return;
  H = window.SBFire; icons();
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  startConfig(); userChanged();
  document.addEventListener('sb-user', userChanged);
  document.addEventListener('sb-profile', refreshUi);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshUi() });
  setInterval(nextPopup, 5000);
  setInterval(refreshUi, 60000);          /* scheduled announcements start and expire on time */
}
if (window.SBFire) init(); else document.addEventListener('sb-fire', init);
})();
