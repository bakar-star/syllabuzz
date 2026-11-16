(function () {
"use strict";
/* Syllabuzz accounts + cloud sync (Firebase Auth + Firestore).
   Local first: the app keeps using localStorage; this file mirrors the synced keys to
   users/{uid}/data/{key} and applies changes that arrive from other devices or the dashboard.

   3.2: new responsive login page, working Google sign-in (the popup resolver was missing),
        no more login flash on start (splash until the session is known), no reload loops,
        "Later" on the accounts pop-up is remembered, hooks for remote.js (announcements etc). */
const CFG = window.SB_CONFIG || {};
const FB = CFG.firebase || {};
const VER = '3.2';
window.SB_VER = VER;
const APP = !!window.AndroidBridge;
const SYNC = ['tt', 'tth', 'tta', 'ttsem', 'tas', 'ttl', 'ttk', 'ttf', 'tsh'];
const CDN = 'https://www.gstatic.com/firebasejs/10.14.1/';
const LS = localStorage;
const _set = Storage.prototype.setItem, _rm = Storage.prototype.removeItem;
const lget = k => { try { return LS.getItem(k) } catch (e) { return null } };
const lput = (k, v) => { try { _set.call(LS, k, v) } catch (e) {} };
const ldel = k => { try { _rm.call(LS, k) } catch (e) {} };
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const configured = FB.apiKey && !/^YOUR_/.test(FB.apiKey);
let DEV = lget('sb_dev'); if (!DEV) { DEV = Math.random().toString(36).slice(2, 10); lput('sb_dev', DEV) }

let F = null, auth, db, user = null, unsubData = null, unsubProf = null;
let reconciled = false, status = '', pendingName = '', gateMode = false, flushT = null, lastSync = 0;
let dirty = new Set(); try { dirty = new Set(JSON.parse(lget('sb_dirty') || '[]')) } catch (e) {}
let applying = false, resolved = false, outT = null, lastProf = 0;
const saveDirty = () => lput('sb_dirty', JSON.stringify([...dirty]));

/* ---- track local writes to the synced keys ---- */
Storage.prototype.setItem = function (k, v) { _set.call(this, k, v); if (this === LS && !applying) mark(k) };
Storage.prototype.removeItem = function (k) { _rm.call(this, k); if (this === LS && !applying) mark(k) };
function mark(k) {
  if (!user || SYNC.indexOf(k) < 0) return;
  dirty.add(k); saveDirty(); clearTimeout(flushT); flushT = setTimeout(flush, 1800);
}

/* ================= UI ================= */
const css = `
#sbSplash,#sbAuth{--sbbg:#f5f6fb;--sbcard:#fff;--sbtx:#14152a;--sbmut:#6a6f8a;--sbline:#dfe2ee;--sbac:#5b5bf0}
:root[data-theme="dark"] #sbSplash,:root[data-theme="dark"] #sbAuth{--sbbg:#0b0c14;--sbcard:#151727;--sbtx:#eef0ff;--sbmut:#9498b8;--sbline:#262a45;--sbac:#818cf8}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) #sbSplash,:root:not([data-theme="light"]) #sbAuth{--sbbg:#0b0c14;--sbcard:#151727;--sbtx:#eef0ff;--sbmut:#9498b8;--sbline:#262a45;--sbac:#818cf8}}
#sbSplash{position:fixed;inset:0;z-index:310;display:grid;place-items:center;background:var(--sbbg);transition:opacity .25s}
#sbSplash.out{opacity:0;pointer-events:none}
#sbSplash svg{width:64px;height:64px;animation:sbpulse 1.4s ease-in-out infinite}
@keyframes sbpulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.9);opacity:.7}}
#sbAuth{position:fixed;inset:0;z-index:300;display:flex;background:var(--sbbg);color:var(--sbtx);overflow:auto;-webkit-overflow-scrolling:touch;font-family:inherit}
#sbAuth[hidden],#sbAuth [hidden]{display:none!important}
#sbAuth *{box-sizing:border-box}
.sbhero{display:none;position:relative;overflow:hidden;color:#fff;background:linear-gradient(145deg,#4f46e5 0%,#7c3aed 55%,#c026d3 100%);padding:56px 56px;flex-direction:column;justify-content:space-between}
.sbhero:before,.sbhero:after{content:"";position:absolute;border-radius:50%;background:#fff;opacity:.09}
.sbhero:before{width:420px;height:420px;right:-140px;top:-120px}.sbhero:after{width:300px;height:300px;left:-100px;bottom:-90px}
.sbhero>*{position:relative;z-index:1}
.sbhero .sbbrand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:1.25rem}
.sbhero .sbbrand svg{width:40px;height:40px}
.sbhero h2{font-size:2.3rem;line-height:1.15;margin:0 0 14px;letter-spacing:-.02em}
.sbhero p.lead{margin:0 0 28px;opacity:.88;font-size:1.05rem;max-width:30ch}
.sbhero ul{list-style:none;margin:0;padding:0;display:grid;gap:14px}
.sbhero li{display:flex;align-items:center;gap:12px;font-size:.98rem}
.sbhero li i{flex:none;width:32px;height:32px;border-radius:10px;background:#ffffff26;display:grid;place-items:center}
.sbhero li svg{width:18px;height:18px}
.sbhero small{opacity:.7}
.sbpane{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:calc(var(--sat,0px) + 28px) 20px calc(var(--sab,0px) + 28px);min-height:100%;min-width:0}
.sbc{width:100%;max-width:400px;position:relative}
.sbmob{display:flex;flex-direction:column;align-items:center;margin-bottom:22px;text-align:center}
.sbmob svg{width:56px;height:56px;margin-bottom:10px;filter:drop-shadow(0 8px 16px #6366f14d)}
.sbmob b{font-size:1.45rem;letter-spacing:-.01em}
.sbc h1{margin:0 0 4px;font-size:1.65rem;letter-spacing:-.02em;line-height:1.2}
.sbsub{margin:0 0 22px;color:var(--sbmut);font-size:.95rem}
.sbtabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:14px;background:var(--sbcard);border:1px solid var(--sbline);margin-bottom:18px}
#sbAuth .sbtabs button{background:none;border:0;box-shadow:none;color:var(--sbmut);padding:10px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;-webkit-backdrop-filter:none;backdrop-filter:none}
#sbAuth .sbtabs button.on{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;box-shadow:0 6px 14px -6px #6d4df0}
#sbAuth .sbbtn{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;font:inherit;font-weight:600;padding:13px 16px;border-radius:12px;border:1px solid transparent;cursor:pointer;min-height:48px;transition:transform .1s,box-shadow .15s,opacity .15s;-webkit-backdrop-filter:none;backdrop-filter:none}
#sbAuth .sbbtn:active{transform:scale(.985)}
#sbAuth .sbbtn:disabled{opacity:.6;cursor:default}
#sbAuth .sbpri{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;box-shadow:0 10px 24px -10px #6d4df0}
#sbAuth .sbgg{background:#fff;color:#3c4043;border-color:#dadce0;box-shadow:0 1px 2px #0001}
:root[data-theme="dark"] #sbAuth .sbgg{background:#fff}
#sbAuth .sbgg:hover{box-shadow:0 2px 8px #0002}
.sbor{display:flex;align-items:center;gap:12px;color:var(--sbmut);font-size:.8rem;margin:18px 0}
.sbor:before,.sbor:after{content:"";flex:1;height:1px;background:var(--sbline)}
.sbf{margin-bottom:14px}
.sbf label{display:block;font-size:.82rem;font-weight:600;margin:0 0 6px;color:var(--sbtx)}
.sbw{position:relative}
.sbw>svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);width:18px;height:18px;color:var(--sbmut);pointer-events:none}
#sbAuth .sbw input{width:100%;font:inherit;font-size:16px;padding:13px 44px 13px 42px;border-radius:12px;border:1.5px solid var(--sbline);background:var(--sbcard);color:var(--sbtx);margin:0;min-height:48px;appearance:none;-webkit-appearance:none}
#sbAuth .sbw input::placeholder{color:var(--sbmut);opacity:.7}
#sbAuth .sbw input:focus{outline:0;border-color:var(--sbac);box-shadow:0 0 0 4px color-mix(in srgb,var(--sbac) 20%,transparent)}
.sbf.err input{border-color:#ef4444}
.sbe{display:none;color:#ef4444;font-size:.8rem;margin:5px 2px 0}
.sbf.err .sbe{display:block}
#sbAuth .sbeye{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:40px;height:40px;border:0;background:none;color:var(--sbmut);display:grid;place-items:center;border-radius:10px;cursor:pointer;padding:0;box-shadow:none}
#sbAuth .sbeye svg{width:19px;height:19px}
.sbstr{display:flex;gap:4px;margin-top:8px}
.sbstr i{flex:1;height:4px;border-radius:2px;background:var(--sbline);transition:background .2s}
.sbstr.s1 i:nth-child(-n+1){background:#ef4444}.sbstr.s2 i:nth-child(-n+2){background:#f59e0b}.sbstr.s3 i:nth-child(-n+3){background:#84cc16}.sbstr.s4 i{background:#16a34a}
.sbstt{font-size:.76rem;color:var(--sbmut);margin-top:4px}
.sbm{display:none;margin:0 0 14px;padding:11px 13px;border-radius:12px;font-size:.88rem;line-height:1.35;background:color-mix(in srgb,#ef4444 12%,transparent);color:#dc2626;border:1px solid color-mix(in srgb,#ef4444 30%,transparent)}
.sbm.on{display:block}
.sbm.ok{background:color-mix(in srgb,#16a34a 12%,transparent);color:#15803d;border-color:color-mix(in srgb,#16a34a 30%,transparent)}
:root[data-theme="dark"] .sbm{color:#fca5a5}:root[data-theme="dark"] .sbm.ok{color:#86efac}
#sbAuth .sblnk{background:none;border:0;box-shadow:none;color:var(--sbac);font:inherit;font-size:.88rem;font-weight:600;cursor:pointer;padding:6px 2px;-webkit-backdrop-filter:none;backdrop-filter:none}
.sbrow{display:flex;justify-content:flex-end;margin:-4px 0 14px}
.sbfoot{margin:20px 0 0;text-align:center;color:var(--sbmut);font-size:.78rem;line-height:1.5}
.sbfoot a{color:inherit}
#sbAuth .sbx{position:absolute;right:0;top:-6px;width:40px;height:40px;border-radius:50%;border:1px solid var(--sbline);background:var(--sbcard);color:var(--sbtx);display:grid;place-items:center;cursor:pointer;padding:0;z-index:2}
.sbspin{width:18px;height:18px;border-radius:50%;border:2.5px solid currentColor;border-right-color:transparent;animation:sbrot .7s linear infinite;flex:none}
@keyframes sbrot{to{transform:rotate(360deg)}}
.sbwait{display:none;text-align:center;padding:18px 14px;border-radius:14px;border:1px dashed var(--sbline);margin-bottom:14px;font-size:.9rem;color:var(--sbmut)}
.sbwait.on{display:block}.sbwait .sbspin{display:inline-block;color:var(--sbac);margin-bottom:8px;width:24px;height:24px}
.sbwait b{display:block;color:var(--sbtx);margin-bottom:2px}
.sbav{width:56px;height:56px;border-radius:50%;background:var(--sbac);color:#fff;display:grid;place-items:center;font-size:1.4rem;font-weight:700;margin:0 auto 8px;overflow:hidden}
.sbav img{width:100%;height:100%;object-fit:cover}
@media(min-width:900px){.sbhero{display:flex;flex:1.05;max-width:640px}.sbmob{display:none}.sbpane{flex:1}}
@media(max-width:380px){.sbc h1{font-size:1.45rem}.sbpane{padding-left:14px;padding-right:14px}}
@media(max-height:560px) and (orientation:landscape){.sbpane{justify-content:flex-start}.sbmob{flex-direction:row;gap:10px;margin-bottom:14px}.sbmob svg{width:36px;height:36px;margin:0}}
@media(prefers-reduced-motion:reduce){#sbSplash svg,.sbspin{animation:none}}
`;
const G = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.6z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 010-9.4l-7.9-6.1a24 24 0 000 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';
const LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="14" fill="#7061f2"/><path d="M24 11c-5.5 0-9 4-9 9.5V27l-2.5 3.5h23L33 27v-6.5C33 15 29.5 11 24 11z" fill="#fff"/><path d="M20.5 34a3.5 3.5 0 007 0z" fill="#fff"/></svg>';
const IC = {
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 7l9 6 9-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.4 10.4 0 0112 19c-6.4 0-10-7-10-7a17.6 17.6 0 014.1-4.9M9.9 5.2A9.7 9.7 0 0112 5c6.4 0 10 7 10 7a17.7 17.7 0 01-2.2 3.2M3 3l18 18"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>',
  task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 01-15.5 6.2L3 16M3 12a9 9 0 0115.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>'
};
function field(id, label, type, ph, ac, icon, extra) {
  return '<div class="sbf" id="f_' + id + '"><label for="' + id + '">' + label + '</label><div class="sbw">' + IC[icon] +
    '<input id="' + id + '" type="' + type + '" placeholder="' + ph + '" autocomplete="' + ac + '" autocapitalize="none" spellcheck="false"' + (type === 'email' ? ' inputmode="email"' : '') + '>' + (extra || '') +
    '</div><div class="sbe" id="e_' + id + '"></div></div>';
}
function buildUi() {
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const sp = document.createElement('div'); sp.id = 'sbSplash'; sp.innerHTML = LOGO; sp.setAttribute('aria-hidden', 'true'); document.body.appendChild(sp);
  const a = document.createElement('div'); a.id = 'sbAuth'; a.hidden = true; a.setAttribute('role', 'dialog'); a.setAttribute('aria-label', 'Log in to Syllabuzz');
  a.innerHTML =
    '<aside class="sbhero"><div class="sbbrand">' + LOGO + 'Syllabuzz</div>' +
    '<div><h2>Your week,<br>right on time.</h2><p class="lead">Classes, assignments and study cards in one calm place, backed up and synced everywhere.</p>' +
    '<ul><li><i>' + IC.cal + '</i>Timetable with smart reminders</li><li><i>' + IC.task + '</i>Assignments and deadlines</li><li><i>' + IC.sync + '</i>Sync across all your devices</li></ul></div>' +
    '<small>© Syllabuzz</small></aside>' +
    '<main class="sbpane"><div class="sbc">' +
    '<button class="sbx" id="sbClose" aria-label="Close" type="button">✕</button>' +
    '<div class="sbmob">' + LOGO + '<b>Syllabuzz</b></div>' +
    '<h1 id="sbH">Welcome back</h1><p class="sbsub" id="sbSub"></p>' +
    '<div class="sbtabs" role="tablist"><button id="sbTi" class="on" type="button" role="tab">Log in</button><button id="sbTu" type="button" role="tab">Sign up</button></div>' +
    '<div class="sbwait" id="sbWait"><span class="sbspin"></span><b>Waiting for Google…</b>Finish signing in in your browser, then come back here.<br><button class="sblnk" id="sbWc" type="button">Cancel</button></div>' +
    '<button class="sbbtn sbgg" id="sbG" type="button">' + G + '<span id="sbGt">Continue with Google</span></button>' +
    '<div class="sbor">or with email</div>' +
    '<div class="sbm" id="sbMsg" role="status" aria-live="polite"></div>' +
    '<form id="sbForm" novalidate>' +
    '<div id="sbNameBox" hidden>' + field('sbName', 'Full name', 'text', 'Your name', 'name', 'user') + '</div>' +
    field('sbEm', 'Email', 'email', 'you@example.com', 'email', 'mail') +
    field('sbPw', 'Password', 'password', 'Enter your password', 'current-password', 'lock', '<button type="button" class="sbeye" id="sbEye" aria-label="Show password">' + IC.eye + '</button>') +
    '<div id="sbStrBox" hidden><div class="sbstr" id="sbStr"><i></i><i></i><i></i><i></i></div><div class="sbstt" id="sbStt">Use 8+ characters with letters and numbers.</div></div>' +
    '<div class="sbrow" id="sbFgRow"><button class="sblnk" id="sbFg" type="button">Forgot password?</button></div>' +
    '<button class="sbbtn sbpri" id="sbGo" type="submit"><span id="sbGoT">Log in</span></button></form>' +
    '<p class="sbfoot" id="sbFoot"></p>' +
    '</div></main>';
  document.body.appendChild(a);
  const u = document.createElement('dialog'); u.id = 'sbUp';
  u.innerHTML = '<div><h2 style="margin:0 0 6px;font-size:1.15rem">Syllabuzz now has accounts</h2>' +
    '<p style="color:var(--mut);font-size:.9rem;margin:0 0 6px">Create a free account to back up your timetable, assignments and study cards, and use them on all your devices.</p>' +
    '<p style="color:var(--mut);font-size:.9rem;margin:0">Everything you already have stays put and is uploaded to your new account.</p>' +
    '<div class="act" style="flex-wrap:wrap"><button class="g" id="sbUpL">Later</button><button class="g" id="sbUpI">Log in</button><button id="sbUpS">Create account</button></div></div>';
  document.body.appendChild(u);
  const c = document.createElement('dialog'); c.id = 'sbAc'; document.body.appendChild(c);

  $('sbTi').onclick = () => tab('in'); $('sbTu').onclick = () => tab('up');
  $('sbClose').onclick = () => closeAuth();
  $('sbG').onclick = google; $('sbFg').onclick = forgot; $('sbWc').onclick = () => { setWait(false); ldel('sb_state') };
  $('sbForm').onsubmit = e => { e.preventDefault(); submit() };
  $('sbEye').onclick = () => {
    const p = $('sbPw'), s = p.type === 'password'; p.type = s ? 'text' : 'password';
    $('sbEye').innerHTML = s ? IC.eyeoff : IC.eye; $('sbEye').setAttribute('aria-label', s ? 'Hide password' : 'Show password');
  };
  $('sbPw').oninput = () => { fieldErr('sbPw', ''); if (mode === 'up') strength($('sbPw').value) };
  $('sbEm').oninput = () => fieldErr('sbEm', ''); $('sbName').oninput = () => fieldErr('sbName', '');
  $('sbUpL').onclick = () => { lput('sb_later', String(Date.now())); u.close() };
  $('sbUpI').onclick = () => { u.close(); openAuth('in') };
  $('sbUpS').onclick = () => { u.close(); openAuth('up') };
  u.addEventListener('cancel', () => lput('sb_later', String(Date.now())));
}
let mode = 'in', waiting = false, waitT = null;
function strength(p) {
  let s = 0; if (p.length >= 6) s++; if (p.length >= 10) s++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/\d/.test(p) && /[^A-Za-z0-9]|[A-Za-z]/.test(p)) s++;
  if (!p) s = 0; s = Math.min(4, s);
  $('sbStr').className = 'sbstr' + (s ? ' s' + s : '');
  $('sbStt').textContent = p ? ['', 'Weak', 'Fair', 'Good', 'Strong'][s] + (s < 3 ? ' – add length, numbers or capitals' : '') : 'Use 8+ characters with letters and numbers.';
}
function tab(m) {
  mode = m; const up = m === 'up';
  $('sbTi').classList.toggle('on', !up); $('sbTu').classList.toggle('on', up);
  $('sbTi').setAttribute('aria-selected', !up); $('sbTu').setAttribute('aria-selected', up);
  $('sbNameBox').hidden = !up; $('sbStrBox').hidden = !up; $('sbFgRow').hidden = up;
  $('sbGoT').textContent = up ? 'Create account' : 'Log in';
  $('sbGt').textContent = up ? 'Sign up with Google' : 'Continue with Google';
  $('sbPw').autocomplete = up ? 'new-password' : 'current-password'; $('sbPw').placeholder = up ? 'Create a password' : 'Enter your password';
  $('sbH').textContent = up ? 'Create your account' : (lget('sb_ever') ? 'Welcome back' : 'Log in to Syllabuzz');
  $('sbFoot').innerHTML = up ? 'By creating an account you agree to keep your login private.<br>Your data is stored securely in your Syllabuzz account.' : 'New here? <button class="sblnk" type="button" id="sbToUp">Create an account</button>';
  const t = $('sbToUp'); if (t) t.onclick = () => tab('up');
  clearMsgs(); if (up) strength($('sbPw').value);
}
function msg(t, ok) { const e = $('sbMsg'); e.textContent = t || ''; e.className = 'sbm' + (t ? ' on' : '') + (ok ? ' ok' : '') }
function fieldErr(id, t) { const f = $('f_' + id); f.classList.toggle('err', !!t); $('e_' + id).textContent = t || '' }
function clearMsgs() { msg(''); ['sbName', 'sbEm', 'sbPw'].forEach(i => fieldErr(i, '')) }
function openAuth(m, gate, note) {
  if (!$('sbAuth')) return;
  gateMode = !!gate; tab(m || 'in');
  $('sbClose').hidden = gateMode;
  $('sbSub').textContent = gateMode ? 'Log in or create an account to continue.' : 'Back up and sync your timetable across devices.';
  if (note) msg(note);
  $('sbAuth').hidden = false; hideSplash();
}
function closeAuth() { if (!gateMode) { $('sbAuth').hidden = true; setWait(false) } }
function hideSplash() { const s = $('sbSplash'); if (s && !s.classList.contains('out')) { s.classList.add('out'); setTimeout(() => s.remove(), 400) } }
function setWait(b) {
  waiting = b; clearTimeout(waitT);
  const w = $('sbWait'); if (!w) return; w.classList.toggle('on', b);
  if (b) waitT = setTimeout(() => setWait(false), 180000);
}
const ERR = {
  'auth/invalid-credential': 'Wrong email or password.', 'auth/wrong-password': 'Wrong email or password.', 'auth/user-not-found': 'Wrong email or password.',
  'auth/email-already-in-use': 'An account with this email already exists. Try logging in.', 'auth/weak-password': 'Use a password with at least 6 characters.',
  'auth/invalid-email': 'That email address does not look right.', 'auth/network-request-failed': 'No connection. Check your internet and try again.',
  'auth/too-many-requests': 'Too many attempts. Wait a bit and try again.', 'auth/user-disabled': 'This account has been disabled.',
  'auth/account-exists-with-different-credential': 'This email is already registered with a password. Log in with your email instead.',
  'auth/unauthorized-domain': 'This web address is not allowed for sign-in yet. Add it under Firebase > Authentication > Settings > Authorized domains.',
  'auth/operation-not-allowed': 'This sign-in method is switched off. Enable it in Firebase > Authentication > Sign-in method.',
  'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
  'auth/internal-error': 'Sign-in hit a temporary problem. Please try again.', 'auth/missing-password': 'Enter your password.'
};
const eMsg = e => ERR[e && e.code] || ('Something went wrong' + (e && e.code ? ' (' + e.code + ')' : '') + '. Please try again.');
function busy(which, b) {
  ['sbGo', 'sbG', 'sbFg'].forEach(i => { const e = $(i); if (e) e.disabled = b });
  const sp = '<span class="sbspin"></span>';
  if (which === 'go') $('sbGo').innerHTML = b ? sp + '<span>Please wait…</span>' : '<span id="sbGoT">' + (mode === 'up' ? 'Create account' : 'Log in') + '</span>';
  if (which === 'g') $('sbG').innerHTML = b ? sp + '<span>Opening Google…</span>' : G + '<span id="sbGt">' + (mode === 'up' ? 'Sign up with Google' : 'Continue with Google') + '</span>';
}

/* ---- auth actions ---- */
async function submit() {
  if (!F) return msg('Still connecting to the server. Try again in a moment.');
  clearMsgs();
  const em = $('sbEm').value.trim(), pw = $('sbPw').value, nm = $('sbName').value.trim();
  let bad = false;
  if (mode === 'up' && !nm) { fieldErr('sbName', 'Enter your name.'); bad = true }
  if (!em) { fieldErr('sbEm', 'Enter your email.'); bad = true } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { fieldErr('sbEm', 'That email address does not look right.'); bad = true }
  if (!pw) { fieldErr('sbPw', 'Enter your password.'); bad = true } else if (mode === 'up' && pw.length < 6) { fieldErr('sbPw', 'Use at least 6 characters.'); bad = true }
  if (bad) return;
  busy('go', true);
  try {
    if (mode === 'up') {
      pendingName = nm;
      const r = await F.createUserWithEmailAndPassword(auth, em, pw);
      try { await F.updateProfile(r.user, { displayName: nm }) } catch (e) {}
    } else await F.signInWithEmailAndPassword(auth, em, pw);
  } catch (e) { pendingName = ''; msg(eMsg(e)) }
  busy('go', false);
}
async function forgot() {
  const em = $('sbEm').value.trim();
  clearMsgs();
  if (!em) return fieldErr('sbEm', 'Type your email here first, then tap Forgot password.');
  if (!F) return msg('Still connecting to the server. Try again in a moment.');
  try { await F.sendPasswordResetEmail(auth, em); msg('Password reset email sent. Check your inbox (and spam).', true) } catch (e) { msg(e && e.code === 'auth/user-not-found' ? 'Password reset email sent. Check your inbox (and spam).' : eMsg(e), e && e.code === 'auth/user-not-found') }
}
async function google() {
  if (!F) return msg('Still connecting to the server. Try again in a moment.');
  clearMsgs();
  if (APP) {
    const base = (CFG.webUrl || '').replace(/\/$/, '');
    if (!base || /YOUR_/.test(base)) return msg('Google sign-in needs "webUrl" set in firebase-config.js.');
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36); lput('sb_state', st);
    setWait(true);
    try { AndroidBridge.openExternal(base + '/auth-bridge.html?state=' + st) } catch (e) { setWait(false); msg('Could not open your browser.') }
    return;
  }
  busy('g', true);
  const p = new F.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  try { await F.signInWithPopup(auth, p) }
  catch (e) {
    const c = e && e.code;
    if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment') {
      try { await F.signInWithRedirect(auth, p); return } catch (e2) { msg(eMsg(e2)) }
    } else if (c !== 'auth/popup-closed-by-user' && c !== 'auth/cancelled-popup-request') msg(eMsg(e));
  }
  busy('g', false);
}
/* the Android app calls this after the browser hands the Google token back */
window.onNativeAuth = async function () {
  let r = ''; try { r = AndroidBridge.pendingAuth() } catch (e) {}
  if (!r || !F) return;
  const p = r.split('\n');
  setWait(false);
  if (user) return;                                   /* already signed in: ignore stale hand-backs */
  if (!p[1] || p[1] !== lget('sb_state')) { openAuth('in', gateMode, 'Sign-in could not be verified. Please try again.'); return }
  ldel('sb_state'); busy('g', true);
  try { await F.signInWithCredential(auth, F.GoogleAuthProvider.credential(p[0])) } catch (e) { openAuth('in', gateMode, eMsg(e)) }
  busy('g', false);
};

