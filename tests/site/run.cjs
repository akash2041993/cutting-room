// Opens the website pages (docs/) in a real browser: text is filled from config.js, links work, the reset-password form behaves.
// Run: node tests/site/run.cjs
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const fs = require('fs'), path = require('path');
const DOCS = path.resolve(__dirname, '../../docs');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const CONFIG = (extra = {}) => 'window.APP_CONFIG = ' + JSON.stringify(Object.assign({
  SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_ANON_KEY: 'eyJtest', PRICE_RUPEES: 500, POLICY_URL: 'https://me.github.io/cr/',
  SUPPORT_EMAIL: 'help@cuttingroom.in', SUPPORT_WHATSAPP: '9876543210', BUSINESS_NAME: 'Frame Works' }, extra)) + ';';

// Stand-in for the Supabase library the reset page loads from the CDN.
const SB_STUB = `
window.__calls = [];
window.supabase = { createClient: function () {
  var cbs = [], hash = location.hash;
  var recovery = /access_token=/.test(hash) && /type=recovery/.test(hash);
  setTimeout(function () { if (recovery) cbs.forEach(function (f) { f('PASSWORD_RECOVERY', { user: { id: 'u1' } }); }); }, 50);
  return { auth: {
    onAuthStateChange: function (f) { cbs.push(f); return { data: { subscription: { unsubscribe: function () {} } } }; },
    getSession: function () { return Promise.resolve({ data: { session: recovery ? { user: { id: 'u1' } } : null } }); },
    updateUser: function (a) { window.__calls.push(['updateUser', a.password]); return Promise.resolve(window.__fail ? { error: { message: 'New password should be different from the old password.' } } : { data: {}, error: null }); },
    signOut: function () { window.__calls.push(['signOut']); return Promise.resolve({}); }
  } };
} };`;

