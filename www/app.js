/* Cutting Room: the whole app in one file.
   The order: sign up -> submit your post (editor profile or job) -> owner reviews it -> owner approves -> pay once ->
   the post goes live and you can see the other side. For the owner there is a Review desk instead.
   All the rules (who may see what, who may write what) live in the database (supabase/schema.sql).
   Nothing in this file can unlock an account or approve a post; it only asks. */
(() => {
'use strict';

/* ---------- config ---------- */
const CFG = window.APP_CONFIG || {};
const isPlaceholder = v => !v || /PASTE|example\.com/i.test(String(v));
const CONFIGURED = !isPlaceholder(CFG.SUPABASE_URL) && /^https?:\/\//.test(CFG.SUPABASE_URL) && !isPlaceholder(CFG.SUPABASE_ANON_KEY) && !!window.supabase;
const PRICE = Number(CFG.PRICE_RUPEES) > 0 ? Math.round(Number(CFG.PRICE_RUPEES)) : 500;
const POLICY = isPlaceholder(CFG.POLICY_URL) ? '' : String(CFG.POLICY_URL).replace(/\/?$/, '/');
const SUPPORT_EMAIL = isPlaceholder(CFG.SUPPORT_EMAIL) ? '' : String(CFG.SUPPORT_EMAIL);
const SUPPORT_WA = String(CFG.SUPPORT_WHATSAPP || '').replace(/\D/g, '');
const FN_URL = CONFIGURED ? String(CFG.SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/payments' : '';

/* ---------- reference data ---------- */
const TYPES = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'shorts', label: 'Reels & Shorts' },
  { id: 'podcast', label: 'Podcast' },
  { id: 'wedding', label: 'Wedding & Events' },
  { id: 'brand', label: 'Ads & Brand' },
  { id: 'news', label: 'News & Explainers' },
  { id: 'motion', label: 'Motion Graphics' }
];
const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));
const TYPE_IDS = TYPES.map(t => t.id);
const TOOLS = ['Premiere Pro', 'DaVinci Resolve', 'Final Cut Pro', 'After Effects', 'CapCut', 'Filmora'];
const RATE_UNITS = { video: 'per video', min: 'per finished minute', hour: 'per hour', month: 'per month' };
const BUDGET_UNITS = { video: 'per video', project: 'for the project', month: 'per month' };
const STATUS_LABEL = { new: 'New', shortlisted: 'Shortlisted', hired: 'Hired', declined: 'Declined' };
const APPROVALS = ['pending', 'approved', 'rejected'];
const MS_DAY = 86400000;

/* ---------- state ---------- */
const S = {
  view: 'boot',            // boot | config | error | auth | gate | pay | app
  gate: '',                // create | review | rejected (what an unpaid member is waiting on)
  posts: [], notes: [], seen: null,
  authMode: 'signup',      // signup | login | forgot
  role: 'editor',          // chosen on the sign-up form
  user: null, profile: null, isAdmin: false,
  tab: 'work',
  jobs: [], editors: [], apps: [], myEditor: null,
  admin: { jobs: [], editors: [], stats: null, filter: 'approved' },
  ready: false, loading: false, loadError: '', lastLoad: 0,
  q: { work: '', editors: '' }, f: { work: 'all', editors: 'all' }, openOnly: false,
  counts: null, payUrl: '', payMsg: null, payBusy: false, checking: false, payStarted: 0,
  errorText: ''
};
let sb = null;
let sheet = { kind: null, id: null, from: null, extra: null };
let lastFocus = null;
let payTimer = 0, gateTimer = 0, refreshing = false, gateKeyLast = '';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const only = (arr, valid) => (Array.isArray(arr) ? arr.filter(x => valid.includes(x)) : []);
const money = n => '₹' + Math.round(n).toLocaleString('en-IN');
const initials = name => (String(name || '').trim().split(/\s+/).slice(0, 2).map(w => Array.from(w)[0] || '').join('').toUpperCase() || '?');
const pad2 = n => String(n).padStart(2, '0');
const when = iso => { const t = Date.parse(iso); return t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };

function safeUrl(v) {
  if (typeof v !== 'string' || !v) return '';
  try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : ''; } catch (e) { return ''; }
}
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function todayDate() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function isoDay(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function daysLeft(s) { const d = parseDay(s); return d ? Math.round((d - todayDate()) / MS_DAY) : null; }
function fmtDay(s) { const d = parseDay(s); return d ? d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date'; }
function dueText(d) {
  if (d == null) return 'No deadline';
  if (d < 0) return 'Past due';
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return d + ' days left';
}
function waLink(raw) {
  if (!/^[+\d][\d\s\-+()]{8,}$/.test(raw || '')) return '';
  let n = String(raw).replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;
  return n.length >= 11 && n.length <= 15 ? 'https://wa.me/' + n : '';
}

/* ---------- parsing (everything from the network is treated as untrusted text) ---------- */
function ownerInfo(r) {
  if (r.owner_email === undefined && r.owner_name === undefined && r.owner_phone === undefined) return null;
  return { name: str(r.owner_name, 60), email: str(r.owner_email, 120), phone: str(r.owner_phone, 30), paid: !!r.owner_paid, joined: str(r.owner_joined, 40) };
}
function parseJob(r) {
  return {
    id: str(r.id, 40), owner: str(r.owner, 40), poster: str(r.poster_name, 60), title: str(r.title, 100), type: pick(r.type, TYPE_IDS, 'youtube'),
    brief: str(r.brief, 2000), length: str(r.length, 60), budget: num(r.budget), unit: pick(r.unit, Object.keys(BUDGET_UNITS), 'project'),
    deadline: parseDay(r.deadline) ? String(r.deadline).slice(0, 10) : '', tools: only(r.tools, TOOLS),
    status: pick(r.status, ['open', 'filled', 'closed'], 'open'), hired: str(r.hired, 40),
    approval: pick(r.approval, APPROVALS, 'pending'), note: str(r.review_note, 300), createdAt: Date.parse(r.created_at) || 0, by: ownerInfo(r)
  };
}
function parseEditor(r) {
  return {
    id: str(r.user_id, 40), name: str(r.name, 60) || 'Editor', headline: str(r.headline, 90), about: str(r.about, 1200), city: str(r.city, 50),
    skills: only(r.skills, TYPE_IDS), tools: only(r.tools, TOOLS), rate: num(r.rate), unit: pick(r.rate_unit, Object.keys(RATE_UNITS), 'video'),
    portfolio: safeUrl(r.portfolio), contact: str(r.contact, 80), available: r.available !== false,
    approval: pick(r.approval, APPROVALS, 'pending'), note: str(r.review_note, 300), updatedAt: Date.parse(r.updated_at) || 0, by: ownerInfo(r)
  };
}
function parseApp(r) {
  return {
    id: str(r.job_id, 40) + '~' + str(r.editor_id, 40), jobId: str(r.job_id, 40), editorId: str(r.editor_id, 40), message: str(r.message, 600),
    quote: num(r.quote), status: pick(r.status, Object.keys(STATUS_LABEL), 'new'), createdAt: Date.parse(r.created_at) || 0
  };
}

/* ---------- derived ---------- */
const jobById = id => S.jobs.find(j => j.id === id);
const editorById = id => (S.myEditor && S.myEditor.id === id ? S.myEditor : S.editors.find(e => e.id === id));
const myApp = jobId => S.apps.find(a => a.jobId === jobId && a.editorId === S.user.id);
function appsByJob() {
  const m = new Map();
  S.apps.forEach(a => { if (!m.has(a.jobId)) m.set(a.jobId, []); m.get(a.jobId).push(a); });
  return m;
}
function dueKey(j) { const d = daysLeft(j.deadline); return d == null ? 5000 : (d < 0 ? 10000 - d : d); }
const role = () => (S.profile ? S.profile.role : 'client');

/* ---------- small html builders ---------- */
const ICON = {
  work: '<path d="M3 8h18v11H3z"/><path d="M8 8V5.5h8V8"/><path d="M3 13h18"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5a3.2 3.2 0 0 1 0 6"/><path d="M18 14c2 .7 3 2.7 3 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  inbox: '<path d="M3 13l3-8h12l3 8"/><path d="M3 13v6h18v-6h-5l-1 2h-6l-1-2z"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/>'
};
const svg = name => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + '</svg>';
function tagHtml(id) { return '<span class="tag t-' + esc(id) + '">' + esc(TYPE[id].label) + '</span>'; }
function stripHtml(type, d) {
  let w = 0;
  if (d != null && d >= 0) w = Math.max(0.05, Math.min(1, d / 14));
  const more = d != null && d > 14 ? ' more' : '';
  return '<div class="strip t-' + esc(type) + '" aria-hidden="true"><span class="clip' + more + '" style="--w:' + w.toFixed(3) + '"></span><span class="playhead"></span></div>';
}
function approvalPill(a) {
  return a === 'approved' ? '<span class="pill ok">Live</span>' : (a === 'rejected' ? '<span class="pill bad">Not approved</span>' : '<span class="pill warn">In review</span>');
}
function contactRow(c) {
  if (!c) return '<p class="muted">No contact shared yet.</p>';
  const wa = waLink(c);
  return '<div class="contact"><span class="sel mono">' + esc(c) + '</span>' +
    '<button type="button" class="btn ghost sm" data-act="copy" data-text="' + esc(c) + '">Copy</button>' +
    (wa ? '<a class="btn ghost sm" href="' + esc(wa) + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' : '') + '</div>';
}
function jobCard(j, counts) {
  const d = daysLeft(j.deadline);
  const mine = role() === 'editor' ? myApp(j.id) : null;
  const right = role() === 'editor'
    ? (mine ? '<span class="pill ok">Applied</span>' : '<span class="muted">' + esc(j.poster || 'Client') + '</span>')
    : '<span class="muted">' + ((counts.get(j.id) || []).length) + ' applied</span>';
  return '<article class="card job t-' + esc(j.type) + '" role="button" tabindex="0" data-act="openjob" data-id="' + esc(j.id) + '">' +
    stripHtml(j.type, d) +
    '<div class="row between">' + tagHtml(j.type) + '<span class="due' + (d != null && d >= 0 && d <= 2 ? ' hot' : '') + '">' + esc(dueText(d)) + '</span></div>' +
    '<h3>' + esc(j.title) + '</h3>' +
    '<p class="brief">' + esc(j.brief) + '</p>' +
    '<div class="row between foot"><span class="money">' + money(j.budget) + ' <small>' + esc(BUDGET_UNITS[j.unit]) + '</small></span>' + right + '</div>' +
    '</article>';
}
function editorCard(e, withPill) {
  const first = e.skills[0] || 'youtube';
  return '<article class="card editor t-' + esc(first) + '" role="button" tabindex="0" data-act="openeditor" data-id="' + esc(e.id) + '">' +
    '<div class="avatar" aria-hidden="true">' + esc(initials(e.name)) + '</div>' +
    '<div class="body">' +
      '<div class="row between"><h3>' + esc(e.name) + '</h3>' + (withPill ? approvalPill(e.approval) : '<span class="avail' + (e.available ? ' on' : '') + '">' + (e.available ? 'Open' : 'Booked') + '</span>') + '</div>' +
      (e.headline ? '<p class="muted">' + esc(e.headline) + '</p>' : '') +
      '<div class="tags">' + e.skills.map(tagHtml).join('') + '</div>' +
      '<div class="row between foot"><span class="money">' + (e.rate ? money(e.rate) + ' <small>' + esc(RATE_UNITS[e.unit]) + '</small>' : '<small>Rate on request</small>') + '</span><span class="muted">' + esc(e.city) + '</span></div>' +
    '</div></article>';
}
function empty(title, text, buttons) {
  return '<div class="empty"><div class="strip" aria-hidden="true"></div><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' + (buttons ? '<div class="btns">' + buttons + '</div>' : '') + '</div>';
}
const btn = (label, act, extra) => '<button type="button" class="btn' + (extra && extra.ghost ? ' ghost' : '') + '" data-act="' + act + '"' + (extra && extra.attrs ? ' ' + extra.attrs : '') + '>' + esc(label) + '</button>';
function legalLinks() {
  if (!POLICY) return '';
  return '<div class="legal"><a href="' + esc(POLICY) + 'terms.html" target="_blank" rel="noopener">Terms</a><a href="' + esc(POLICY) + 'privacy.html" target="_blank" rel="noopener">Privacy</a><a href="' + esc(POLICY) + 'refund.html" target="_blank" rel="noopener">Refunds</a></div>';
}
function supportLine() {
  const parts = [];
  if (SUPPORT_EMAIL) parts.push('<a href="mailto:' + esc(SUPPORT_EMAIL) + '">' + esc(SUPPORT_EMAIL) + '</a>');
  if (SUPPORT_WA) parts.push('<a href="https://wa.me/' + esc(SUPPORT_WA.length === 10 ? '91' + SUPPORT_WA : SUPPORT_WA) + '" target="_blank" rel="noopener">WhatsApp</a>');
  return parts.length ? '<p class="small">Need help? ' + parts.join(' · ') + '</p>' : '';
}
const bellInner = () => svg('bell') + (S.notes.some(n => !n.read) ? '<span class="dot">' + S.notes.filter(n => !n.read).length + '</span>' : '');
function drawBell() { const b = $('#bell'); if (b) b.innerHTML = bellInner(); }
function headerHtml(title, sub, withRefresh, withBell) {
  return '<div class="top"><div class="row between" style="flex-wrap:nowrap"><div style="min-width:0"><h1 id="h-title">' + esc(title) + '</h1><p id="h-sub">' + esc(sub || '') + '</p></div>' +
    '<div class="row" style="flex-wrap:nowrap;gap:8px">' +
    (withBell ? '<button type="button" class="icon-btn" id="bell" data-act="inbox" aria-label="Notifications">' + bellInner() + '</button>' : '') +
    (withRefresh ? '<button type="button" class="icon-btn" data-act="refresh" aria-label="Refresh">' + svg('refresh') + '</button>' : '') +
    '</div></div><div class="ruler"></div></div>';
}

/* ---------- toast, clipboard, confirm-by-tapping-twice ---------- */
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}
async function copyText(text, el) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (e) {
    const t = el.closest('.contact,.who') && el.closest('.contact,.who').querySelector('.sel');
    if (t) { const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    toast('Selected. Press and hold to copy.');
  }
}
function armed(el, fn) {
  if (el.dataset.armed) { clearTimeout(Number(el.dataset.timer)); fn(); return; }
  const label = el.textContent;
  el.dataset.armed = '1'; el.textContent = 'Tap again to confirm';
  el.dataset.timer = String(setTimeout(() => { delete el.dataset.armed; el.textContent = label; }, 3500));
}
function openExternal(url) {
  const u = safeUrl(url);
  if (!u) return;
  try { window.open(u, '_blank'); } catch (e) { /* the visible link on the page is the fallback */ }
}

/* ---------- errors in plain words ---------- */
function authError(e) {
  const m = String((e && e.message) || e || '').toLowerCase();
  if (/invalid login|invalid credentials/.test(m)) return 'Wrong email or password.';
  if (/not confirmed/.test(m)) return 'Please confirm your email first. Check your inbox and spam folder for our message.';
  if (/already registered|already been registered|already exists/.test(m)) return 'This email already has an account. Tap "Log in" instead.';
  if (/rate limit|too many|security purposes/.test(m)) return 'Too many tries. Please wait a few minutes and try again.';
  if (/password/.test(m) && /(least|short|weak|characters)/.test(m)) return 'Choose a longer password (at least 8 characters).';
  if (/valid email|invalid email|unable to validate email/.test(m)) return 'That email address does not look right.';
  if (/fetch|network|failed to|load failed/.test(m)) return 'No internet connection. Please check it and try again.';
  return 'Something went wrong. Please try again.';
}
function writeError(e) {
  console.error(e);
  const code = e && e.code, m = String((e && e.message) || '').toLowerCase();
  if (code === '23505') return 'You have already done this.';
  if (code === '42501' || /row-level security|permission denied|no_rows/.test(m)) return 'That is not allowed right now. Open the app again, or check that your account is unlocked and the post is live.';
  if (/fetch|network|failed to|load failed/.test(m)) return 'No internet connection. Please try again.';
  return 'Could not save. Please check your connection and try again.';
}
const failToast = e => toast(writeError(e));
// Writes must change a row, otherwise the database refused quietly.
async function mutate(q) {
  const r = await q.select();
  if (r.error) throw r.error;
  if (!r.data || !r.data.length) throw new Error('no_rows');
  return r.data;
}

/* ---------- rendering: top level ---------- */
const screen = () => $('#screen');
function render() {
  syncTimers();
  const nav = $('#nav');
  nav.hidden = S.view !== 'app';
  if (nav.hidden) nav.innerHTML = '';
  window.scrollTo(0, 0);
  if (S.view === 'boot') screen().innerHTML = '<div class="app gate">' + headerHtml('Cutting Room', 'Loading…') + '</div>';
  else if (S.view === 'config') screen().innerHTML = configHtml();
  else if (S.view === 'error') screen().innerHTML = errorHtml();
  else if (S.view === 'auth') screen().innerHTML = authHtml();
  else if (S.view === 'gate') screen().innerHTML = gateHtml();
  else if (S.view === 'pay') screen().innerHTML = payHtml();
  else if (S.view === 'app') {
    screen().innerHTML = '<div class="app">' + headerHtml('', '', true, !S.isAdmin) + '<div id="notice"></div><main id="body"></main></div>';
    buildNav();
    drawTab();
  }
}
function configHtml() {
  return '<div class="app gate">' + headerHtml('Setup not finished', 'This copy of the app is not connected to a database yet.') +
    '<div class="stack"><p>Open <span class="mono">docs/config.js</span> in your project, paste your Supabase project address and public (anon) key, then build the app again.</p>' +
    '<p class="small">The setup guide has the exact steps.</p></div></div>';
}
function errorHtml() {
  return '<div class="app gate">' + headerHtml('Cutting Room', 'We could not open your account') + '<div class="stack"><div class="msg bad">' + esc(S.errorText) + '</div>' +
    '<button type="button" class="btn block" data-act="retryboot">Try again</button><button type="button" class="btn ghost block" data-act="signout">Sign out</button>' + supportLine() + '</div></div>';
}

/* ---------- sign up / log in ---------- */
function authHtml() {
  const m = S.authMode;
  let h = '<div class="app gate">' + headerHtml('Cutting Room', 'Video editors and the people who need them, in one place.');
  h += '<div class="stack">';
  if (m === 'forgot') {
    h += '<h2>Reset your password</h2><p class="muted">Enter your email and we will send you a link to choose a new one.</p>' +
      '<form data-form="forgot" novalidate><div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none"></div>' +
      '<p class="err" id="authmsg" role="alert" hidden></p><button type="submit" class="btn block">Send reset link</button>' +
      '<button type="button" class="btn ghost block" data-act="mode" data-v="login">Back to log in</button></form>';
  } else {
    h += '<div class="seg" role="group" aria-label="Account">' +
      '<button type="button" data-act="mode" data-v="signup" aria-pressed="' + (m === 'signup') + '">Create account</button>' +
      '<button type="button" data-act="mode" data-v="login" aria-pressed="' + (m === 'login') + '">Log in</button></div>';
    if (m === 'signup') {
      h += '<form data-form="signup" novalidate>' +
        '<div class="field"><span class="lbl">I am</span><div class="rolepick">' +
          '<button type="button" data-act="role" data-v="editor" aria-pressed="' + (S.role === 'editor') + '"><strong>A video editor</strong><span>I want to find paid work</span></button>' +
          '<button type="button" data-act="role" data-v="client" aria-pressed="' + (S.role === 'client') + '"><strong>I need an editor</strong><span>I want to hire for my videos</span></button></div></div>' +
        '<div class="field"><label for="s-name">Your name</label><input id="s-name" name="name" maxlength="60" autocomplete="name"></div>' +
        '<div class="field"><label for="s-phone">WhatsApp number</label><input id="s-phone" name="phone" type="tel" inputmode="tel" maxlength="20" autocomplete="tel" placeholder="98765 43210"></div>' +
        '<div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none"></div>' +
        '<div class="field"><label for="s-pass">Password</label><input id="s-pass" name="password" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters">' +
          '<button type="button" class="link" data-act="showpw" style="font-size:13px">Show password</button></div>' +
        '<label class="check"><input type="checkbox" name="terms"> <span>I agree to the ' + (POLICY ? '<a href="' + esc(POLICY) + 'terms.html" target="_blank" rel="noopener">Terms</a>, <a href="' + esc(POLICY) + 'privacy.html" target="_blank" rel="noopener">Privacy Policy</a> and <a href="' + esc(POLICY) + 'refund.html" target="_blank" rel="noopener">Refund Policy</a>' : 'Terms, Privacy Policy and Refund Policy') + '.</span></label>' +
        '<p class="err" id="authmsg" role="alert" hidden></p>' +
        '<button type="submit" class="btn block">Create account</button>' +
        '<p class="small">Next: ' + (S.role === 'editor' ? 'create your editor profile' : 'post your first job') + '. The owner reviews it, and you pay ' + money(PRICE) + ' once, only after it is approved.</p></form>';
    } else {
      h += '<form data-form="login" novalidate>' +
        '<div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none"></div>' +
        '<div class="field"><label for="l-pass">Password</label><input id="l-pass" name="password" type="password" autocomplete="current-password">' +
          '<button type="button" class="link" data-act="showpw" style="font-size:13px">Show password</button></div>' +
        '<p class="err" id="authmsg" role="alert" hidden></p>' +
        '<button type="submit" class="btn block">Log in</button>' +
        '<button type="button" class="link" data-act="mode" data-v="forgot">Forgot your password?</button></form>';
    }
  }
  h += legalLinks() + supportLine() + '</div></div>';
  return h;
}
function setAuthMsg(text, bad) {
  const el = $('#authmsg');
  if (!el) return;
  el.hidden = !text; el.textContent = text || '';
  el.className = bad === false ? 'msg' : 'err';
}
function authBusy(f, on, label) { const b = $('button[type="submit"]', f); b.disabled = on; b.textContent = on ? 'Please wait…' : label; }

async function doSignup(f) {
  const v = f.elements, name = v.name.value.trim(), phone = v.phone.value.trim(), email = v.email.value.trim(), password = v.password.value;
  if (!name) return setAuthMsg('Please enter your name.');
  if (phone.replace(/\D/g, '').length < 10) return setAuthMsg('Enter your 10-digit WhatsApp number, so people you work with can reach you.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return setAuthMsg('That email address does not look right.');
  if (password.length < 8) return setAuthMsg('Choose a password with at least 8 characters.');
  if (!v.terms.checked) return setAuthMsg('Please tick the box to accept the terms.');
  setAuthMsg(''); authBusy(f, true, 'Create account');
  try {
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name, role: S.role, phone } } });
    if (error) throw error;
    if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error('already registered');
    if (data && data.session) { await enter(); return; }
    S.authMode = 'login'; render();
    setAuthMsg('Almost there. We sent a confirmation link to ' + email + '. Open it, then log in here.', false);
  } catch (e) { authBusy(f, false, 'Create account'); setAuthMsg(authError(e)); }
}
async function doLogin(f) {
  const email = f.elements.email.value.trim(), password = f.elements.password.value;
  if (!email || !password) return setAuthMsg('Enter your email and password.');
  setAuthMsg(''); authBusy(f, true, 'Log in');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await enter();
  } catch (e) { authBusy(f, false, 'Log in'); setAuthMsg(authError(e)); }
}
async function doForgot(f) {
  const email = f.elements.email.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return setAuthMsg('Enter the email you signed up with.');
  setAuthMsg(''); authBusy(f, true, 'Send reset link');
  try {
    const opts = POLICY ? { redirectTo: POLICY + 'reset.html' } : undefined;
    const { error } = await sb.auth.resetPasswordForEmail(email, opts);
    if (error) throw error;
    authBusy(f, false, 'Send reset link');
    setAuthMsg('If that email has an account, a reset link is on its way. Check your inbox and spam folder.', false);
  } catch (e) { authBusy(f, false, 'Send reset link'); setAuthMsg(authError(e)); }
}