async function logout() {
  if (!confirm('Log out of Syllabuzz? Your data stays safe in your account and is removed from this device.')) return;
  try {
    await flush();
    await Promise.race([F.waitForPendingWrites(db), new Promise((_, j) => setTimeout(j, 6000))]);
  } catch (e) { if (!confirm('Some changes have not been uploaded yet. Log out anyway and lose them?')) return }
  await wipe(); location.reload();
}
async function wipe() {
  if (unsubData) unsubData(); if (unsubProf) unsubProf(); unsubData = unsubProf = null;
  applying = true; SYNC.forEach(ldel); ['sb_user', 'sb_owner', 'sb_dirty'].forEach(ldel); applying = false;
  dirty = new Set(); user = null; reconciled = false;
  if (APP) { try { AndroidBridge.sync('{}') } catch (e) {} }
  try { await F.signOut(auth) } catch (e) {}
}

/* ---- profile ---- */
async function profile(u) {
  lastProf = Date.now();
  const ref = F.doc(db, 'users', u.uid);
  let snap = null; try { snap = await F.getDoc(ref) } catch (e) {}
  const base = {
    email: u.email || '', photo: u.photoURL || '',
    provider: (u.providerData[0] && u.providerData[0].providerId) || 'password',
    platform: APP ? 'android' : 'web', appVersion: VER, lastSeen: F.serverTimestamp()
  };
  const nm = u.displayName || pendingName || (u.email || '').split('@')[0];
  try {
    if (snap && snap.exists()) { if (!snap.data().name) base.name = nm; await F.setDoc(ref, base, { merge: true }) }
    else await F.setDoc(ref, Object.assign({ name: nm, createdAt: F.serverTimestamp() }, base));
  } catch (e) {}
  pendingName = '';
}