(async () => {
  const browser = await chromium.launch();
  async function open(cfg, url, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: opts.scheme || 'dark' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.hostname === 'cdn.jsdelivr.net') return route.fulfill({ status: 200, contentType: 'application/javascript', body: SB_STUB });
      if (u.hostname === 'me.github.io' || u.hostname === 'localhost') {
        let p = u.pathname.replace(/^\/cr\//, '/');
        if (p === '/' || p === '') p = '/index.html';
        if (p === '/config.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: cfg });
        const f = path.join(DOCS, p);
        if (fs.existsSync(f)) return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'text/plain', body: fs.readFileSync(f) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(url);
    await page.waitForLoadState('load');
    return { page, ctx, errors };
  }
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // Home
  {
    const { page, ctx, errors } = await open(CONFIG(), 'https://me.github.io/cr/index.html');
    ok(/Frame Works/.test(await page.title()), 'home: title uses business name from config');
    ok((await page.locator('#dl').getAttribute('href')) === 'https://github.com/me/cr/releases/latest/download/CuttingRoom.apk', 'home: download link built from the github.io address');
    ok(/500/.test(await page.locator('main').innerText()), 'home: price from config shown');
    ok(await page.getByRole('link', { name: 'help@cuttingroom.in' }).count() === 1, 'home: support email is a link');
    ok((await overflow(page)) <= 0, 'home: no sideways scroll at phone width');
    ok(errors.length === 0, 'home: no console errors ' + errors.join('|'));
    await ctx.close();
  }
  // Home when not on github.io
  {
    const { page, ctx } = await open(CONFIG(), 'http://localhost/index.html');
    ok(!(await page.locator('#dl').getAttribute('href')), 'home: no broken download link off GitHub Pages');
    await ctx.close();
  }
  // Legal pages
  for (const p of ['terms', 'privacy', 'refund']) {
    const { page, ctx, errors } = await open(CONFIG(), `https://me.github.io/cr/${p}.html`);
    const txt = await page.locator('main').innerText();
    ok(/Frame Works/.test(txt), p + ': business name filled in');
    ok(!/PASTE_YOUR|\{name\}/.test(txt + await page.title()), p + ': no placeholders left');
    ok(await page.getByRole('link', { name: 'help@cuttingroom.in' }).count() >= 1, p + ': support email link');
    ok(/\+919876543210/.test(txt), p + ': WhatsApp number shown when configured');
    if (p !== 'privacy') ok(/₹500/.test(txt), p + ': price shown');
    ok((await overflow(page)) <= 0, p + ': no sideways scroll');
    ok(errors.length === 0, p + ': no console errors ' + errors.join('|'));
    await page.getByRole('link', { name: 'Refunds' }).click();
    await page.waitForURL('**/refund.html');
    ok(true, p + ': footer link to refunds works');
    await ctx.close();
  }
  // Legal page with nothing configured
  {
    const { page, ctx } = await open(CONFIG({ SUPPORT_EMAIL: 'you@example.com', SUPPORT_WHATSAPP: '' }), 'https://me.github.io/cr/terms.html');
    ok(!/\+91/.test(await page.locator('main').innerText()), 'terms: no WhatsApp text when empty');
    await ctx.close();
    const o = await open(CONFIG({ SUPPORT_EMAIL: 'PASTE_YOUR_EMAIL' }), 'https://me.github.io/cr/refund.html');
    ok(/support email shown in the app/.test(await o.page.locator('main').innerText()), 'refund: sensible fallback if email not set');
    await o.ctx.close();
  }
  // Light theme readable
  {
    const { page, ctx } = await open(CONFIG(), 'https://me.github.io/cr/terms.html', { scheme: 'light' });
    const [bg, fg] = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
    ok(bg !== fg && bg === 'rgb(239, 242, 246)', 'terms: light theme applies (bg ' + bg + ')');
    await ctx.close();
  }
  // Paid
  {
    const { page, ctx, errors } = await open(CONFIG(), 'https://me.github.io/cr/paid.html');
    ok(/Payment received/.test(await page.locator('h1').innerText()), 'paid: shows thank-you');
    ok(/I have paid, check now/.test(await page.locator('main').innerText()), 'paid: tells people the manual check button');
    ok(errors.length === 0, 'paid: no console errors');
    await ctx.close();
  }
  // Reset: valid link
  {
    const { page, ctx, errors } = await open(CONFIG(), 'https://me.github.io/cr/reset.html#access_token=abc&refresh_token=def&type=recovery');
    await page.locator('#f').waitFor({ state: 'visible', timeout: 4000 });
    ok(true, 'reset: form appears for a recovery link');
    await page.fill('#p1', 'short'); await page.fill('#p2', 'short');
    await page.click('#go');
    ok(/at least 8/.test(await page.locator('#msg').innerText()), 'reset: short password refused');
    await page.fill('#p1', 'longenough1'); await page.fill('#p2', 'different22');
    await page.click('#go');
    ok(/not the same/.test(await page.locator('#msg').innerText()), 'reset: mismatch refused');
    ok((await page.evaluate(() => window.__calls.length)) === 0, 'reset: nothing sent for invalid input');
    await page.evaluate(() => { window.__fail = true; });
    await page.fill('#p2', 'longenough1'); await page.click('#go');
    await page.waitForFunction(() => /different|used before/i.test(document.getElementById('msg').textContent));
    ok(!(await page.locator('#go').isDisabled()), 'reset: can retry after a server error');
    await page.evaluate(() => { window.__fail = false; });
    await page.click('#go');
    await page.locator('#done').waitFor({ state: 'visible', timeout: 3000 });
    const calls = await page.evaluate(() => window.__calls);
    ok(calls.some(c => c[0] === 'updateUser' && c[1] === 'longenough1'), 'reset: new password sent');
    ok(calls.some(c => c[0] === 'signOut'), 'reset: signed out afterwards');
    ok(await page.locator('#f').isHidden(), 'reset: form hidden after success');
    ok((await overflow(page)) <= 0, 'reset: no sideways scroll');
    ok(errors.length === 0, 'reset: no console errors ' + errors.join('|'));
    await ctx.close();
  }
  // Reset: expired / missing link, unconfigured
  {
    const a = await open(CONFIG(), 'https://me.github.io/cr/reset.html#error=access_denied&error_code=otp_expired');
    await a.page.locator('#bad').waitFor({ state: 'visible', timeout: 4000 });
    ok(await a.page.locator('#f').isHidden(), 'reset: expired link shows the "ask again" message, no form');
    await a.ctx.close();
    const b = await open(CONFIG(), 'https://me.github.io/cr/reset.html');
    await b.page.locator('#bad').waitFor({ state: 'visible', timeout: 4000 });
    ok(true, 'reset: opening the page without a link shows the message');
    await b.ctx.close();
    const c = await open(CONFIG({ SUPABASE_URL: 'PASTE_YOUR_SUPABASE_PROJECT_URL' }), 'https://me.github.io/cr/reset.html#access_token=a&type=recovery');
    await c.page.locator('#bad').waitFor({ state: 'visible', timeout: 2000 });
    ok(true, 'reset: unconfigured site fails safe');
    await c.ctx.close();
  }
  await browser.close();
  console.log(fails ? `\n${fails} of ${n} FAILED` : `\nALL ${n} PASSED`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