/* ---------- session and routing ---------- */
async function fetchProfile() {
  const { data: ses } = await sb.auth.getSession();
  if (!ses || !ses.session) return null;
  S.user = ses.session.user;
  let r = await sb.from('profiles').select('*').eq('id', S.user.id).maybeSingle();
  if (!r.error && !r.data) { await new Promise(res => setTimeout(res, 800)); r = await sb.from('profiles').select('*').eq('id', S.user.id).maybeSingle(); }
  if (r.error) throw r.error;
  if (!r.data) return undefined;
  S.profile = { id: r.data.id, role: r.data.role === 'editor' ? 'editor' : 'client', name: str(r.data.full_name, 60), phone: str(r.data.phone, 30), paid: r.data.paid === true, paidAt: str(r.data.paid_at, 40) };
  return S.profile;
}
async function loadProfile() {
  try {
    const p = await fetchProfile();
    if (p === null) { goAuth(); return false; }
    if (!p) { S.errorText = 'Your account was created but your profile is missing. Please sign out and sign up again, or contact support.'; S.view = 'error'; render(); return false; }
    return true;
  } catch (e) {
    console.error(e);
    S.errorText = /fetch|network|failed|load/i.test(String(e && e.message)) ? 'No internet connection. Please check it and try again.' : 'Something went wrong while opening your account.';
    S.view = 'error'; render(); return false;
  }
}
async function enter() {
  S.view = 'boot'; render();
  if (!(await loadProfile())) return;
  let admin = false;
  try { const a = await sb.rpc('is_admin'); admin = !a.error && a.data === true; } catch (e) { admin = false; }
  S.isAdmin = admin;
  if (admin || S.profile.paid) { startApp(); return; }
  try { await loadMine(); } catch (e) {
    console.error(e);
    S.errorText = 'No internet connection, or the server did not answer. Please try again.'; S.view = 'error'; render(); return;
  }
  routeUnpaid();
}
function goAuth() {
  resetData();
  clearTimeout(toastTimer); $('#toast').classList.remove('show');
  S.view = 'auth'; render();
}
function resetData() {
  S.user = null; S.profile = null; S.isAdmin = false; S.jobs = []; S.editors = []; S.apps = []; S.myEditor = null; S.posts = []; S.notes = []; S.seen = null; S.gate = ''; gateKeyLast = '';
  S.admin = { jobs: [], editors: [], stats: null, filter: 'approved' };
  S.ready = false; S.loadError = ''; S.counts = null; S.payUrl = ''; S.payMsg = null; S.q = { work: '', editors: '' }; S.f = { work: 'all', editors: 'all' }; S.openOnly = false;
  closeSheet(true);
}
async function signOut() {
  stopPolling();
  try { await sb.auth.signOut(); } catch (e) { /* signing out locally is enough */ }
  S.authMode = 'login'; goAuth();
}

/* ---------- notifications ---------- */
function parseNote(r) { return { id: str(r.id, 40), kind: str(r.kind, 20), title: str(r.title, 120), body: str(r.body, 400), read: r.read === true, at: Date.parse(r.created_at) || 0 }; }
async function loadNotes() {
  try {
    const r = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
    if (r.error) throw r.error;
    S.notes = (r.data || []).map(parseNote);
    if (S.seen === null) S.seen = new Set(S.notes.map(n => n.id));
    else {
      const fresh = S.notes.filter(n => !S.seen.has(n.id));
      fresh.forEach(n => S.seen.add(n.id));
      if (fresh.length) toast(fresh[0].title);
    }
  } catch (e) { /* notifications are a nice-to-have; the screens still show the status */ }
}
function noteHtml(n) {
  const cls = n.kind === 'rejected' ? 'bad' : (n.kind === 'approved' || n.kind === 'live' || n.kind === 'paid' ? 'ok' : 'warn');
  return '<div class="banner ' + cls + '"><div class="row between"><strong>' + esc(n.title) + '</strong>' + (n.read ? '' : '<span class="pill ok">New</span>') + '</div><span>' + esc(n.body) + '</span>' +
    '<span class="small">' + esc(n.at ? new Date(n.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '') + '</span></div>';
}
function openInbox() {
  const html = '<div class="sheet-head"><h2 id="sheet-title" style="font-size:22px">Notifications</h2>' + closeBtn() + '</div><div class="stack">' +
    (S.notes.length ? S.notes.map(noteHtml).join('') : '<p class="muted">Nothing yet. Updates about your posts and your payment appear here.</p>') + '</div>';
  showSheet('inbox', '', html);
  if (S.notes.some(n => !n.read)) {
    sb.from('notifications').update({ read: true }).eq('read', false).then(() => {}, () => {});
    S.notes.forEach(n => { n.read = true; });
    drawBell();
  }
}

/* ---------- the waiting room: post -> review -> approval -> pay ---------- */
async function loadMine() {
  const uid = S.user.id;
  if (role() === 'editor') {
    const e = await sb.from('editors').select('*').eq('user_id', uid).maybeSingle();
    if (e.error) throw e.error;
    S.myEditor = e.data ? parseEditor(e.data) : null;
    S.posts = S.myEditor ? [S.myEditor] : [];
  } else {
    const j = await sb.from('jobs').select('*').eq('owner', uid).order('created_at', { ascending: false });
    if (j.error) throw j.error;
    S.jobs = (j.data || []).map(parseJob);
    S.posts = S.jobs;
  }
  await loadNotes();
}
function gateState() {
  const ps = S.posts;
  if (!ps.length) return 'create';
  if (ps.some(p => p.approval === 'approved')) return 'pay';
  if (ps.some(p => p.approval === 'pending')) return 'review';
  return 'rejected';
}
function gateKey() { return gateState() + '|' + S.posts.map(p => p.id + p.approval + p.note + (p.title || p.name)).join(',') + '|' + S.notes.map(n => n.id + n.read).join(','); }
function routeUnpaid() {
  const st = gateState(), key = gateKey();
  if (st === 'pay') {
    if (S.view !== 'pay') { S.view = 'pay'; S.payMsg = null; gateKeyLast = key; render(); fetchCounts(); checkPaid(true); }
    else if (key !== gateKeyLast) { gateKeyLast = key; render(); }
    return;
  }
  if (S.view !== 'gate' || S.gate !== st || key !== gateKeyLast) { S.gate = st; S.view = 'gate'; gateKeyLast = key; render(); }
}
// Runs every 15 seconds on the waiting screens, and whenever the app comes back to the front.
async function refreshGate() {
  if (refreshing || !S.user || S.isAdmin || (S.view !== 'gate' && S.view !== 'pay')) return;
  refreshing = true;
  try {
    const p = await fetchProfile();
    if (p && p.paid) { stopPolling(); toast('Payment received. Your post is live.'); startApp(); return; }
    await loadMine();
    routeUnpaid();
  } catch (e) { /* stay on the current screen; try again next time */ }
  finally { refreshing = false; }
}
function syncTimers() {
  if (S.view === 'gate' || S.view === 'pay') { if (!gateTimer) gateTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshGate(); }, 15000); }
  else if (gateTimer) { clearInterval(gateTimer); gateTimer = 0; }
  if (S.view !== 'pay') stopPolling();
}
function stepsHtml(now) {
  const editor = role() === 'editor';
  const items = [editor ? 'Create your editor profile' : 'Post your first job', 'The owner reviews it', 'Pay ' + money(PRICE) + ' once, go live'];
  return '<ol class="steps">' + items.map((t, i) => '<li class="' + (i + 1 < now ? 'done' : (i + 1 === now ? 'now' : '')) + '"><span>' + (i + 1 < now ? '✓' : (i + 1)) + '</span>' + esc(t) + '</li>').join('') + '</ol>';
}
function postRows() {
  if (role() === 'editor') return S.posts.map(e => editorCard(e, true)).join('');
  return S.posts.map(j => '<div class="rowitem" role="button" tabindex="0" data-act="openjob" data-id="' + esc(j.id) + '"><div class="row between"><strong>' + esc(j.title) + '</strong>' + approvalPill(j.approval) + '</div>' +
    '<span class="muted">' + money(j.budget) + ' ' + esc(BUDGET_UNITS[j.unit]) + ' · ' + esc(fmtDay(j.deadline)) + (j.approval === 'rejected' && j.note ? ' · ' + esc(j.note) : '') + '</span></div>').join('');
}
function gateHtml() {
  const editor = role() === 'editor', st = S.gate, first = (S.profile.name || '').split(' ')[0];
  const noun = editor ? 'profile' : 'job';
  let h = '<div class="app gate">', body = '';
  if (st === 'create') {
    h += headerHtml('Welcome' + (first ? ', ' + first : ''), editor ? 'Start with your editor profile' : 'Start with your first job');
    body = '<p>' + (editor
      ? 'Add your details, your price per minute and a link to your best work. The owner checks it. After it is approved and you have paid, every client can see it.'
      : 'Say what you need edited, your budget and the deadline. The owner checks it. After it is approved and you have paid, every editor can see it and send you a quote.') + '</p>' +
      '<button type="button" class="btn block" data-act="' + (editor ? 'editprofile' : 'newjob') + '">' + (editor ? 'Create my profile' : 'Post my job') + '</button>' +
      '<p class="small">Nothing to pay yet. You pay only after the owner approves your ' + noun + '.</p>';
  } else if (st === 'review') {
    h += headerHtml('Under review', 'The owner is checking your ' + noun);
    body = postRows() + '<div class="banner warn"><strong>Waiting for the owner</strong><span>Every post is checked by hand to keep the app real. This page updates by itself, and you will get a notice here the moment it is approved. You pay nothing yet.</span></div>' +
      '<div class="row">' + (editor ? btn('Edit my profile', 'editprofile', { ghost: true }) : btn('Post another job', 'newjob', { ghost: true })) + btn('Check again', 'gaterefresh', { ghost: true }) + '</div>';
  } else {
    h += headerHtml('Not approved yet', 'A small fix is needed');
    const bad = S.posts.filter(p => p.approval === 'rejected');
    body = postRows() + bad.map(p => '<div class="banner bad"><strong>' + esc(editor ? 'Your profile' : p.title) + '</strong><span>' + esc(p.note || 'Please check your details.') + '</span></div>').join('') +
      '<button type="button" class="btn block" data-act="' + (editor ? 'editprofile' : 'editjob') + '"' + (editor ? '' : ' data-id="' + esc(bad[0] ? bad[0].id : '') + '"') + '>Fix it and send again</button>';
  }
  h += '<div class="stack">' + stepsHtml(st === 'create' ? 1 : 2) + body + (S.notes.length ? '<div class="section"><h3>Updates</h3>' + S.notes.slice(0, 3).map(noteHtml).join('') + '</div>' : '') +
    legalLinks() + supportLine() + '<div class="row"><button type="button" class="link" data-act="signout">Sign out</button><button type="button" class="link" data-act="deleteaccount">Delete my account</button></div></div></div>';
  return h;
}

/* ---------- paying ---------- */
function payHtml() {
  const editor = role() === 'editor';
  const ticks = editor
    ? ['Your profile goes live: every client can see your price, portfolio and contact', 'You can see every open job from clients and apply with your own quote', 'Pay once. No monthly charges.']
    : ['Your job goes live: every editor can see it and send you a quote', 'You can browse every editor: price per minute, portfolio and contact', 'Pay once. No monthly charges.'];
  const approved = S.posts.filter(p => p.approval === 'approved');
  const okLine = approved.map(p => '<div class="banner ok"><strong>Approved</strong><span>' + (editor ? 'Your editor profile' : '“' + esc(p.title) + '”') + ' passed the owner’s check.</span></div>').join('');
  let teaser = '';
  if (S.counts) {
    const n = editor ? S.counts.open_jobs : S.counts.editors;
    teaser = n > 0
      ? '<p class="msg">' + n + (editor ? (n === 1 ? ' open job is' : ' open jobs are') + ' live right now.' : (n === 1 ? ' editor is' : ' editors are') + ' live right now.') + '</p>'
      : '<p class="msg">The marketplace is just starting. Early members are the first ones people see.</p>';
  }
  return '<div class="app gate">' + headerHtml('Approved. One last step', 'Hi ' + (S.profile ? S.profile.name : '') + '. Pay once and your post goes live.') +
    '<div class="stack">' + stepsHtml(3) + okLine +
    '<div class="price"><span class="amt mono">' + money(PRICE) + '</span><span class="muted">one time</span></div>' +
    '<ul class="ticks">' + ticks.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul>' + teaser +
    '<button type="button" class="btn block" id="paybtn" data-act="pay"' + (S.payBusy ? ' disabled' : '') + '>' + (S.payBusy ? 'Opening payment…' : 'Pay ' + money(PRICE) + ' and go live') + '</button>' +
    (S.payUrl ? '<a class="btn ghost block" href="' + esc(S.payUrl) + '" target="_blank" rel="noopener">Payment page did not open? Tap here</a>' : '') +
    '<p class="msg' + (S.payMsg && S.payMsg.bad ? ' bad' : '') + '" id="paymsg" role="status"' + (S.payMsg ? '' : ' hidden') + '>' + esc(S.payMsg ? S.payMsg.text : '') + '</p>' +
    '<button type="button" class="btn ghost block" data-act="paycheck">I have paid, check now</button>' +
    '<p class="small">You pay on Razorpay with UPI, card or net banking. This is a fee to publish your post and use the app; it does not promise work or hires. Your post goes live by itself within a few seconds of paying.</p>' +
    (S.notes.length ? '<div class="section"><h3>Updates</h3>' + S.notes.slice(0, 2).map(noteHtml).join('') + '</div>' : '') +
    legalLinks() + supportLine() +
    '<div class="row"><button type="button" class="link" data-act="signout">Sign out</button><button type="button" class="link" data-act="deleteaccount">Delete my account</button></div></div></div>';
}
function setPayMsg(text, bad) {
  S.payMsg = text ? { text, bad: !!bad } : null;
  const el = $('#paymsg');
  if (!el) return;
  el.hidden = !text; el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}