/* ---- sync ---- */
function setStatus(s) { status = s; if (s === 'ok') lastSync = Date.now(); rerender() }
function rerender() { try { if (window.view === 'settings' && !document.querySelector('dialog[open]')) window.render() } catch (e) {} const d = $('sbAc'); if (d && d.open) acctFill() }
window.sbRerender = rerender;
async function flush() {
  if (!user || !reconciled) return;
  const keys = [...dirty]; if (!keys.length) return;
  setStatus(navigator.onLine ? 'syncing' : 'offline');
  const sent = {}, b = F.writeBatch(db);
  keys.forEach(k => {
    const v = lget(k), r = F.doc(db, 'users', user.uid, 'data', k); sent[k] = v;
    if (v === null) b.delete(r); else b.set(r, { v, u: F.serverTimestamp(), by: APP ? 'app' : 'web', dev: DEV });
  });
  try {
    await b.commit();
    keys.forEach(k => { if (lget(k) === sent[k]) dirty.delete(k) }); saveDirty(); setStatus('ok');
  } catch (e) { setStatus(navigator.onLine ? 'error' : 'offline') }
}
function startData(u) {
  let first = true;
  unsubData = F.onSnapshot(F.collection(db, 'users', u.uid, 'data'), { includeMetadataChanges: true }, snap => {
    if (first) { if (snap.metadata.fromCache && navigator.onLine) return; first = false; reconcile(u, snap); return }
    const ch = [];
    snap.docChanges().forEach(c => { if (!c.doc.metadata.hasPendingWrites) ch.push(c) });
    if (ch.length) apply(ch);
  }, () => setStatus('error'));
}
function put(k, v) { applying = true; if (v === null) ldel(k); else lput(k, v); applying = false }
function reconcile(u, snap) {
  const cloud = {}; snap.forEach(d => { const x = d.data(); if (typeof x.v === 'string') cloud[d.id] = x.v });
  const cKeys = Object.keys(cloud).filter(k => SYNC.indexOf(k) >= 0);
  const lKeys = SYNC.filter(k => lget(k) !== null);
  const owned = lget('sb_owner') === u.uid;
  let changed = false, useCloud = true;
  if (!owned && cKeys.length && lKeys.length) {
    const differs = lKeys.some(k => cloud[k] !== lget(k)) || cKeys.some(k => lget(k) === null);
    if (differs) useCloud = confirm('This device already has timetable data, and your account has data saved too.\n\nOK: replace this device’s data with your account’s data.\nCancel: upload this device’s data to your account instead.');
  }
  SYNC.forEach(k => {
    const c = cloud[k], l = lget(k);
    if (!owned && !useCloud) { if (l !== null) { if (c !== l) dirty.add(k) } else if (c !== undefined) dirty.add(k) /* removes it from cloud */; return }
    if (owned && dirty.has(k)) return;                       /* local edits made while offline win */
    if (c !== undefined) { if (c !== l) { put(k, c); changed = true } }
    else if (l !== null) { if (owned) { put(k, null); changed = true } else dirty.add(k) } /* first sign-in: upload */
  });
  lput('sb_owner', u.uid); saveDirty(); reconciled = true;
  if (dirty.size) flush(); else setStatus('ok');
  if (changed) refresh();
}
function apply(changes) {
  let changed = false;
  changes.forEach(c => {
    const k = c.doc.id; if (SYNC.indexOf(k) < 0 || dirty.has(k)) return;
    const v = c.type === 'removed' ? null : c.doc.data().v;
    if (typeof v !== 'string' && v !== null) return;
    if (v !== lget(k)) { put(k, v); changed = true }
  });
  if (changed) { lastSync = Date.now(); refresh() }
}
let tries = 0;
/* Pulls fresh cloud data into the page. Reloads are rationed: at most 2 per 10 minutes, so a data
   disagreement can never turn into an endless reload loop. */
