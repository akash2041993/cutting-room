/* In-memory stand-in for supabase-js and for the payment function. TEST USE ONLY.
   It mirrors the rules in supabase/schema.sql closely enough to test the screens end to end:
   who can see what, approval, payment, notifications. The real rules are tested on a real
   Postgres in tests/db. The state is kept in localStorage so a page reload keeps the "server". */
(() => {
const KEY = '__mockdb', SESS = '__mocksess';
let DB;
try { DB = JSON.parse(localStorage.getItem(KEY)); } catch (e) { DB = null; }
DB = DB || { users: [], profiles: [], editors: [], jobs: [], applications: [], notifications: [], admins: [], rzp: {}, payments: [], resets: [], seq: 1, confirmEmail: false };
const save = () => localStorage.setItem(KEY, JSON.stringify(DB));
const clone = x => JSON.parse(JSON.stringify(x));
const stamp = () => new Date(Date.UTC(2026, 9, 15, 4, 0, 0) + (DB.seq++) * 1000).toISOString();
const newId = p => p + (DB.seq++);
const profile = id => DB.profiles.find(p => p.id === id);
const paid = id => !!(profile(id) || {}).paid;
const me = () => { const id = localStorage.getItem(SESS); return id ? DB.users.find(u => u.id === id) : null; };
const notify = (user, kind, title, body) => DB.notifications.push({ id: newId('n'), user_id: user, kind, title, body, read: false, created_at: stamp() });
const rls = () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
const denied = () => ({ data: null, error: { code: '42501', message: 'permission denied for table' } });

const applied = (jobId, u) => DB.applications.some(a => a.job_id === jobId && a.editor_id === u);
const ownsJob = (jobId, u) => DB.jobs.some(j => j.id === jobId && j.owner === u);
function visible(t, r, u) {
  const p = profile(u);
  if (t === 'profiles') return r.id === u;
  if (t === 'notifications') return r.user_id === u;
  if (t === 'editors') return r.user_id === u || (p.paid && p.role === 'client' && r.approval === 'approved' && paid(r.user_id));
  if (t === 'jobs') return r.owner === u || (p.paid && r.approval === 'approved' && paid(r.owner) && ((r.status === 'open' && p.role === 'editor') || applied(r.id, u)));
  if (t === 'applications') return p.paid && (r.editor_id === u || ownsJob(r.job_id, u));
  return false;
}
const EDITOR_CONTENT = ['name', 'headline', 'city', 'about', 'skills', 'tools', 'rate', 'rate_unit', 'portfolio', 'contact'];
const JOB_CONTENT = ['title', 'type', 'brief', 'budget', 'unit', 'length'];
const same = (a, b, keys) => keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
const ALLOWED_UPDATE = {
  profiles: ['full_name', 'phone'], notifications: ['read'], applications: ['status'],
  editors: ['name', 'headline', 'city', 'about', 'skills', 'tools', 'rate', 'rate_unit', 'portfolio', 'contact', 'available'],
  jobs: ['title', 'type', 'brief', 'budget', 'unit', 'deadline', 'length', 'tools', 'status', 'hired']
};
const liveJobs = () => DB.jobs.filter(j => j.approval === 'approved' && j.status === 'open' && paid(j.owner));
const liveEditors = () => DB.editors.filter(e => e.approval === 'approved' && paid(e.user_id));

class Q {
  constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.ord = null; this.lim = null; this.one = false; this.pl = null; this.ret = false; }
  select() { this.ret = true; return this; }
  insert(p) { this.op = 'insert'; this.pl = p; return this; }
  update(p) { this.op = 'update'; this.pl = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.f.push([c, v]); return this; }
  order(c, o) { this.ord = [c, !(o && o.ascending === false)]; return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = true; return this; }
  then(a, b) { return new Promise(res => setTimeout(res, 5)).then(() => { const r = this.exec(); save(); return r; }).then(a, b); }
  exec() {
    const u = me();
    if (!u) return { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    const t = this.t, tab = DB[t];
    const match = r => this.f.every(([c, v]) => r[c] === v);
    if (this.op === 'select') {
      let rows = tab.filter(r => visible(t, r, u.id) && match(r));
      if (this.ord) { const [c, asc] = this.ord; rows.sort((x, y) => (x[c] > y[c] ? 1 : x[c] < y[c] ? -1 : 0) * (asc ? 1 : -1)); }
      if (this.lim != null) rows = rows.slice(0, this.lim);
      return { data: this.one ? (rows[0] ? clone(rows[0]) : null) : clone(rows), error: null };
    }
    const p = profile(u.id);
    if (this.op === 'insert') {
      const v = clone(this.pl); let row;
      if (t === 'editors') {
        if (p.role !== 'editor' || v.user_id !== u.id) return rls();
        if (DB.editors.some(e => e.user_id === u.id)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        row = Object.assign({ headline: '', city: '', about: '', skills: [], tools: [], rate: 0, rate_unit: 'video', portfolio: '', available: true }, v, { approval: 'pending', review_note: '', reviewed_at: null, updated_at: stamp() });
        DB.editors.push(row);
        notify(u.id, 'review', 'Your profile is under review', 'The owner is checking your editor profile.');
      } else if (t === 'jobs') {
        if (p.role !== 'client') return rls();
        if (DB.jobs.filter(j => j.owner === u.id && j.approval === 'pending').length >= 5) return { data: null, error: { code: 'P0001', message: 'too many posts waiting for review' } };
        row = Object.assign({ length: '', tools: [], unit: 'project' }, v, { id: newId('job'), owner: u.id, poster_name: p.full_name, status: 'open', hired: null, approval: 'pending', review_note: '', reviewed_at: null, created_at: stamp() });
        DB.jobs.push(row);
        notify(u.id, 'review', 'Your job is under review', 'The owner is checking "' + row.title + '".');
      } else if (t === 'applications') {
        const job = DB.jobs.find(j => j.id === v.job_id);
        const myEd = DB.editors.find(e => e.user_id === u.id);
        if (!p.paid || p.role !== 'editor' || !myEd || myEd.approval !== 'approved' || !job || job.status !== 'open' || job.approval !== 'approved' || !paid(job.owner)) return rls();
        if (applied(v.job_id, u.id)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        row = { job_id: v.job_id, editor_id: u.id, message: v.message, quote: v.quote, status: 'new', created_at: stamp() };
        DB.applications.push(row);
      } else return denied();
      return { data: this.ret ? [clone(row)] : null, error: null };
    }
    const mine = tab.filter(r => visible(t, r, u.id) && match(r));
    if (this.op === 'update') {
      const bad = Object.keys(this.pl).find(k => !ALLOWED_UPDATE[t].includes(k));
      if (bad) return { data: null, error: { code: '42501', message: 'permission denied for column ' + bad } };
      const writable = mine.filter(r => (t === 'editors' ? r.user_id === u.id : t === 'jobs' ? r.owner === u.id : t === 'applications' ? ownsJob(r.job_id, u.id) : t === 'profiles' ? r.id === u.id : r.user_id === u.id));
      writable.forEach(r => {
        const old = clone(r); Object.assign(r, this.pl);
        if (t === 'editors' && !same(old, r, EDITOR_CONTENT)) { r.approval = 'pending'; r.review_note = ''; r.reviewed_at = null; if (old.approval !== 'pending') notify(u.id, 'review', 'Your profile is under review again', 'You changed your editor profile.'); }
        if (t === 'jobs' && !same(old, r, JOB_CONTENT)) { r.approval = 'pending'; r.review_note = ''; r.reviewed_at = null; if (old.approval !== 'pending') notify(u.id, 'review', 'Your job is under review again', 'You changed "' + r.title + '".'); }
      });
      return { data: this.ret ? clone(writable) : null, error: null };
    }
    if (this.op === 'delete') {
      const del = mine.filter(r => (t === 'editors' ? r.user_id === u.id : t === 'jobs' ? r.owner === u.id : t === 'applications' ? (r.editor_id === u.id || ownsJob(r.job_id, u.id)) : false));
      DB[t] = tab.filter(r => !del.includes(r));
      if (t === 'jobs') DB.applications = DB.applications.filter(a => DB.jobs.some(j => j.id === a.job_id));
      return { data: this.ret ? clone(del) : null, error: null };
    }
    return denied();
  }
}

function ownerInfo(uid) { const p = profile(uid), us = DB.users.find(x => x.id === uid); return { owner_name: p.full_name, owner_phone: p.phone, owner_paid: p.paid, owner_joined: p.created_at, owner_email: us.email }; }
function rpc(name, args) {
  const u = me();
  if (!u) return { data: null, error: { code: '42501', message: 'permission denied for function' } };
  const isAdmin = DB.admins.includes(u.id);
  if (name === 'market_counts') return { data: { open_jobs: liveJobs().length, editors: liveEditors().length }, error: null };
  if (name === 'is_admin') return { data: isAdmin, error: null };
  if (name === 'admin_queue') {
    if (!isAdmin) return { data: null, error: { message: 'not allowed' } };
    const st = args.p_status;
    const pend = DB.profiles.length;
    return {
      error: null, data: clone({
        jobs: DB.jobs.filter(j => j.approval === st).map(j => Object.assign({}, j, ownerInfo(j.owner))).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        editors: DB.editors.filter(e => e.approval === st).map(e => Object.assign({}, e, ownerInfo(e.user_id))),
        stats: {
          members: pend, editor_members: DB.profiles.filter(p => p.role === 'editor').length, client_members: DB.profiles.filter(p => p.role === 'client').length,
          paid: DB.profiles.filter(p => p.paid).length, revenue: DB.payments.reduce((s, p) => s + p.amount, 0),
          pending_jobs: DB.jobs.filter(j => j.approval === 'pending').length, pending_editors: DB.editors.filter(e => e.approval === 'pending').length,
          live_jobs: liveJobs().length, live_editors: liveEditors().length,
          awaiting_payment: DB.profiles.filter(p => !p.paid && (DB.jobs.some(j => j.owner === p.id && j.approval === 'approved') || DB.editors.some(e => e.user_id === p.id && e.approval === 'approved'))).length
        }
      })
    };
  }
  if (name === 'admin_review') {
    if (!isAdmin) return { data: null, error: { message: 'not allowed' } };
    const row = args.p_kind === 'job' ? DB.jobs.find(j => j.id === args.p_id) : DB.editors.find(e => e.user_id === args.p_id);
    if (!row) return { data: null, error: { message: 'not found' } };
    row.approval = args.p_decision; row.review_note = args.p_note || ''; row.reviewed_at = stamp();
    const owner = args.p_kind === 'job' ? row.owner : row.user_id, label = args.p_kind === 'job' ? 'Your job "' + row.title + '"' : 'Your editor profile';
    if (args.p_decision === 'approved') paid(owner) ? notify(owner, 'live', 'Your post is live', label + ' is approved and now visible in the app.') : notify(owner, 'approved', 'Approved. Pay once to go live', label + ' is approved. Pay the one-time fee in the app and it goes live straight away.');
    if (args.p_decision === 'rejected') notify(owner, 'rejected', 'Not approved', label + ' was not approved. ' + (args.p_note || '') + ' Edit it and send it again.');
    return { data: null, error: null };
  }
  if (name === 'delete_my_account') {
    ['users', 'profiles', 'notifications'].forEach(k => { DB[k] = DB[k].filter(r => (r.id || r.user_id) !== u.id); });
    DB.editors = DB.editors.filter(e => e.user_id !== u.id); DB.jobs = DB.jobs.filter(j => j.owner !== u.id); DB.applications = DB.applications.filter(a => a.editor_id !== u.id && DB.jobs.some(j => j.id === a.job_id));
    localStorage.removeItem(SESS);
    return { data: null, error: null };
  }
  return { data: null, error: { message: 'unknown function ' + name } };
}

const listeners = [];
const fire = (ev, s) => listeners.forEach(cb => setTimeout(() => cb(ev, s), 0));
const sessionFor = u => ({ access_token: 'tok-' + u.id, user: { id: u.id, email: u.email } });
const auth = {
  async getSession() { const u = me(); return { data: { session: u ? sessionFor(u) : null }, error: null }; },
  async signUp({ email, password, options }) {
    await new Promise(r => setTimeout(r, 5));
    if (DB.users.some(x => x.email === email)) return { data: { user: { identities: [] }, session: null }, error: null };
    const id = newId('user'), d = (options && options.data) || {};
    const user = { id, email, password };
    DB.users.push(user);
    DB.profiles.push({ id, role: d.role === 'editor' ? 'editor' : 'client', full_name: String(d.full_name || '').slice(0, 60) || email.split('@')[0], phone: d.phone || null, paid: false, paid_at: null, created_at: stamp() });
    save();
    if (DB.confirmEmail) return { data: { user: { id, email, identities: [{}] }, session: null }, error: null };
    localStorage.setItem(SESS, id);
    return { data: { user: { id, email, identities: [{}] }, session: sessionFor(user) }, error: null };
  },
  async signInWithPassword({ email, password }) {
    await new Promise(r => setTimeout(r, 5));
    const u = DB.users.find(x => x.email === email && x.password === password);
    if (!u) return { data: null, error: { message: 'Invalid login credentials' } };
    localStorage.setItem(SESS, u.id);
    return { data: { session: sessionFor(u), user: u }, error: null };
  },
  async signOut() { localStorage.removeItem(SESS); fire('SIGNED_OUT', null); return { error: null }; },
  async resetPasswordForEmail(email, opts) { DB.resets.push({ email, opts }); save(); return { data: {}, error: null }; },
  onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; }
};
window.supabase = { createClient: () => ({ auth, from: t => new Q(t), rpc: async (n, a) => { await new Promise(r => setTimeout(r, 5)); const r = rpc(n, a || {}); save(); return r; } }) };

/* the payment function */
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).includes('/functions/v1/payments')) return realFetch(url, init);
  await new Promise(r => setTimeout(r, 5));
  const tok = ((init.headers || {}).Authorization || '').replace('Bearer tok-', '');
  const u = DB.users.find(x => x.id === tok), body = JSON.parse(init.body || '{}');
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (!u) return reply({ error: 'not_signed_in' }, 401);
  const p = profile(u.id);
  if (p.paid) return reply({ paid: true });
  if (body.action === 'check') {
    if (DB.rzp[u.id]) { p.paid = true; p.paid_at = stamp(); DB.payments.push({ id: 'pay_' + u.id, amount: 50000 }); notify(u.id, 'paid', 'Payment received. You are in', 'Thank you.'); save(); return reply({ paid: true }); }
    return reply({ paid: false });
  }
  if (body.action === 'create') {
    const approved = DB.editors.some(e => e.user_id === u.id && e.approval === 'approved') || DB.jobs.some(j => j.owner === u.id && j.approval === 'approved');
    if (!approved) return reply({ error: 'not_approved_yet' }, 403);
    return reply({ url: 'https://rzp.io/i/test-' + u.id });
  }
  return reply({ error: 'unknown_action' }, 400);
};

/* handles for the test script */
window.__mock = {
  db: () => DB,
  pay: email => { DB.rzp[DB.users.find(u => u.email === email).id] = true; save(); },
  makeOwner: (email, password) => { const id = newId('user'); DB.users.push({ id, email, password }); DB.profiles.push({ id, role: 'client', full_name: 'The Owner', phone: '98000 00000', paid: false, paid_at: null, created_at: stamp() }); DB.admins.push(id); save(); },
  confirmEmail: on => { DB.confirmEmail = on; save(); },
  wipe: () => { localStorage.clear(); }
};
})();
