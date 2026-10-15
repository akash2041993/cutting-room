// Supabase Edge Function: payments
//
// One function, three jobs:
//   1. The app calls it with {"action":"create"} -> it creates a one-time Razorpay
//      Payment Link for the signed-in person and returns {"url": "..."}.
//      Only allowed once the owner has approved a post (profile or job) of theirs.
//   2. The app calls it with {"action":"check"} -> it asks Razorpay whether that
//      person's link is paid and, if so, unlocks the account.
//   3. Razorpay calls it (webhook, signed with x-razorpay-signature) when a link is
//      paid -> it verifies the signature, asks Razorpay again to be sure, then
//      unlocks the account.
//
// Nobody can unlock an account from the app itself. Only this function can, and
// only after Razorpay confirms the money was received.
//
// Secrets to add in Supabase (Edge Functions -> Secrets):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
//   RETURN_URL   (optional) page Razorpay shows after payment, e.g. https://you.github.io/repo/paid.html
//   PRICE_RUPEES (optional) defaults to 500
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// Turn OFF "Verify JWT" for this function: Razorpay's webhook does not send one.
// The function checks the person's login itself for create/check.

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export interface Deps {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: any) => Promise<Response>;
  getUser: (jwt: string) => Promise<{ id: string; email?: string } | null>;
  getProfile: (id: string) => Promise<{ id: string; role: string; full_name: string; paid: boolean } | null>;
  listLinks: (userId: string) => Promise<string[]>;
  latestLink: (userId: string) => Promise<{ id: string; short_url: string; created_at: string } | null>;
  findLinkOwner: (linkId: string) => Promise<string | null>;
  saveLink: (l: { id: string; userId: string; shortUrl: string }) => Promise<void>;
  hasApprovedPost: (userId: string) => Promise<boolean>;
  markPaid: (p: { userId: string; paymentId: string; linkId: string; amount: number; email: string | null }) => Promise<void>;
}

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const priceInPaise = (env: Deps['env']): number => Math.round((Number(env.PRICE_RUPEES) || 500) * 100);

async function razorpay(deps: Deps, method: string, path: string, body?: unknown) {
  const auth = 'Basic ' + btoa(`${deps.env.RAZORPAY_KEY_ID}:${deps.env.RAZORPAY_KEY_SECRET}`);
  const res = await deps.fetch('https://api.razorpay.com/v1' + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  return { ok: res.ok, status: res.status, data };
}

// Asks Razorpay if this link is paid (never trusts a request on its own word).
async function settleLink(deps: Deps, linkId: string, userId: string): Promise<{ paid: boolean; error?: string }> {
  const r = await razorpay(deps, 'GET', '/payment_links/' + encodeURIComponent(linkId));
  if (!r.ok || !r.data) return { paid: false, error: 'razorpay_lookup_failed' };
  const link = r.data;
  if (link.status !== 'paid' || Number(link.amount_paid) < priceInPaise(deps.env)) return { paid: false };
  const pays: any[] = Array.isArray(link.payments) ? link.payments : [];
  const pay = pays.find((p) => p && p.status === 'captured') || pays[0];
  await deps.markPaid({
    userId,
    paymentId: (pay && pay.payment_id) || 'link_' + link.id,
    linkId: String(link.id),
    amount: Number(link.amount_paid),
    email: link.customer && link.customer.email ? String(link.customer.email) : null,
  });
  return { paid: true };
}

async function handleWebhook(deps: Deps, raw: string, signature: string): Promise<Response> {
  const secret = deps.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'webhook_secret_missing' }, 500);
  if (!safeEqual(await hmacHex(secret, raw), signature.trim())) return json({ error: 'bad_signature' }, 400);
  let body: any = null;
  try { body = JSON.parse(raw); } catch (_) { return json({ ok: true, ignored: true }); }
  const linkId: string | undefined =
    body?.payload?.payment_link?.entity?.id || (raw.match(/plink_[A-Za-z0-9]+/) || [])[0];
  if (!linkId) return json({ ok: true, ignored: true });
  const owner = await deps.findLinkOwner(linkId);
  if (!owner) return json({ ok: true, ignored: true });
  const r = await settleLink(deps, linkId, owner);
  if (r.error) return json({ error: r.error }, 502); // Razorpay will try again later
  return json({ ok: true, paid: r.paid });
}

