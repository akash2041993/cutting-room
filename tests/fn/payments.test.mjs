// Tests the payment function's logic with a stand-in Razorpay and database.
// Run: node tests/fn/payments.test.mjs   (Node 22+ reads the TypeScript file directly)
import { createHmac } from 'node:crypto';
import { handle } from '../../supabase/functions/payments/index.ts';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const ENV = { RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsec', RETURN_URL: 'https://x.github.io/r/paid.html' };

function world(extraEnv = {}) {
  const w = {
    links: new Map(),            // razorpay side
    users: new Map([['jwt-alice', { id: 'u-alice', email: 'alice@x.in' }], ['jwt-bob', { id: 'u-bob', email: 'bob@x.in' }]]),
    profiles: new Map([['u-alice', { id: 'u-alice', role: 'editor', full_name: 'Alice', paid: false }], ['u-bob', { id: 'u-bob', role: 'client', full_name: 'Bob', paid: false }]]),
    approved: new Set(['u-alice', 'u-bob']),   // people with a post the owner has approved
    saved: [],                   // payment_links table
    payments: [],
    rzpCalls: [], n: 0,
    env: { ...ENV, ...extraEnv },
  };
  w.deps = {
    env: w.env,
    fetch: async (url, init) => {
      const u = new URL(url); w.rzpCalls.push(init.method + ' ' + u.pathname);
      const auth = init.headers.Authorization;
      if (auth !== 'Basic ' + Buffer.from('rzp_test_abc:secret').toString('base64')) return new Response('{"error":{"description":"Authentication failed"}}', { status: 401 });
      if (init.method === 'POST' && u.pathname === '/v1/payment_links') {
        const b = JSON.parse(init.body); const id = 'plink_' + (++w.n);
        const link = { id, short_url: 'https://rzp.io/i/' + id, status: 'created', amount: b.amount, amount_paid: 0, notes: b.notes, customer: b.customer, payments: null, _req: b };
        w.links.set(id, link); return new Response(JSON.stringify(link), { status: 200 });
      }
      const m = u.pathname.match(/^\/v1\/payment_links\/(.+)$/);
      if (init.method === 'GET' && m && w.links.has(m[1])) return new Response(JSON.stringify(w.links.get(m[1])), { status: 200 });
      return new Response('{"error":{"description":"not found"}}', { status: 404 });
    },
    getUser: async (jwt) => w.users.get(jwt) || null,
    getProfile: async (id) => w.profiles.get(id) || null,
    listLinks: async (uid) => w.saved.filter((l) => l.userId === uid).map((l) => l.id).reverse(),
    latestLink: async (uid) => { const l = w.saved.filter((x) => x.userId === uid).pop(); return l ? { id: l.id, short_url: l.shortUrl, created_at: l.at } : null; },
    hasApprovedPost: async (uid) => w.approved.has(uid),
    findLinkOwner: async (id) => (w.saved.find((l) => l.id === id) || {}).userId || null,
    saveLink: async (l) => { w.saved.push({ ...l, at: new Date().toISOString() }); },
    markPaid: async (p) => { if (!w.payments.find((x) => x.paymentId === p.paymentId)) w.payments.push(p); w.profiles.get(p.userId).paid = true; },
  };
  return w;
}
const call = (w, body, jwt, headers = {}) => handle(new Request('https://f/payments', { method: 'POST', headers: { ...(jwt ? { authorization: 'Bearer ' + jwt } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), w.deps);
const pay = (w, linkId, amountPaid, status = 'paid') => { const l = w.links.get(linkId); l.status = status; l.amount_paid = amountPaid; l.payments = [{ payment_id: 'pay_' + linkId, amount: amountPaid, status: 'captured' }]; };
const sign = (raw, secret = 'whsec') => createHmac('sha256', secret).update(raw).digest('hex');
const webhook = (w, linkId, secret = 'whsec', mutate = (s) => s) => { const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: linkId } } } }); return call(w, mutate(raw), null, { 'x-razorpay-signature': sign(raw, secret) }); };