async function fetchCounts() {
  try { const r = await sb.rpc('market_counts'); if (!r.error && r.data) { S.counts = { open_jobs: num(r.data.open_jobs), editors: num(r.data.editors) }; if (S.view === 'pay') render(); } } catch (e) { /* the teaser is optional */ }
}

async function callFn(body) {
  const { data } = await sb.auth.getSession();
  if (!data || !data.session) throw new Error('not signed in');
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token, apikey: String(CFG.SUPABASE_ANON_KEY) },
    body: JSON.stringify(body)
  });
  let j = {};
  try { j = await res.json(); } catch (e) { /* no body */ }
  return { ok: res.ok, status: res.status, body: j || {} };
}
function fnError(r) {
  const c = r.body && r.body.error;
  if (r.status === 401) return 'Your session ended. Please sign out and log in again.';
  if (c === 'not_approved_yet') return 'The owner has not approved your post yet. You will be told here when you can pay.';
  if (c === 'payments_not_configured') return 'Payments are not switched on yet. Please contact support.';
  if (c === 'razorpay_create_failed') return 'The payment page could not be created. Please try again in a minute.';
  if (r.status === 404) return 'The payment service is not set up yet. Please contact support.';
  return 'Something went wrong. Please try again.';
}
async function doPay() {
  if (S.payBusy) return;
  S.payBusy = true; S.payMsg = null; render();
  try {
    const r = await callFn({ action: 'create' });
    if (r.body && r.body.paid) { S.payBusy = false; await onPaid(); return; }
    if (!r.ok || !r.body.url) { S.payBusy = false; render(); setPayMsg(fnError(r), true); return; }
    S.payUrl = r.body.url; S.payBusy = false; render();
    openExternal(r.body.url);
    setPayMsg('Finish the payment on the page that opened, then come back here. Your account unlocks by itself.');
    startPolling();
  } catch (e) { S.payBusy = false; render(); setPayMsg(/fetch|network|failed/i.test(String(e && e.message)) ? 'No internet connection. Please try again.' : 'Something went wrong. Please try again.', true); }
}
async function checkPaid(silent) {
  if (S.view !== 'pay' || S.checking) return;
  S.checking = true;
  if (!silent) setPayMsg('Checking your payment…');
  try {
    const r = await callFn({ action: 'check' });
    if (r.body && r.body.paid) { S.checking = false; await onPaid(); return; }
    if (!silent) {
      if (!r.ok) setPayMsg(fnError(r), true);
      else if (r.body.warning) setPayMsg('We could not reach the payment service just now. Please tap again in a moment.', true);
      else setPayMsg('We have not received your payment yet. If you just paid, wait a few seconds and tap again.');
    }
  } catch (e) { if (!silent) setPayMsg('No internet connection. Please try again.', true); }
  S.checking = false;
}
async function onPaid() {
  stopPolling();
  if (!(await loadProfile())) return;
  if (S.profile.paid) { toast('Payment received. Your post is live.'); startApp(); }
  else setPayMsg('Your payment is confirmed. Opening your account…');
}
function startPolling() {
  stopPolling();
  S.payStarted = Date.now();
  payTimer = setInterval(() => {
    if (Date.now() - S.payStarted > 20 * 60 * 1000) { stopPolling(); return; }
    checkPaid(true);
  }, 5000);
}
function stopPolling() { if (payTimer) { clearInterval(payTimer); payTimer = 0; } }

/* ---------- the app ---------- */
function startApp() {
  S.tab = S.isAdmin ? 'review' : (role() === 'editor' ? 'work' : 'editors');
  S.view = 'app'; S.ready = false;
  render();
  loadData();
}
function navItems() {
  if (S.isAdmin) {
    const st = S.admin.stats || {};
    return [{ id: 'review', label: 'Review', icon: 'inbox', badge: num(st.pending_jobs) + num(st.pending_editors) }, { id: 'live', label: 'Live', icon: 'list' }, { id: 'owner', label: 'Owner', icon: 'user' }];
  }
  return role() === 'editor'
    ? [{ id: 'work', label: 'Find work', icon: 'work' }, { id: 'applied', label: 'Applied', icon: 'list' }, { id: 'me', label: 'Me', icon: 'user' }]
    : [{ id: 'editors', label: 'Find editors', icon: 'users' }, { id: 'jobs', label: 'My jobs', icon: 'list' }, { id: 'me', label: 'Me', icon: 'user' }];
}
function buildNav() {
  $('#nav').innerHTML = '<div class="inner">' + navItems().map(n =>
    '<button type="button" data-act="tab" data-tab="' + n.id + '"' + (n.id === S.tab ? ' aria-current="page"' : '') + '>' + svg(n.icon) + '<span>' + esc(n.label) + '</span>' + (n.badge ? '<span class="badge">' + n.badge + '</span>' : '') + '</button>').join('') + '</div>';
}
const TITLES = {
  work: ['Find work', 'Open jobs from clients'], applied: ['Applied', 'Jobs you sent a quote for'],
  editors: ['Find editors', 'Editors listed in the app'], jobs: ['My jobs', 'Your posts and who applied'],
  me: ['Me', ''], review: ['Review', 'Nothing goes live until you approve it'],
  live: ['Live', 'Approved posts everyone can see'], owner: ['Owner', 'Numbers and account']
};
function setHeader() {
  const t = TITLES[S.tab] || ['', ''];
  $('#h-title').textContent = t[0];
  $('#h-sub').textContent = S.tab === 'me' && S.profile ? S.profile.name : t[1];
}
function renderNotice() {
  const el = $('#notice');
  if (!el) return;
  el.innerHTML = S.loadError ? '<div class="notice bad">' + esc(S.loadError) + ' <button type="button" class="link" data-act="refresh">Try again</button></div>' : '';
}

async function loadData(quiet) {
  if (S.loading || !S.user) return;
  S.loading = true;
  const spin = $('[data-act="refresh"]'); if (spin) spin.classList.add('spin');
  try {
    const uid = S.user.id;
    if (S.isAdmin) {
      const rs = await Promise.all(['pending', 'approved', 'rejected'].map(s => sb.rpc('admin_queue', { p_status: s })));
      rs.forEach(r => { if (r.error) throw r.error; });
      S.admin.jobs = []; S.admin.editors = [];
      rs.forEach(r => { S.admin.jobs.push(...(r.data.jobs || []).map(parseJob)); S.admin.editors.push(...(r.data.editors || []).map(parseEditor)); });
      S.admin.stats = rs[0].data.stats || null;
    } else if (role() === 'editor') {
      const [j, a, e] = await Promise.all([
        sb.from('jobs').select('*').order('created_at', { ascending: false }).limit(300),
        sb.from('applications').select('*').eq('editor_id', uid).order('created_at', { ascending: false }),
        sb.from('editors').select('*').eq('user_id', uid).maybeSingle()
      ]);
      [j, a, e].forEach(r => { if (r.error) throw r.error; });
      S.jobs = (j.data || []).map(parseJob); S.apps = (a.data || []).map(parseApp); S.myEditor = e.data ? parseEditor(e.data) : null;
    } else {
      const [ed, jb, ap] = await Promise.all([
        sb.from('editors').select('*').order('updated_at', { ascending: false }).limit(300),
        sb.from('jobs').select('*').eq('owner', uid).order('created_at', { ascending: false }),
        sb.from('applications').select('*').order('created_at', { ascending: true })
      ]);
      [ed, jb, ap].forEach(r => { if (r.error) throw r.error; });
      S.editors = (ed.data || []).map(parseEditor); S.jobs = (jb.data || []).map(parseJob); S.apps = (ap.data || []).map(parseApp);
    }
    if (!S.isAdmin) await loadNotes();
    S.loadError = '';
  } catch (e) {
    console.error(e);
    S.loadError = /fetch|network|failed|load/i.test(String((e && e.message) || '')) ? 'No internet connection, so this list may be out of date.' : 'Could not load the latest data.';
  }
  S.loading = false; S.ready = true; S.lastLoad = Date.now();
  if (spin) spin.classList.remove('spin');
  if (S.view === 'app') { buildNav(); refreshView(); drawBell(); }
  if (!quiet && !S.loadError) { /* silent on success */ }
}
function refreshView() {
  const body = $('#body');
  if (!body) return;
  renderNotice();
  const shell = body.dataset.shell;
  if ((S.tab === 'work' || S.tab === 'editors') && shell === S.tab) { drawGate(); drawList(); }
  else drawTab();
  refreshSheet();
}