async function handleApp(deps: Deps, req: Request, raw: string): Promise<Response> {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = jwt ? await deps.getUser(jwt) : null;
  if (!user) return json({ error: 'not_signed_in' }, 401);
  let body: any = {};
  try { body = JSON.parse(raw || '{}'); } catch (_) { /* ignore */ }

  const profile = await deps.getProfile(user.id);
  if (!profile) return json({ error: 'no_profile' }, 400);
  if (profile.paid) return json({ paid: true });
  if (!deps.env.RAZORPAY_KEY_ID || !deps.env.RAZORPAY_KEY_SECRET) return json({ error: 'payments_not_configured' }, 500);

  if (body.action === 'check') {
    let lookupFailed = false;
    for (const id of await deps.listLinks(user.id)) {
      const r = await settleLink(deps, id, user.id);
      if (r.paid) return json({ paid: true });
      if (r.error) lookupFailed = true;
    }
    return json({ paid: false, ...(lookupFailed ? { warning: 'razorpay_lookup_failed' } : {}) });
  }

  if (body.action === 'create') {
    // Paying comes after the owner's approval, never before.
    if (!(await deps.hasApprovedPost(user.id))) return json({ error: 'not_approved_yet' }, 403);
    // Re-use a link made in the last 20 minutes so repeated taps do not pile up links.
    const last = await deps.latestLink(user.id);
    if (last && last.short_url && Date.now() - new Date(last.created_at).getTime() < 20 * 60 * 1000) {
      return json({ url: last.short_url });
    }
    const payload: Record<string, unknown> = {
      amount: priceInPaise(deps.env),
      currency: 'INR',
      accept_partial: false,
      reference_id: (user.id.replace(/-/g, '').slice(0, 20) + '-' + Date.now().toString(36)).slice(0, 40),
      description: `Cutting Room one-time fee to publish your post (${profile.role})`,
      customer: { name: profile.full_name, ...(user.email ? { email: user.email } : {}) },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { user_id: user.id, role: profile.role },
      expire_by: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    };
    if (deps.env.RETURN_URL) {
      payload.callback_url = deps.env.RETURN_URL;
      payload.callback_method = 'get';
    }
    const r = await razorpay(deps, 'POST', '/payment_links', payload);
    if (!r.ok || !r.data || !r.data.short_url) {
      return json({ error: 'razorpay_create_failed', detail: (r.data && r.data.error && r.data.error.description) || null }, 502);
    }
    await deps.saveLink({ id: String(r.data.id), userId: user.id, shortUrl: String(r.data.short_url) });
    return json({ url: r.data.short_url });
  }

  return json({ error: 'unknown_action' }, 400);
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const raw = await req.text();
  const signature = req.headers.get('x-razorpay-signature');
  return signature ? handleWebhook(deps, raw, signature) : handleApp(deps, req, raw);
}

// ---- Supabase wiring (only runs inside Supabase's Deno runtime) ----
declare const Deno: any;
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const env = Deno.env.toObject();
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps: Deps = {
    env,
    fetch: (url, init) => fetch(url, init),
    async getUser(jwt) {
      const { data, error } = await admin.auth.getUser(jwt);
      return error || !data?.user ? null : { id: data.user.id, email: data.user.email };
    },
    async getProfile(id) {
      const { data } = await admin.from('profiles').select('id, role, full_name, paid').eq('id', id).maybeSingle();
      return data;
    },
    async listLinks(userId) {
      const { data } = await admin.from('payment_links').select('id').eq('user_id', userId)
        .order('created_at', { ascending: false }).limit(10);
      return (data || []).map((r: any) => r.id);
    },
    async latestLink(userId) {
      const { data } = await admin.from('payment_links').select('id, short_url, created_at').eq('user_id', userId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      return data;
    },
    async findLinkOwner(linkId) {
      const { data } = await admin.from('payment_links').select('user_id').eq('id', linkId).maybeSingle();
      return data?.user_id ?? null;
    },
    async saveLink({ id, userId, shortUrl }) {
      const { error } = await admin.from('payment_links').insert({ id, user_id: userId, short_url: shortUrl });
      if (error) throw error;
    },
    async hasApprovedPost(userId) {
      const e = await admin.from('editors').select('user_id').eq('user_id', userId).eq('approval', 'approved').limit(1);
      if (e.error) throw e.error;
      if ((e.data || []).length) return true;
      const j = await admin.from('jobs').select('id').eq('owner', userId).eq('approval', 'approved').limit(1);
      if (j.error) throw j.error;
      return (j.data || []).length > 0;
    },
    async markPaid({ userId, paymentId, linkId, amount, email }) {
      const a = await admin.from('payments').upsert(
        { payment_id: paymentId, user_id: userId, link_id: linkId, amount, email },
        { onConflict: 'payment_id' },
      );
      if (a.error) throw a.error;
      const b = await admin.from('profiles').update({ paid: true, paid_at: new Date().toISOString() })
        .eq('id', userId).eq('paid', false);
      if (b.error) throw b.error;
    },
  };
  Deno.serve(async (req: Request) => {
    try {
      return await handle(req, deps);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500);
    }
  });
}