// --- create ---
let w = world();
let r = await call(w, { action: 'create' });
ok(r.status === 401, 'create without login is refused');
r = await call(w, { action: 'create' }, 'bad-jwt');
ok(r.status === 401, 'create with an unknown login is refused');
// paying only comes after the owner approved a post
{
  const wn = world(); wn.approved.clear();
  const r0 = await call(wn, { action: 'create' }, 'jwt-alice');
  ok(r0.status === 403 && (await r0.json()).error === 'not_approved_yet' && wn.links.size === 0, 'no payment link before the owner approves a post');
  wn.approved.add('u-alice');
  const r1 = await call(wn, { action: 'create' }, 'jwt-alice');
  ok(r1.status === 200 && wn.links.size === 1, 'payment link is created once a post is approved');
}
r = await call(w, { action: 'create' }, 'jwt-alice');
let j = await r.json();
ok(r.status === 200 && j.url === 'https://rzp.io/i/plink_1', 'create returns the Razorpay link');
const req1 = w.links.get('plink_1')._req;
ok(req1.amount === 50000 && req1.currency === 'INR', 'link is for 50000 paise (500 rupees)');
ok(req1.notes.user_id === 'u-alice' && req1.callback_url === ENV.RETURN_URL && req1.callback_method === 'get', 'link carries the user id and return page');
ok(req1.reference_id.length <= 40, 'reference id fits Razorpay limit');
ok(w.saved.length === 1 && w.saved[0].userId === 'u-alice', 'link is saved against the user');
r = await call(w, { action: 'create' }, 'jwt-alice');
j = await r.json();
ok(j.url === 'https://rzp.io/i/plink_1' && w.links.size === 1, 'tapping Pay again re-uses the recent link');
r = await call(world({ PRICE_RUPEES: '799' }), { action: 'create' }, 'jwt-alice');
ok(r.status === 200, 'price can be changed with a secret');
const wp = world({ PRICE_RUPEES: '799' }); await call(wp, { action: 'create' }, 'jwt-alice');
ok(wp.links.get('plink_1')._req.amount === 79900, 'custom price is used');
r = await call(world({ RAZORPAY_KEY_SECRET: 'wrong' }), { action: 'create' }, 'jwt-alice');
j = await r.json();
ok(r.status === 502 && j.error === 'razorpay_create_failed' && j.detail === 'Authentication failed', 'wrong Razorpay keys give a clear error');
r = await call(world({ RAZORPAY_KEY_ID: '' }), { action: 'create' }, 'jwt-alice');
ok(r.status === 500 && (await r.json()).error === 'payments_not_configured', 'missing keys are reported');
r = await call(w, { action: 'nope' }, 'jwt-alice');
ok(r.status === 400, 'unknown action is refused');

// --- check (pull) ---
r = await call(w, { action: 'check' }, 'jwt-alice');
ok((await r.json()).paid === false && w.profiles.get('u-alice').paid === false, 'check before paying says not paid');
pay(w, 'plink_1', 30000);
r = await call(w, { action: 'check' }, 'jwt-alice');
ok((await r.json()).paid === false && !w.profiles.get('u-alice').paid, 'part payment does not unlock');
pay(w, 'plink_1', 50000);
r = await call(w, { action: 'check' }, 'jwt-alice');
ok((await r.json()).paid === true && w.profiles.get('u-alice').paid === true, 'check after paying unlocks the account');
ok(w.payments.length === 1 && w.payments[0].paymentId === 'pay_plink_1' && w.payments[0].amount === 50000, 'payment is recorded');
r = await call(w, { action: 'check' }, 'jwt-alice');
ok((await r.json()).paid === true && w.payments.length === 1, 'asking again is harmless');
// someone elses link cannot unlock you
w = world(); await call(w, { action: 'create' }, 'jwt-alice'); pay(w, 'plink_1', 50000);
r = await call(w, { action: 'check' }, 'jwt-bob');
ok((await r.json()).paid === false && !w.profiles.get('u-bob').paid, "a stranger's paid link does not unlock another account");

// --- webhook (push) ---
w = world(); await call(w, { action: 'create' }, 'jwt-bob'); pay(w, 'plink_1', 50000);
r = await webhook(w, 'plink_1', 'wrong-secret');
ok(r.status === 400 && !w.profiles.get('u-bob').paid, 'webhook with a wrong signature is rejected');
r = await webhook(w, 'plink_1', 'whsec', (s) => s + ' ');
ok(r.status === 400, 'tampered webhook body is rejected');
r = await webhook(w, 'plink_1');
ok(r.status === 200 && w.profiles.get('u-bob').paid === true, 'valid webhook unlocks the account');
r = await webhook(w, 'plink_1');
ok(r.status === 200 && w.payments.length === 1, 'webhook delivered twice is harmless');
w = world(); await call(w, { action: 'create' }, 'jwt-bob');
r = await webhook(w, 'plink_1');
ok(r.status === 200 && !w.profiles.get('u-bob').paid, 'webhook for a link that is not paid does nothing');
w = world();
r = await webhook(w, 'plink_unknown');
ok(r.status === 200 && (await r.json()).ignored === true, 'webhook for a link we never made is ignored');
{
  const raw = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_9' } } } });
  r = await call(w, raw, null, { 'x-razorpay-signature': sign(raw) });
  ok(r.status === 200 && (await r.json()).ignored === true, 'unrelated signed webhook is acknowledged and ignored');
}
{
  // Razorpay lookup failing must not be acknowledged, so Razorpay retries later.
  const w2 = world(); await call(w2, { action: 'create' }, 'jwt-bob'); pay(w2, 'plink_1', 50000);
  w2.deps.fetch = async () => new Response('{}', { status: 500 });
  r = await webhook(w2, 'plink_1');
  ok(r.status === 502 && !w2.profiles.get('u-bob').paid, 'webhook is not acknowledged when Razorpay lookup fails');
}
{
  const w3 = world({ RAZORPAY_WEBHOOK_SECRET: '' });
  r = await webhook(w3, 'plink_1');
  ok(r.status === 500, 'webhook without a configured secret is refused');
}
r = await handle(new Request('https://f/payments', { method: 'OPTIONS' }), world().deps);
ok(r.status === 200 && r.headers.get('access-control-allow-origin') === '*', 'CORS preflight from the app works');
r = await handle(new Request('https://f/payments', { method: 'GET' }), world().deps);
ok(r.status === 405, 'GET is refused');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