/* ---------- tabs ---------- */
function loadingHtml() { return '<p class="muted pad">Loading…</p>'; }
function drawTab() {
  const body = $('#body');
  if (!body) return;
  setHeader(); renderNotice(); buildNav();
  const t = S.tab;
  if (t === 'work' || t === 'editors') { ensureSearch(t); drawGate(); drawList(); return; }
  delete body.dataset.shell;
  if (!S.ready) { body.innerHTML = loadingHtml(); return; }
  body.innerHTML = ({ applied: appliedHtml, jobs: myJobsHtml, me: meHtml, review: reviewHtml, live: liveHtml, owner: ownerHtml }[t] || (() => ''))();
}
function ensureSearch(kind) {
  const body = $('#body');
  if (body.dataset.shell === kind) return;
  body.dataset.shell = kind;
  const items = [{ id: 'all', label: 'All' }].concat(TYPES);
  const chips = items.map(t => '<button type="button" class="chip' + (t.id !== 'all' ? ' t-' + t.id : '') + '" data-act="filter" data-v="' + t.id + '" aria-pressed="' + (S.f[kind] === t.id) + '">' + esc(t.label) + '</button>').join('') +
    (kind === 'editors' ? '<button type="button" class="chip" data-act="openonly" aria-pressed="' + S.openOnly + '">Open for work</button>' : '');
  body.innerHTML = '<div id="gate"></div><div class="search" style="margin-top:14px"><input id="q" type="search" placeholder="' + (kind === 'work' ? 'Search jobs' : 'Search editors, cities, software') + '" aria-label="Search" value="' + esc(S.q[kind]) + '"></div>' +
    '<div class="chips" id="chips">' + chips + '</div><p class="small" id="count" style="margin-top:6px"></p><div class="list" id="list"></div>';
}
function drawGate() {
  const el = $('#gate');
  if (!el) return;
  if (role() !== 'editor' || S.tab !== 'work') { el.innerHTML = ''; return; }
  const e = S.myEditor;
  if (!e) el.innerHTML = '<div class="banner warn" style="margin-top:14px"><strong>Create your editor profile</strong><span>Clients cannot see you yet. Add your rates, software and portfolio; you can apply to jobs once the owner approves it.</span><div>' + btn('Create profile', 'editprofile') + '</div></div>';
  else if (e.approval === 'pending') el.innerHTML = '<div class="banner warn" style="margin-top:14px"><strong>Your profile is in review</strong><span>The owner checks every profile before clients see it. You can browse jobs now and apply as soon as it is approved.</span></div>';
  else if (e.approval === 'rejected') el.innerHTML = '<div class="banner bad" style="margin-top:14px"><strong>Your profile was not approved</strong><span>' + esc(e.note || 'Please check your details.') + '</span><div>' + btn('Fix and resend', 'editprofile') + '</div></div>';
  else el.innerHTML = '';
}
function drawList() {
  const kind = S.tab, el = $('#list');
  if (!el) return;
  if (!S.ready) { el.innerHTML = loadingHtml(); $('#count').textContent = ''; return; }
  const q = S.q[kind].trim().toLowerCase();
  if (kind === 'work') {
    const open = S.jobs.filter(j => j.status === 'open' && j.approval === 'approved');
    const list = open.filter(j => (S.f.work === 'all' || j.type === S.f.work) && (!q || (j.title + ' ' + j.brief + ' ' + TYPE[j.type].label + ' ' + j.tools.join(' ') + ' ' + j.poster).toLowerCase().includes(q)));
    list.sort((a, b) => dueKey(a) - dueKey(b));
    $('#count').textContent = open.length ? list.length + ' of ' + open.length + ' open' : '';
    if (!open.length) el.innerHTML = empty('No jobs yet', 'Clients are still posting. New jobs appear here as soon as the owner approves them. Pull the refresh button now and then.');
    else if (!list.length) el.innerHTML = empty('Nothing matches', 'Try a different word or clear the filters.', btn('Clear filters', 'clear', { ghost: true }));
    else el.innerHTML = list.map(j => jobCard(j, new Map())).join('');
  } else {
    const all = S.editors;
    const list = all.filter(e => (S.f.editors === 'all' || e.skills.includes(S.f.editors)) && (!S.openOnly || e.available) &&
      (!q || (e.name + ' ' + e.headline + ' ' + e.city + ' ' + e.tools.join(' ') + ' ' + e.skills.map(s => TYPE[s].label).join(' ')).toLowerCase().includes(q)));
    list.sort((a, b) => (Number(b.available) - Number(a.available)) || (b.updatedAt - a.updatedAt));
    $('#count').textContent = all.length ? list.length + ' of ' + all.length + ' listed' : '';
    if (!all.length) el.innerHTML = empty('No editors listed yet', 'Editors appear here once the owner has approved their profile. Check back soon, or post a job so editors can find you.', btn('Post a job', 'newjob'));
    else if (!list.length) el.innerHTML = empty('Nothing matches', 'Try a different word or clear the filters.', btn('Clear filters', 'clear', { ghost: true }));
    else el.innerHTML = list.map(e => editorCard(e, false)).join('') + '<p class="nudge">Need an edit? <button type="button" class="link" data-act="newjob">Post a job</button> and editors will send quotes.</p>';
  }
}
function appliedHtml() {
  const apps = S.apps.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (!apps.length) return empty('No applications yet', 'Find a job under Find work and send your quote. It shows up here with its status.', btn('Find work', 'tab', { attrs: 'data-tab="work"' }));
  return '<div class="list">' + apps.map(a => {
    const j = jobById(a.jobId);
    if (!j) return '';
    const cls = a.status === 'hired' ? 'pill ok' : (a.status === 'shortlisted' ? 'pill warn' : 'pill');
    return '<div class="rowitem" role="button" tabindex="0" data-act="openjob" data-id="' + esc(j.id) + '"><div class="row between"><strong>' + esc(j.title) + '</strong><span class="' + cls + '">' + esc(STATUS_LABEL[a.status]) + '</span></div>' +
      '<span class="muted">Your quote ' + money(a.quote) + ' · ' + esc(j.poster || 'Client') + (j.status !== 'open' ? ' · job ' + (j.status === 'filled' ? 'filled' : 'closed') : '') + '</span></div>';
  }).join('') + '</div>';
}
function myJobsHtml() {
  const counts = appsByJob();
  let h = '<div class="row between" style="margin-top:14px"><p class="muted">Every job is checked by the owner before editors see it.</p>' + btn('Post a job', 'newjob') + '</div>';
  if (!S.jobs.length) return h + '<div class="list">' + empty('No jobs yet', 'Post what you need edited. Once it is approved, editors can send you quotes.') + '</div>';
  h += '<div class="list">' + S.jobs.map(j => {
    const apps = counts.get(j.id) || [], fresh = apps.filter(a => a.status === 'new').length;
    const sub = j.approval === 'approved'
      ? apps.length + ' applied' + (fresh ? ' · ' + fresh + ' new' : '') + ' · ' + fmtDay(j.deadline) + (j.status !== 'open' ? ' · ' + (j.status === 'filled' ? 'editor hired' : 'closed') : '')
      : (j.approval === 'pending' ? 'Waiting for the owner to check it' : 'Not approved: ' + (j.note || 'please edit and resend'));
    return '<div class="rowitem" role="button" tabindex="0" data-act="openjob" data-id="' + esc(j.id) + '"><div class="row between"><strong>' + esc(j.title) + '</strong>' + approvalPill(j.approval) + '</div><span class="muted">' + esc(sub) + '</span></div>';
  }).join('') + '</div>';
  return h;
}
function meHtml() {
  const p = S.profile;
  let h = '<div class="section"><h3>Your account</h3><dl class="facts"><dt>Name</dt><dd>' + esc(p.name) + '</dd><dt>Email</dt><dd>' + esc(S.user.email || '') + '</dd><dt>WhatsApp</dt><dd>' + esc(p.phone || 'Not added') + '</dd>' +
    '<dt>Type</dt><dd>' + (p.role === 'editor' ? 'Video editor' : 'Client') + '</dd><dt>Access</dt><dd>Unlocked' + (p.paidAt ? ' on ' + esc(when(p.paidAt)) : '') + '</dd></dl>' +
    '<div>' + btn('Edit my details', 'editdetails', { ghost: true }) + '</div></div>';
  if (p.role === 'editor') {
    const e = S.myEditor;
    h += '<div class="section"><div class="row between"><h3>Your editor profile</h3>' + (e ? btn('Edit', 'editprofile', { ghost: true }).replace('class="btn ghost"', 'class="btn ghost sm"') : '') + '</div>';
    if (!e) h += empty('You have no profile yet', 'Add your rates, software and portfolio. The owner checks it, then clients can find you.', btn('Create profile', 'editprofile'));
    else {
      h += editorCard(e, true);
      if (e.approval === 'pending') h += '<div class="banner warn"><strong>In review</strong><span>Clients cannot see this yet. It goes live when the owner approves it.</span></div>';
      if (e.approval === 'rejected') h += '<div class="banner bad"><strong>Not approved</strong><span>' + esc(e.note || 'Please check your details.') + '</span><span>Edit your profile and send it again.</span></div>';
    }
    h += '</div>';
  }
  h += '<div class="section"><h3>Help</h3>' + (supportLine() || '<p class="small">Contact the app owner if you need help.') + legalLinks() + '</div>';
  h += '<div class="section"><button type="button" class="btn ghost block" data-act="signout">Sign out</button>' +
    '<button type="button" class="btn danger block" data-act="deleteaccount">Delete my account</button>' +
    '<p class="small">Deleting removes your profile, posts and applications for good. The ' + money(PRICE) + ' access fee is not refunded (see the Refund Policy).</p></div>';
  return h;
}

/* ---------- owner: review desk ---------- */
function adminItems(status) {
  const jobs = S.admin.jobs.filter(j => j.approval === status).map(x => ({ kind: 'job', at: x.createdAt, x }));
  const eds = S.admin.editors.filter(e => e.approval === status).map(x => ({ kind: 'editor', at: x.updatedAt, x }));
  return jobs.concat(eds);
}
function adminCard(it) {
  const x = it.x, by = x.by || {};
  if (it.kind === 'job') {
    return '<article class="card job t-' + esc(x.type) + '" role="button" tabindex="0" data-act="openreview" data-kind="job" data-id="' + esc(x.id) + '">' +
      '<div class="row between"><span class="kind">Job</span>' + approvalPill(x.approval) + '</div>' + '<div class="row">' + tagHtml(x.type) + '</div>' +
      '<h3>' + esc(x.title) + '</h3><p class="brief">' + esc(x.brief) + '</p>' +
      '<div class="row between foot"><span class="money">' + money(x.budget) + ' <small>' + esc(BUDGET_UNITS[x.unit]) + '</small></span><span class="muted">' + esc(by.name || x.poster || '') + '</span></div></article>';
  }
  return '<article class="card editor t-' + esc(x.skills[0] || 'youtube') + '" role="button" tabindex="0" data-act="openreview" data-kind="editor" data-id="' + esc(x.id) + '">' +
    '<div class="avatar" aria-hidden="true">' + esc(initials(x.name)) + '</div><div class="body"><div class="row between"><span class="kind">Editor profile</span>' + approvalPill(x.approval) + '</div>' +
    '<h3>' + esc(x.name) + '</h3>' + (x.headline ? '<p class="muted">' + esc(x.headline) + '</p>' : '') + '<div class="tags">' + x.skills.map(tagHtml).join('') + '</div>' +
    '<div class="row between foot"><span class="money">' + (x.rate ? money(x.rate) + ' <small>' + esc(RATE_UNITS[x.unit]) + '</small>' : '<small>No rate</small>') + '</span><span class="muted">' + esc(x.city) + '</span></div></div></article>';
}
function reviewHtml() {
  const items = adminItems('pending').sort((a, b) => a.at - b.at);
  if (!items.length) return empty('All caught up', 'Nothing is waiting for your approval. New profiles and jobs appear here the moment someone sends them.');
  return '<p class="small" style="margin-top:14px">' + items.length + ' waiting, oldest first. Open one to check it, then approve or reject.</p><div class="list">' + items.map(adminCard).join('') + '</div>';
}
function liveHtml() {
  const f = S.admin.filter;
  const items = adminItems(f).sort((a, b) => b.at - a.at);
  return '<div class="seg" style="margin-top:14px"><button type="button" data-act="adminfilter" data-v="approved" aria-pressed="' + (f === 'approved') + '">Approved</button><button type="button" data-act="adminfilter" data-v="rejected" aria-pressed="' + (f === 'rejected') + '">Rejected</button></div>' +
    (items.length ? '<div class="list">' + items.map(adminCard).join('') + '</div>' : '<div class="list">' + empty(f === 'approved' ? 'Nothing is live yet' : 'Nothing rejected', f === 'approved' ? 'Approved jobs and profiles show here. Open one to take it down.' : 'Rejected posts show here. Open one to change your mind.') + '</div>');
}
function ownerHtml() {
  const st = S.admin.stats;
  let h = '';
  if (st) {
    const cell = (v, l, hot) => '<div class="stat' + (hot && v > 0 ? ' hot' : '') + '"><b class="mono">' + esc(v) + '</b><span>' + esc(l) + '</span></div>';
    h += '<div class="section"><h3>Money</h3><div class="stats">' + cell(money(num(st.revenue) / 100), 'collected (before Razorpay fees)') + cell(num(st.paid), 'paid members') + '</div></div>' +
      '<div class="section"><h3>People</h3><div class="stats">' + cell(num(st.members), 'registered') + cell(num(st.members) - num(st.paid), 'not paid yet') + cell(num(st.editor_members), 'editors') + cell(num(st.client_members), 'clients') + cell(num(st.awaiting_payment), 'approved, waiting to pay') + '</div></div>' +
      '<div class="section"><h3>Posts</h3><div class="stats">' + cell(num(st.pending_jobs) + num(st.pending_editors), 'waiting for review', true) + cell(num(st.live_jobs), 'live jobs') + cell(num(st.live_editors), 'live editors') + '</div></div>';
  } else h += loadingHtml();
  h += '<div class="section"><h3>Account</h3><p class="muted">Signed in as ' + esc(S.user.email || '') + '</p><button type="button" class="btn ghost block" data-act="signout">Sign out</button>' +
    '<p class="small">To try the app as an editor or a client, sign up with a different email. This owner account only has the review desk.</p></div>';
  return h;
}