function refresh() {
  const busyUi = document.querySelector('dialog[open]') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
  if (busyUi && tries++ < 30) return setTimeout(refresh, 4000);
  tries = 0;
  let log = []; try { log = JSON.parse(sessionStorage.getItem('sb_rl') || '[]') } catch (e) {}
  const now = Date.now(); log = log.filter(t => now - t < 600000);
  if (log.length >= 2) return;
  log.push(now); try { sessionStorage.setItem('sb_rl', JSON.stringify(log)) } catch (e) {}
  try { if (window.doSync) window.doSync() } catch (e) {}
  location.reload();
}

/* ---- auth state ---- */
function who() { return window.SBUser }
function announce(ev) { try { document.dispatchEvent(new CustomEvent(ev)) } catch (e) {} }
function signedIn(u) {
  clearTimeout(outT);
  const again = user && user.uid === u.uid;
  user = u; resolved = true;
  window.SBUser = { uid: u.uid, email: u.email || '', name: u.displayName || pendingName || (u.email || '').split('@')[0], photo: u.photoURL || '' };
  lput('sb_user', JSON.stringify(window.SBUser)); lput('sb_ever', '1');
  setWait(false); gateMode = false; $('sbAuth').hidden = true; try { $('sbUp').close() } catch (e) {}
  hideSplash();
  if (again) return;                                     /* token refresh: nothing else to do */
  reconciled = false;
  if (!lget('sb_welcomed_' + u.uid)) { lput('sb_welcomed_' + u.uid, '1'); try { window.toast('Welcome, ' + window.SBUser.name.split(' ')[0], 'You are signed in.') } catch (e) {} }
  profile(u).then(() => {
    if (unsubProf) unsubProf();
    unsubProf = F.onSnapshot(F.doc(db, 'users', u.uid), s => {
      const d = s.exists() ? s.data() : null;
      if (d && d.disabled === true) hardOut('This account has been disabled. Contact support.');
      if (d && d.name && window.SBUser && d.name !== window.SBUser.name) { window.SBUser.name = d.name; rerender() }
      window.SBProfile = d || {}; announce('sb-profile');
    }, () => {});
  });
  startData(u); rerender(); announce('sb-user');
}
async function hardOut(note) { await wipe(); window.SBUser = null; openAuth('in', true, note); rerender() }
function signedOut() {
  window.SBUser = null; user = null; resolved = true; announce('sb-user');
  const hasData = !!(lget('tt') || lget('tsh') || lget('ttour'));
  const legacy = hasData && !lget('sb_ever');
  if (legacy && !CFG.requireLoginForExisting) {
    hideSplash();
    const later = +lget('sb_later') || 0;                /* "Later" is remembered for 3 days */
    if (Date.now() - later > 3 * 864e5) { try { $('sbUp').showModal() } catch (e) {} }
  } else openAuth('in', true);
  rerender();
}