/* ---------- sheets ---------- */
const sheetEl = () => $('#sheet');
function showSheet(kind, id, html, from, extra) {
  const el = sheetEl();
  if (el.hidden) { lastFocus = document.activeElement; try { history.pushState({ sheet: 1 }, ''); } catch (e) { /* history is optional */ } }
  sheet = { kind, id, from: from || null, extra: extra || null };
  $('#sheet-body').innerHTML = html;
  el.hidden = false;
  document.documentElement.classList.add('noscroll');
  const p = $('.panel', el); p.scrollTop = 0; p.focus();
}
function closeSheet(fromPop) {
  const el = sheetEl();
  if (!el || el.hidden) return;
  el.hidden = true;
  sheet = { kind: null, id: null, from: null, extra: null };
  $('#sheet-body').innerHTML = '';
  document.documentElement.classList.remove('noscroll');
  if (!fromPop) { try { if (history.state && history.state.sheet) history.back(); } catch (e) { /* ignore */ } }
  if (lastFocus && document.contains(lastFocus) && lastFocus.focus) lastFocus.focus();
}
function refreshSheet() {
  const el = sheetEl();
  if (el.hidden) return;
  let html = '';
  if (sheet.kind === 'job') { const j = jobById(sheet.id); if (!j) { closeSheet(); return; } html = jobSheet(j); }
  else if (sheet.kind === 'editor') { const e = editorById(sheet.id); if (!e) { closeSheet(); return; } html = editorSheet(e, sheet.from); }
  else return; // forms and review sheets are left alone so typing is never lost
  const p = $('.panel', el), st = p.scrollTop;
  $('#sheet-body').innerHTML = html; p.scrollTop = st;
}
const closeBtn = () => '<button type="button" class="x" data-act="close" aria-label="Close">×</button>';

function jobSheet(j) {
  const mine = j.owner === S.user.id;
  const d = daysLeft(j.deadline);
  const apps = (appsByJob().get(j.id) || []).slice().sort((a, b) => ['hired', 'shortlisted', 'new', 'declined'].indexOf(a.status) - ['hired', 'shortlisted', 'new', 'declined'].indexOf(b.status) || a.createdAt - b.createdAt);
  const my = myApp(j.id);
  const statusPill = j.status === 'open' ? '' : (j.status === 'filled' ? '<span class="pill warn">Editor hired</span>' : '<span class="pill">Closed</span>');
  let h = '<div class="sheet-head"><span></span>' + closeBtn() + '</div><div class="stack">' +
    '<div class="row">' + tagHtml(j.type) + statusPill + (mine ? approvalPill(j.approval) : '') + '</div>' +
    '<h2 id="sheet-title">' + esc(j.title) + '</h2>' +
    (mine ? '' : '<p class="muted">Posted by ' + esc(j.poster || 'a client') + '</p>') +
    stripHtml(j.type, d) +
    '<dl class="facts"><dt>Budget</dt><dd><span class="money">' + money(j.budget) + '</span> <small>' + esc(BUDGET_UNITS[j.unit]) + '</small></dd>' +
      '<dt>Due</dt><dd>' + esc(fmtDay(j.deadline)) + ' <small>' + esc(dueText(d)) + '</small></dd>' +
      (j.length ? '<dt>Length</dt><dd>' + esc(j.length) + '</dd>' : '') + (j.tools.length ? '<dt>Software</dt><dd>' + esc(j.tools.join(', ')) + '</dd>' : '') + '</dl>' +
    '<p class="long">' + esc(j.brief) + '</p>';
  if (mine) {
    if (j.approval === 'pending') h += '<div class="banner warn"><strong>Waiting for review</strong><span>Editors cannot see this job until the owner approves it. You will see it turn Live here.</span></div>';
    if (j.approval === 'rejected') h += '<div class="banner bad"><strong>Not approved</strong><span>' + esc(j.note || 'Please check the details.') + '</span><span>Edit the job and send it again.</span></div>';
    h += '<div class="row">' + btn('Edit job', 'editjob', { ghost: true, attrs: 'data-id="' + esc(j.id) + '"' }) + '</div>';
    if (j.approval === 'approved') {
      h += '<h3 class="sub">Applicants (' + apps.length + ')</h3>';
      if (!apps.length) h += '<p class="note">No applications yet. Editors see this job under Find work.</p>';
      apps.forEach(a => {
        const e = editorById(a.editorId);
        const cls = a.status === 'hired' ? 'pill ok' : (a.status === 'shortlisted' ? 'pill warn' : 'pill');
        h += '<div class="applicant"><div class="row between">' + (e ? '<button type="button" class="link" data-act="openeditor" data-id="' + esc(a.editorId) + '" data-from="' + esc(j.id) + '">' + esc(e.name) + '</button>' : '<strong>Editor</strong>') + '<span class="' + cls + '">' + esc(STATUS_LABEL[a.status]) + '</span></div>' +
          (e && e.headline ? '<p class="muted">' + esc(e.headline) + '</p>' : '') + '<p class="long">' + esc(a.message) + '</p>' +
          '<div class="row between"><span class="money">' + money(a.quote) + ' <small>their quote</small></span>' + (e && e.rate ? '<span class="muted">Rate card ' + money(e.rate) + ' ' + esc(RATE_UNITS[e.unit]) + '</span>' : '') + '</div>' +
          (e ? contactRow(e.contact) : '<p class="small">Their profile is not available right now.</p>') +
          '<div class="btns">' +
            (a.status === 'new' ? '<button type="button" class="btn ghost sm" data-act="setstatus" data-id="' + esc(a.id) + '" data-status="shortlisted">Shortlist</button>' : '') +
            (a.status !== 'hired' && a.status !== 'declined' && j.status === 'open' ? '<button type="button" class="btn sm" data-act="setstatus" data-id="' + esc(a.id) + '" data-status="hired">Hire</button>' : '') +
            (a.status !== 'hired' && a.status !== 'declined' ? '<button type="button" class="btn ghost sm" data-act="setstatus" data-id="' + esc(a.id) + '" data-status="declined">Decline</button>' : '') + '</div></div>';
      });
      h += '<div class="row">' + (j.status === 'open' ? '<button type="button" class="btn ghost" data-act="closejob" data-id="' + esc(j.id) + '">Close job</button>' : '<button type="button" class="btn ghost" data-act="reopen" data-id="' + esc(j.id) + '">Reopen job</button>') + '</div>';
    }
    h += '<button type="button" class="btn danger" data-act="deletejob" data-id="' + esc(j.id) + '">Delete job</button>';
  } else if (my) {
    h += '<div class="note">You applied with a quote of ' + money(my.quote) + '. Status: <strong>' + esc(STATUS_LABEL[my.status]) + '</strong>.<p class="long" style="margin-top:8px">' + esc(my.message) + '</p></div>';
    if (my.status === 'hired') h += '<div class="banner ok"><strong>You are hired</strong><span>The client will contact you on the number in your profile. Keep your phone handy.</span></div>';
  } else if (j.status !== 'open') h += '<p class="note">This job is no longer taking applications.</p>';
  else if (!S.myEditor) h += '<p class="note">Create your editor profile first. Clients look at it when you apply.</p>' + btn('Create editor profile', 'editprofile');
  else if (S.myEditor.approval !== 'approved') h += '<div class="banner warn"><strong>' + (S.myEditor.approval === 'pending' ? 'Your profile is in review' : 'Your profile was not approved') + '</strong><span>You can apply once the owner approves your profile.</span></div>';
  else h += '<button type="button" class="btn block" data-act="apply" data-id="' + esc(j.id) + '">Apply with your quote</button>';
  return h + '</div>';
}
function editorSheet(e, from) {
  const mine = S.user && e.id === S.user.id;
  const first = e.skills[0] || 'youtube';
  return '<div class="sheet-head">' + (from ? '<button type="button" class="link" data-act="back" data-id="' + esc(from) + '">← Back to job</button>' : '<span></span>') + closeBtn() + '</div><div class="stack">' +
    '<div class="ed-head t-' + esc(first) + '"><div class="avatar big" aria-hidden="true">' + esc(initials(e.name)) + '</div><div><h2 id="sheet-title">' + esc(e.name) + '</h2>' + (e.headline ? '<p class="muted">' + esc(e.headline) + '</p>' : '') + '</div></div>' +
    '<div class="row"><span class="avail' + (e.available ? ' on' : '') + '">' + (e.available ? 'Open for work' : 'Booked') + '</span>' + (e.city ? '<span class="muted">' + esc(e.city) + '</span>' : '') + (mine ? approvalPill(e.approval) : '') + '</div>' +
    (e.about ? '<p class="long">' + esc(e.about) + '</p>' : '') +
    '<dl class="facts"><dt>Rate</dt><dd>' + (e.rate ? '<span class="money">' + money(e.rate) + '</span> <small>' + esc(RATE_UNITS[e.unit]) + '</small>' : 'On request') + '</dd>' +
      (e.skills.length ? '<dt>Edits</dt><dd><div class="tags">' + e.skills.map(tagHtml).join('') + '</div></dd>' : '') + (e.tools.length ? '<dt>Software</dt><dd>' + esc(e.tools.join(', ')) + '</dd>' : '') +
      (e.portfolio ? '<dt>Portfolio</dt><dd><a href="' + esc(e.portfolio) + '" target="_blank" rel="noopener noreferrer">' + esc(new URL(e.portfolio).host) + '</a></dd>' : '') + '</dl>' +
    '<h3 class="sub">Contact</h3>' + contactRow(e.contact) +
    (mine ? '<button type="button" class="btn ghost block" data-act="editprofile">Edit your profile</button>' : '') + '</div>';
}