/* ---- settings + account pieces used by the main page ---- */
window.sbOpen = () => openAuth('in', false);
window.sbBack = () => {
  try { if (window.sbRemoteBack && window.sbRemoteBack()) return true } catch (e) {}
  const a = $('sbAuth'); if (a && !a.hidden && !gateMode) { closeAuth(); return true } return false;
};
window.sbLogout = logout;
window.acctRows = function () {
  if (!configured) return '';
  const u = who();
  if (!u) return '<button class="g sr" onclick="sbOpen()"><span class="si">' + I('user') + '</span><span class="sx"><b>Log in or sign up</b><small>Back up and sync across devices</small></span>' + I('right', 'ch') + '</button>';
  const st = { syncing: 'Syncing…', offline: 'Offline, will sync later', error: 'Sync problem, tap to retry', ok: 'Synced' }[status] || '';
  let extra = ''; try { extra = window.sbExtraRows ? window.sbExtraRows() : '' } catch (e) {}
  return '<button class="g sr" onclick="sbAcct()"><span class="si">' + I('user') + '</span><span class="sx"><b>' + esc(u.name || u.email) + '</b><small>' + esc(u.email) + (st ? ' · ' + st : '') + '</small></span>' + I('right', 'ch') + '</button>' + extra;
};
window.logoutRow = function () {
  if (!configured || !who()) return '';
  return '<button class="g sr" onclick="sbLogout()"><span class="si" style="color:#ef4444">' + I('logout') + '</span><span class="sx"><b style="color:#ef4444">Log out</b><small>Remove this account from this device</small></span></button>';
};
window.sbAcct = () => { acctFill(); $('sbAc').showModal() };
window.sbSyncNow = async () => { if (!user) return; SYNC.forEach(k => dirty.add(k)); saveDirty(); await flush() };
function acctFill() {
  const u = who(), d = $('sbAc'); if (!u) return;
  const t = lastSync ? 'Last synced ' + new Date(lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not synced yet this session';
  d.innerHTML = '<div style="text-align:center"><div class="sbav">' + (u.photo ? '<img src="' + esc(u.photo) + '" alt="" referrerpolicy="no-referrer">' : esc((u.name || u.email || '?').charAt(0).toUpperCase())) + '</div>' +
    '<h2 style="margin:0;font-size:1.1rem">' + esc(u.name) + '</h2><p style="margin:2px 0 10px;color:var(--mut);font-size:.88rem">' + esc(u.email) + '</p>' +
    '<p style="margin:0;color:var(--mut);font-size:.82rem">' + esc(t) + ' · v' + VER + '</p></div>' +
    '<div class="act" style="flex-wrap:wrap;justify-content:center"><button class="g" onclick="sbSyncNow()">Sync now</button><button class="g" onclick="sbAc.close()">Close</button><button onclick="sbAc.close();sbLogout()" style="background:#ef4444">Log out</button></div>';
}

/* ---- boot ---- */
P.logout = '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>';
window.addEventListener('online', () => { if (user && reconciled) flush() });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (APP) window.onNativeAuth();
  if (user && Date.now() - lastProf > 300000) profile(user);   /* at most every 5 minutes */
});
window.addEventListener('focus', () => { if (APP) window.onNativeAuth() });

(async function boot() {
  if (!configured) return;           /* Firebase not set up yet: the app works exactly as before */
  buildUi();
  /* Never leave the splash up forever: after 9 s fall back to offline mode or the login page. */
  setTimeout(() => {
    if (resolved) return;
    let known = null; try { known = JSON.parse(lget('sb_user') || 'null') } catch (_) {}
    if (known) { window.SBUser = known; hideSplash(); rerender() } else openAuth('in', true, 'Cannot reach the server. Connect to the internet to log in.');
  }, 9000);
  try {
    const [a, b, c] = await Promise.all([import(CDN + 'firebase-app.js'), import(CDN + 'firebase-auth.js'), import(CDN + 'firebase-firestore.js')]);
    F = Object.assign({}, b, c);
    const app = a.initializeApp(FB);
    /* popupRedirectResolver is what makes signInWithPopup / signInWithRedirect work. */
    try { auth = b.initializeAuth(app, { persistence: [b.indexedDBLocalPersistence, b.browserLocalPersistence], popupRedirectResolver: b.browserPopupRedirectResolver }) }
    catch (e) { auth = b.getAuth(app) }
    try { db = c.initializeFirestore(app, { localCache: c.persistentLocalCache() }) } catch (e) { db = c.getFirestore(app) }
    window.SBFire = { F, db, auth, app, user: () => user };
    announce('sb-fire');
  } catch (e) {
    /* SDK could not load (offline on first launch). Let a known user keep working offline. */
    let known = null; try { known = JSON.parse(lget('sb_user') || 'null') } catch (_) {}
    resolved = true;
    if (known) { window.SBUser = known; hideSplash(); rerender(); return }
    openAuth('in', true, 'Cannot reach the server. Connect to the internet to log in.'); return;
  }
  F.onAuthStateChanged(auth, u => {
    clearTimeout(outT);
    if (u) signedIn(u);
    else outT = setTimeout(() => { if (!auth.currentUser) signedOut() }, 400);   /* ignore momentary null during token refresh */
  });
  if (!APP && /^https?:$/.test(location.protocol)) F.getRedirectResult(auth).catch(e => { if (e && e.code) openAuth('in', gateMode, eMsg(e)) });
  if (APP) window.onNativeAuth();
})();
})();