/* owner: one item up close */
function reviewSheet(kind, x) {
  const by = x.by || {};
  const wa = waLink(by.phone);
  let h = '<div class="sheet-head"><span class="kind">' + (kind === 'job' ? 'Job' : 'Editor profile') + ' · ' + esc(x.approval) + '</span>' + closeBtn() + '</div><div class="stack">';
  if (kind === 'job') {
    h += '<div class="row">' + tagHtml(x.type) + approvalPill(x.approval) + '</div><h2 id="sheet-title">' + esc(x.title) + '</h2>' +
      '<dl class="facts"><dt>Budget</dt><dd><span class="money">' + money(x.budget) + '</span> <small>' + esc(BUDGET_UNITS[x.unit]) + '</small></dd><dt>Due</dt><dd>' + esc(fmtDay(x.deadline)) + '</dd>' +
      (x.length ? '<dt>Length</dt><dd>' + esc(x.length) + '</dd>' : '') + (x.tools.length ? '<dt>Software</dt><dd>' + esc(x.tools.join(', ')) + '</dd>' : '') + '</dl><p class="long">' + esc(x.brief) + '</p>';
  } else {
    h += '<div class="ed-head t-' + esc(x.skills[0] || 'youtube') + '"><div class="avatar big" aria-hidden="true">' + esc(initials(x.name)) + '</div><div><h2 id="sheet-title">' + esc(x.name) + '</h2>' + (x.headline ? '<p class="muted">' + esc(x.headline) + '</p>' : '') + '</div></div>' +
      (x.about ? '<p class="long">' + esc(x.about) + '</p>' : '') +
      '<dl class="facts"><dt>Rate</dt><dd>' + (x.rate ? money(x.rate) + ' <small>' + esc(RATE_UNITS[x.unit]) + '</small>' : 'None given') + '</dd><dt>City</dt><dd>' + esc(x.city || '—') + '</dd>' +
      (x.skills.length ? '<dt>Edits</dt><dd><div class="tags">' + x.skills.map(tagHtml).join('') + '</div></dd>' : '') + (x.tools.length ? '<dt>Software</dt><dd>' + esc(x.tools.join(', ')) + '</dd>' : '') +
      '<dt>Portfolio</dt><dd>' + (x.portfolio ? '<a href="' + esc(x.portfolio) + '" target="_blank" rel="noopener noreferrer">' + esc(x.portfolio) + '</a>' : 'None given') + '</dd><dt>Contact</dt><dd>' + esc(x.contact) + '</dd></dl>';
  }
  h += '<h3 class="sub">Who sent it</h3><div class="who"><strong>' + esc(by.name || '—') + '</strong>' +
    '<div class="contact"><span class="sel mono">' + esc(by.email || 'no email') + '</span>' + (by.email ? '<button type="button" class="btn ghost sm" data-act="copy" data-text="' + esc(by.email) + '">Copy</button>' : '') + '</div>' +
    '<div class="contact"><span class="sel mono">' + esc(by.phone || 'no number') + '</span>' + (by.phone ? '<button type="button" class="btn ghost sm" data-act="copy" data-text="' + esc(by.phone) + '">Copy</button>' : '') +
      (wa ? '<a class="btn ghost sm" href="' + esc(wa) + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' : '') + '</div>' +
    '<span class="small">' + (by.paid ? 'Paid member' : 'Has not paid') + (by.joined ? ' · joined ' + esc(when(by.joined)) : '') + '</span></div>';
  h += '<ul class="checklist"><li>Is the person real? Message them on WhatsApp if unsure.</li>' + (kind === 'editor' ? '<li>Open the portfolio link: is the work theirs?</li>' : '<li>Is the budget realistic for the work?</li>') + '<li>Does the text look genuine, with no spam or fake claims?</li></ul>';
  h += '<div class="verdict"><div class="field"><label for="rv-note">Note to the member' + (x.approval === 'approved' ? '' : ' (needed if you reject)') + '</label><textarea id="rv-note" maxlength="300" style="min-height:70px" placeholder="e.g. Portfolio link does not open. Please add a working link.">' + esc(x.approval === 'rejected' ? x.note : '') + '</textarea></div><p class="err" id="rv-err" role="alert" hidden></p><div class="btns">' +
    (x.approval !== 'approved' ? '<button type="button" class="btn" data-act="decide" data-kind="' + kind + '" data-id="' + esc(x.id) + '" data-v="approved">Approve: show to everyone</button>' : '') +
    (x.approval !== 'rejected' ? '<button type="button" class="btn danger" data-act="decide" data-kind="' + kind + '" data-id="' + esc(x.id) + '" data-v="rejected">' + (x.approval === 'approved' ? 'Take down' : 'Reject') + '</button>' : '') +
    '</div></div></div>';
  return h;
}
function openReview(kind, id) {
  const x = (kind === 'job' ? S.admin.jobs : S.admin.editors).find(i => i.id === id);
  if (x) showSheet('review', id, reviewSheet(kind, x), null, kind);
}
function waMessage(kind, x, decision, note) {
  const first = ((x.by && x.by.name) || x.name || '').split(' ')[0] || 'there';
  const what = kind === 'job' ? 'job “' + x.title + '”' : 'editor profile';
  if (decision === 'approved') {
    return 'Hi ' + first + ', your ' + what + ' on Cutting Room is approved. ' + (x.by && x.by.paid ? 'It is live now.' : 'Open the app and pay the one-time ' + money(PRICE) + ' fee to make it live.');
  }
  return 'Hi ' + first + ', your ' + what + ' on Cutting Room needs a fix: ' + note + ' Please edit it in the app and send it again.';
}
async function decide(el) {
  const kind = el.dataset.kind, id = el.dataset.id, decision = el.dataset.v;
  const note = ($('#rv-note') || { value: '' }).value.trim();
  const err = $('#rv-err');
  if (decision === 'rejected' && note.length < 3) { err.textContent = 'Write a short reason, so the member knows what to fix.'; err.hidden = false; $('#rv-note').focus(); return; }
  err.hidden = true;
  const x = (kind === 'job' ? S.admin.jobs : S.admin.editors).find(i => i.id === id);
  $$('[data-act="decide"]').forEach(b => { b.disabled = true; });
  try {
    const { error } = await sb.rpc('admin_review', { p_kind: kind, p_id: id, p_decision: decision, p_note: decision === 'approved' ? '' : note });
    if (error) throw error;
    await loadData(true);
    const wa = x && x.by ? waLink(x.by.phone) : '';
    const ok = decision === 'approved';
    sheet = { kind: 'done', id: null, from: null, extra: null };
    $('#sheet-body').innerHTML = '<div class="sheet-head"><span></span>' + closeBtn() + '</div><div class="stack"><div class="banner ' + (ok ? 'ok' : 'bad') + '"><strong>' + (ok ? 'Approved' : 'Rejected') + '</strong><span>' +
      (ok ? (x && x.by && x.by.paid ? 'It is live now. They have been notified in the app.' : 'They have been told in the app to pay and go live.') : 'They can see your note in the app and send it again.') + '</span></div>' +
      (wa ? '<p class="muted">Want to tell them on WhatsApp too? The app only notifies them while it is open on their phone.</p><a class="btn block" href="' + esc(wa + '?text=' + encodeURIComponent(waMessage(kind, x, decision, note))) + '" target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>' : '') +
      '<button type="button" class="btn ghost block" data-act="close">Done</button></div>';
    $('.panel', sheetEl()).scrollTop = 0;
  } catch (e) { $$('[data-act="decide"]').forEach(b => { b.disabled = false; }); failToast(e); }
}

/* ---------- forms ---------- */
function picker(name, options, selected) {
  return '<div class="picker" data-picker="' + name + '">' + options.map(o => '<button type="button" class="chip' + (TYPE[o.id] ? ' t-' + o.id : '') + '" data-act="toggle" data-val="' + esc(o.id) + '" aria-pressed="' + String(selected.includes(o.id)) + '">' + esc(o.label) + '</button>').join('') + '</div>';
}
const picked = (form, name) => $$('[data-picker="' + name + '"] [aria-pressed="true"]', form).map(b => b.dataset.val);
const optionList = (map, sel) => Object.keys(map).map(k => '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(map[k]) + '</option>').join('');
function formErr(f, msg) { const p = $('.err', f); p.textContent = msg; p.hidden = false; }
function busy(f, on, label) { const b = $('button[type="submit"]', f); b.disabled = on; b.textContent = on ? 'Saving…' : label; }

function openJobForm(id) {
  const j = id ? jobById(id) : null;
  const week = new Date(todayDate().getTime() + 7 * MS_DAY);
  const v = j || { title: '', type: 'youtube', brief: '', budget: '', unit: 'video', deadline: isoDay(week), length: '', tools: [] };
  showSheet('form', 'job',
    '<div class="sheet-head"><span></span>' + closeBtn() + '</div><div class="stack"><h2 id="sheet-title">' + (j ? 'Edit job' : 'Post a job') + '</h2>' +
    '<p class="small">' + (j ? 'If you change the title, kind, details, budget or length, the owner checks it again before it shows.' : 'The owner checks every job first. Editors see it only after it is approved and you have paid.') + '</p>' +
    '<form data-form="job" data-id="' + esc(j ? j.id : '') + '" novalidate>' +
    '<div class="field"><label for="j-title">What do you need edited?</label><input id="j-title" name="jtitle" maxlength="100" value="' + esc(v.title) + '" placeholder="e.g. 10-minute YouTube video, talking head"></div>' +
    '<div class="field"><label for="j-type">Kind of video</label><select id="j-type" name="jtype">' + TYPES.map(t => '<option value="' + t.id + '"' + (t.id === v.type ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="j-brief">Details</label><textarea id="j-brief" name="jbrief" maxlength="2000" placeholder="Raw footage length, style, music, references, number of revisions.">' + esc(v.brief) + '</textarea></div>' +
    '<div class="two"><div class="field"><label for="j-budget">Budget in ₹</label><input id="j-budget" name="jbudget" type="number" inputmode="numeric" min="0" step="50" value="' + esc(v.budget) + '" placeholder="3000"></div>' +
    '<div class="field"><label for="j-unit">Paid</label><select id="j-unit" name="junit">' + optionList(BUDGET_UNITS, v.unit) + '</select></div></div>' +
    '<div class="two"><div class="field"><label for="j-deadline">Deadline</label><input id="j-deadline" name="jdeadline" type="date" min="' + isoDay(todayDate()) + '" value="' + esc(v.deadline) + '"></div>' +
    '<div class="field"><label for="j-length">Finished length</label><input id="j-length" name="jlength" maxlength="60" value="' + esc(v.length) + '" placeholder="8-10 min"></div></div>' +
    '<div class="field"><span class="lbl">Software (optional)</span>' + picker('tools', TOOLS.map(t => ({ id: t, label: t })), v.tools) + '</div>' +
    '<p class="err" role="alert" hidden></p><button type="submit" class="btn block">' + (j ? 'Save job' : 'Send for review') + '</button></form></div>');
}
async function saveJob(f) {
  const id = f.dataset.id;
  const title = f.elements.jtitle.value.trim(), brief = f.elements.jbrief.value.trim(), budget = Math.round(Number(f.elements.jbudget.value)), deadline = f.elements.jdeadline.value;
  if (title.length < 3) return formErr(f, 'Add a short title so editors know what this is.');
  if (brief.length < 10) return formErr(f, 'Describe the job in a sentence or two (at least 10 characters).');
  if (!(budget > 0)) return formErr(f, 'Enter your budget in rupees.');
  if (!parseDay(deadline) || (!id && deadline < isoDay(todayDate()))) return formErr(f, 'Pick a deadline that is today or later.');
  const row = { title, brief, budget, deadline, type: pick(f.elements.jtype.value, TYPE_IDS, 'youtube'), unit: pick(f.elements.junit.value, Object.keys(BUDGET_UNITS), 'project'), length: f.elements.jlength.value.trim().slice(0, 60), tools: picked(f, 'tools') };
  busy(f, true, id ? 'Save job' : 'Send for review');
  try {
    if (id) await mutate(sb.from('jobs').update(row).eq('id', id));
    else { const r = await sb.from('jobs').insert(row); if (r.error) throw r.error; }
    closeSheet();
    await afterSave();
    const j = id ? jobById(id) : null;
    toast(!j || j.approval === 'pending' ? 'Sent for review. You will be told here when it is approved.' : 'Job saved');
    if (S.view === 'app' && S.tab !== 'jobs') { S.tab = 'jobs'; drawTab(); }
  } catch (e) { busy(f, false, id ? 'Save job' : 'Send for review'); failToast(e); }
}
async function afterSave() { if (S.view === 'app') await loadData(true); else await refreshGate(); }

function openProfileForm() {
  const e = S.myEditor;
  const v = e || { name: S.profile.name, headline: '', city: '', about: '', skills: [], tools: [], rate: '', unit: 'min', portfolio: '', contact: S.profile.phone || '', available: true };
  showSheet('form', 'profile',
    '<div class="sheet-head"><span></span>' + closeBtn() + '</div><div class="stack"><h2 id="sheet-title">' + (e ? 'Edit your profile' : 'Create your editor profile') + '</h2>' +
    '<p class="small">' + (e ? 'If you change your details the owner checks the profile again. Switching "open for work" does not need a new check.' : 'The owner checks every profile first. Clients see it only after it is approved and you have paid.') + '</p>' +
    '<form data-form="profile" novalidate>' +
    '<div class="field"><label for="p-name">Name</label><input id="p-name" name="pname" maxlength="60" value="' + esc(v.name) + '" autocomplete="name"></div>' +
    '<div class="field"><label for="p-headline">One line about you</label><input id="p-headline" name="pheadline" maxlength="90" value="' + esc(v.headline) + '" placeholder="Fast-turnaround YouTube and Reels editor"></div>' +
    '<div class="two"><div class="field"><label for="p-city">City</label><input id="p-city" name="pcity" maxlength="50" value="' + esc(v.city) + '" placeholder="Indore"></div>' +
    '<div class="field"><label for="p-contact">WhatsApp number or email</label><input id="p-contact" name="pcontact" maxlength="80" value="' + esc(v.contact) + '" placeholder="98765 43210"></div></div>' +
    '<div class="field"><span class="lbl">What you edit</span>' + picker('skills', TYPES, v.skills) + '</div>' +
    '<div class="field"><span class="lbl">Software you use</span>' + picker('tools', TOOLS.map(t => ({ id: t, label: t })), v.tools) + '</div>' +
    '<div class="two"><div class="field"><label for="p-rate">Your price in ₹ (clients see this)</label><input id="p-rate" name="prate" type="number" inputmode="numeric" min="0" step="50" value="' + esc(v.rate) + '" placeholder="1500"></div>' +
    '<div class="field"><label for="p-unit">Charged</label><select id="p-unit" name="punit">' + optionList(RATE_UNITS, v.unit) + '</select></div></div>' +
    '<div class="field"><label for="p-portfolio">Portfolio link (YouTube, Instagram or Drive)</label><input id="p-portfolio" name="pportfolio" type="url" inputmode="url" maxlength="200" value="' + esc(v.portfolio) + '" placeholder="youtube.com/@yourchannel"></div>' +
    '<div class="field"><label for="p-about">About you (optional)</label><textarea id="p-about" name="pabout" maxlength="1200" placeholder="Experience, turnaround time, the kind of work you enjoy.">' + esc(v.about) + '</textarea></div>' +
    '<label class="check"><input type="checkbox" name="pavail"' + (v.available ? ' checked' : '') + '> I am open for new work</label>' +
    '<p class="small">Your contact is shown to clients once your profile is approved.</p>' +
    '<p class="err" role="alert" hidden></p><button type="submit" class="btn block">' + (e ? 'Save profile' : 'Send for review') + '</button>' +
    (e ? '<button type="button" class="btn danger block" data-act="deleteprofile">Delete my profile</button>' : '') + '</form></div>');
}
async function saveProfile(f) {
  const name = f.elements.pname.value.trim(), contact = f.elements.pcontact.value.trim(), skills = picked(f, 'skills');
  let portfolio = f.elements.pportfolio.value.trim();
  if (portfolio && !/^https?:\/\//i.test(portfolio)) portfolio = 'https://' + portfolio;
  if (!name) return formErr(f, 'Add your name.');
  if (!skills.length) return formErr(f, 'Pick at least one kind of video you edit.');
  if (contact.length < 3) return formErr(f, 'Add a WhatsApp number or email so clients can reach you.');
  if (!(Number(f.elements.prate.value) > 0)) return formErr(f, 'Add your price, for example 500 per finished minute. Clients see it.');
  if (!portfolio) return formErr(f, 'Add a link to your best work. The owner opens it to check your profile is real.');
  if (!safeUrl(portfolio)) return formErr(f, 'That portfolio link does not look right.');
  const row = { name, headline: f.elements.pheadline.value.trim(), city: f.elements.pcity.value.trim(), contact, skills, tools: picked(f, 'tools'), rate: Math.max(0, Math.round(Number(f.elements.prate.value) || 0)), rate_unit: pick(f.elements.punit.value, Object.keys(RATE_UNITS), 'video'), portfolio, about: f.elements.pabout.value.trim(), available: f.elements.pavail.checked };
  const existed = !!S.myEditor;
  busy(f, true, existed ? 'Save profile' : 'Send for review');
  try {
    if (existed) await mutate(sb.from('editors').update(row).eq('user_id', S.user.id));
    else { const r = await sb.from('editors').insert(Object.assign({ user_id: S.user.id }, row)); if (r.error) throw r.error; }
    closeSheet();
    await afterSave();
    toast(S.myEditor && S.myEditor.approval === 'pending' ? 'Sent for review. You will be told here when it is approved.' : 'Profile saved');
  } catch (e) { busy(f, false, existed ? 'Save profile' : 'Send for review'); failToast(e); }
}
async function deleteProfile() {
  try {
    const a = await sb.from('applications').delete().eq('editor_id', S.user.id); if (a.error) throw a.error;
    const d = await sb.from('editors').delete().eq('user_id', S.user.id); if (d.error) throw d.error;
    closeSheet(); S.myEditor = null; S.posts = []; await afterSave(); toast('Profile deleted');
  } catch (e) { failToast(e); }
}

function openApplyForm(jobId) {
  const j = jobById(jobId), me = S.myEditor;
  if (!j || !me || me.approval !== 'approved') return;
  showSheet('form', 'apply',
    '<div class="sheet-head"><button type="button" class="link" data-act="back" data-id="' + esc(jobId) + '">← Back to job</button>' + closeBtn() + '</div><div class="stack"><h2 id="sheet-title">Apply to ' + esc(j.title) + '</h2>' +
    '<p class="muted">Budget ' + money(j.budget) + ' ' + esc(BUDGET_UNITS[j.unit]) + ' · ' + esc(fmtDay(j.deadline)) + '</p>' +
    '<form data-form="apply" data-id="' + esc(jobId) + '" novalidate>' +
    '<div class="field"><label for="a-quote">Your quote in ₹</label><input id="a-quote" name="aquote" type="number" inputmode="numeric" min="0" step="50" value="' + (me.rate ? esc(me.rate) : '') + '" placeholder="' + esc(Math.round(j.budget)) + '"></div>' +
    '<div class="field"><label for="a-msg">Message to the client</label><textarea id="a-msg" name="amsg" maxlength="600" placeholder="Why you fit, how fast you can deliver, a similar video you edited."></textarea></div>' +
    '<p class="small">The client sees your profile and contact when you apply. If they like your quote, they will message you.</p>' +
    '<p class="err" role="alert" hidden></p><button type="submit" class="btn block">Send application</button></form></div>');
}
async function saveApply(f) {
  const jobId = f.dataset.id, msg = f.elements.amsg.value.trim(), quote = Math.round(Number(f.elements.aquote.value));
  if (msg.length < 5) return formErr(f, 'Write a short message to the client.');
  if (!(quote > 0)) return formErr(f, 'Enter the amount you would charge in rupees.');
  busy(f, true, 'Send application');
  try {
    const r = await sb.from('applications').insert({ job_id: jobId, message: msg, quote });
    if (r.error) throw r.error;
    await loadData(true); openJob(jobId); toast('Application sent');
  } catch (e) { busy(f, false, 'Send application'); failToast(e); }
}

function openDetailsForm() {
  const p = S.profile;
  showSheet('form', 'details',
    '<div class="sheet-head"><span></span>' + closeBtn() + '</div><div class="stack"><h2 id="sheet-title">Your details</h2><form data-form="details" novalidate>' +
    '<div class="field"><label for="d-name">Name</label><input id="d-name" name="name" maxlength="60" value="' + esc(p.name) + '" autocomplete="name"></div>' +
    '<div class="field"><label for="d-phone">WhatsApp number</label><input id="d-phone" name="phone" type="tel" inputmode="tel" maxlength="20" value="' + esc(p.phone) + '" autocomplete="tel"></div>' +
    '<p class="small">Your email cannot be changed here. Contact support if you need that.</p><p class="err" role="alert" hidden></p><button type="submit" class="btn block">Save</button></form></div>');
}
async function saveDetails(f) {
  const name = f.elements.name.value.trim(), phone = f.elements.phone.value.trim();
  if (!name) return formErr(f, 'Please enter your name.');
  busy(f, true, 'Save');
  try {
    await mutate(sb.from('profiles').update({ full_name: name, phone: phone || null }).eq('id', S.user.id));
    S.profile.name = name.slice(0, 60); S.profile.phone = phone.slice(0, 30);
    closeSheet(); drawTab(); toast('Saved');
  } catch (e) { busy(f, false, 'Save'); failToast(e); }
}

/* ---------- actions on data ---------- */
async function setAppStatus(appId, status) {
  const a = S.apps.find(x => x.id === appId), j = a && jobById(a.jobId);
  if (!a || !j || j.owner !== S.user.id) return;
  try {
    await mutate(sb.from('applications').update({ status }).eq('job_id', a.jobId).eq('editor_id', a.editorId));
    if (status === 'hired') await mutate(sb.from('jobs').update({ status: 'filled', hired: a.editorId }).eq('id', j.id));
    await loadData(true);
    toast(status === 'hired' ? 'Hired. Message them to get started.' : (status === 'shortlisted' ? 'Shortlisted' : 'Declined'));
  } catch (e) { failToast(e); }
}
async function setJobStatus(jobId, status) {
  const j = jobById(jobId);
  if (!j || j.owner !== S.user.id) return;
  try {
    if (status === 'open') {
      for (const a of (appsByJob().get(jobId) || []).filter(x => x.status === 'hired')) await mutate(sb.from('applications').update({ status: 'shortlisted' }).eq('job_id', jobId).eq('editor_id', a.editorId));
      await mutate(sb.from('jobs').update({ status: 'open', hired: null }).eq('id', jobId));
    } else await mutate(sb.from('jobs').update({ status }).eq('id', jobId));
    await loadData(true);
    toast(status === 'open' ? 'Job reopened' : 'Job closed');
  } catch (e) { failToast(e); }
}
async function deleteJob(jobId) {
  const j = jobById(jobId);
  if (!j || j.owner !== S.user.id) return;
  try {
    const r = await sb.from('jobs').delete().eq('id', jobId); if (r.error) throw r.error;
    closeSheet(); await loadData(true); toast('Job deleted');
  } catch (e) { failToast(e); }
}
async function deleteAccount() {
  try {
    const r = await sb.rpc('delete_my_account'); if (r.error) throw r.error;
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* already gone */ }
    S.authMode = 'signup'; goAuth(); toast('Your account was deleted');
  } catch (e) { failToast(e); }
}
function openJob(id) { const j = jobById(id); if (j) showSheet('job', id, jobSheet(j)); }
function openEditor(id, from) { const e = editorById(id); if (e) showSheet('editor', id, editorSheet(e, from), from); }

/* ---------- events ---------- */
const ACT = {
  tab(el) { S.tab = el.dataset.tab; if (!sheetEl().hidden) closeSheet(); drawTab(); window.scrollTo(0, 0); },
  mode(el) { S.authMode = el.dataset.v; render(); },
  role(el) { S.role = el.dataset.v; $$('[data-act="role"]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); },
  showpw(el) { const i = el.parentNode.querySelector('input'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; el.textContent = show ? 'Hide password' : 'Show password'; },
  pay() { doPay(); },
  paycheck() { checkPaid(false); },
  signout() { signOut(); },
  retryboot() { enter(); },
  refresh() { loadData(); },
  gaterefresh() { toast('Checking…'); refreshGate(); },
  inbox() { openInbox(); },
  filter(el) { S.f[S.tab] = el.dataset.v; $$('#chips [data-act="filter"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === S.f[S.tab]))); drawList(); },
  openonly() { S.openOnly = !S.openOnly; $('[data-act="openonly"]').setAttribute('aria-pressed', String(S.openOnly)); drawList(); },
  clear() { S.q[S.tab] = ''; S.f[S.tab] = 'all'; S.openOnly = false; const body = $('#body'); delete body.dataset.shell; drawTab(); },
  openjob(el) { openJob(el.dataset.id); },
  openeditor(el) { openEditor(el.dataset.id, el.dataset.from); },
  back(el) { openJob(el.dataset.id); },
  newjob() { openJobForm(); },
  editjob(el) { openJobForm(el.dataset.id); },
  editprofile() { openProfileForm(); },
  editdetails() { openDetailsForm(); },
  apply(el) { openApplyForm(el.dataset.id); },
  close() { closeSheet(); },
  toggle(el) { el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); },
  copy(el) { copyText(el.dataset.text, el); },
  setstatus(el) { setAppStatus(el.dataset.id, el.dataset.status); },
  closejob(el) { armed(el, () => setJobStatus(el.dataset.id, 'closed')); },
  reopen(el) { setJobStatus(el.dataset.id, 'open'); },
  deletejob(el) { armed(el, () => deleteJob(el.dataset.id)); },
  deleteprofile(el) { armed(el, deleteProfile); },
  deleteaccount(el) { armed(el, deleteAccount); },
  openreview(el) { openReview(el.dataset.kind, el.dataset.id); },
  decide(el) { decide(el); },
  adminfilter(el) { S.admin.filter = el.dataset.v; drawTab(); }
};
const FORM = { signup: doSignup, login: doLogin, forgot: doForgot, job: saveJob, profile: saveProfile, apply: saveApply, details: saveDetails };

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACT[el.dataset.act]) return;
  ACT[el.dataset.act](el);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !sheetEl().hidden) { closeSheet(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"][data-act]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  if (FORM[f.dataset.form]) FORM[f.dataset.form](f);
});
document.addEventListener('input', e => {
  if (e.target.id === 'q' && (S.tab === 'work' || S.tab === 'editors')) { S.q[S.tab] = e.target.value; drawList(); }
});
window.addEventListener('popstate', () => { if (!sheetEl().hidden) closeSheet(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !sb) return;
  if (S.view === 'pay') { checkPaid(true); refreshGate(); }
  else if (S.view === 'gate') refreshGate();
  else if (S.view === 'app' && Date.now() - S.lastLoad > 20000) loadData(true);
});

/* ---------- boot ---------- */
async function boot() {
  if (!CONFIGURED) { S.view = 'config'; render(); return; }
  try {
    sb = window.supabase.createClient(String(CFG.SUPABASE_URL), String(CFG.SUPABASE_ANON_KEY), { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  } catch (e) { S.view = 'config'; render(); return; }
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && S.view !== 'auth') setTimeout(goAuth, 0); });
  render();
  const { data } = await sb.auth.getSession();
  if (data && data.session) await enter(); else goAuth();
}
boot();
})();
