// End-to-end test of the app screens in a real browser, with a stand-in for Supabase (see mock-supabase.js).
// Run: node tests/app/run.cjs [screenshot-folder]
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'cr-shots');
const SITE = path.join(require('os').tmpdir(), 'cr-site');
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'vendor'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of ['index.html', 'style.css', 'app.js']) fs.copyFileSync(path.join(ROOT, 'www', f), path.join(SITE, f));
fs.copyFileSync(path.join(__dirname, 'mock-supabase.js'), path.join(SITE, 'vendor/supabase.js'));
const CONFIG = `window.APP_CONFIG = { SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.test.test-key-long-enough', PRICE_RUPEES: 500,
  POLICY_URL: 'https://me.github.io/cutting-room/', SUPPORT_EMAIL: 'help@cuttingroom.in', SUPPORT_WHATSAPP: '9876543210', BUSINESS_NAME: 'Cutting Room' };`;
fs.writeFileSync(path.join(SITE, 'config.js'), CONFIG);

const server = http.createServer((req, res) => {
  const p = path.join(SITE, req.url.split('?')[0].replace(/^\/$/, '/index.html'));
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(p)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(p));
});

let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

(async () => {
  await new Promise(r => server.listen(5199, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.addInitScript(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; });
  const URL = 'http://localhost:5199/';

  const text = async () => (await page.locator('body').innerText());
  const has = async s => (await text()).includes(s);
  const hasi = async s => (await text()).toLowerCase().includes(s.toLowerCase());   // pills are shown in capitals
  const wait = (ms = 80) => page.waitForTimeout(ms);
  const settle = async (s, t = 4000) => { await page.waitForFunction(x => document.body.innerText.includes(x), s, { timeout: t }).catch(() => {}); };
  const shot = async name => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
  const noOverflow = async label => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bad: Array.from(document.querySelectorAll('body *')).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1 && !e.closest('.chips') && !e.closest('.nav'); }).length }));
    ok(o.sw <= o.iw && o.bad === 0, `no sideways overflow: ${label}` + (o.sw > o.iw || o.bad ? ` (scrollWidth ${o.sw}, ${o.bad} wide elements)` : ''));
  };
  const db = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__mock.db())));
  const reload = async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await wait(250); };
  const signOut = async () => {
    for (const t of ['me', 'owner']) if (await page.locator(`[data-act="tab"][data-tab="${t}"]`).isVisible()) { await page.click(`[data-act="tab"][data-tab="${t}"]`); await wait(); }
    await page.click('[data-act="signout"]'); await settle('Log in'); await wait();
  };
  const login = async (email, pw = 'secret-pass-1') => {
    await page.click('[data-act="mode"][data-v="login"]').catch(() => {});
    await page.fill('#l-email', email); await page.fill('#l-pass', pw);
    await page.click('form[data-form="login"] button[type="submit"]'); await wait(400);
  };
  const signup = async (role, name, phone, email) => {
    await page.click('[data-act="mode"][data-v="signup"]').catch(() => {});
    await page.click(`[data-act="role"][data-v="${role}"]`);
    await page.fill('#s-name', name); await page.fill('#s-phone', phone); await page.fill('#s-email', email); await page.fill('#s-pass', 'secret-pass-1');
    await page.check('input[name="terms"]');
    await page.click('form[data-form="signup"] button[type="submit"]'); await wait(450);
  };

  // ---------- not configured ----------
  {
    const bare = await ctx.newPage();
    await bare.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.APP_CONFIG = { SUPABASE_URL: "PASTE_YOUR_SUPABASE_PROJECT_URL", SUPABASE_ANON_KEY: "PASTE_YOUR_SUPABASE_ANON_PUBLIC_KEY" };' }));
    await bare.route(/fonts\./, r => r.abort());
    await bare.goto(URL, { waitUntil: 'domcontentloaded' }); await bare.waitForTimeout(200);
    ok((await bare.innerText('body')).includes('Setup not finished'), 'an app without Supabase details says setup is not finished instead of crashing');
    await bare.close();
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded' }); await wait(300);
  await page.evaluate(() => window.__mock.makeOwner('owner@cr.in', 'owner-pass-1'));
  await reload();
  ok(await has('Create account') && await has('Log in'), 'first screen offers create account and log in');
  ok(!(await has('Pay ₹500')) || (await has('only after it is approved')), 'sign-up says you pay only after approval');
  await shot('01-signup'); await noOverflow('sign-up');

  // ---------- sign-up checks ----------
  await page.click('form[data-form="signup"] button[type="submit"]'); await wait();
  ok(await has('Please enter your name'), 'empty sign-up asks for the name');
  await page.fill('#s-name', 'Ravi Editor'); await page.fill('#s-phone', '12345'); await page.click('form[data-form="signup"] button[type="submit"]'); await wait();
  ok(await has('10-digit WhatsApp'), 'short phone number is refused');
  await page.fill('#s-phone', '98765 43210'); await page.fill('#s-email', 'ravi@x.in'); await page.fill('#s-pass', 'short'); await page.click('form[data-form="signup"] button[type="submit"]'); await wait();
  ok(await has('at least 8 characters'), 'short password is refused');
  await page.fill('#s-pass', 'secret-pass-1'); await page.click('form[data-form="signup"] button[type="submit"]'); await wait();
  ok(await has('accept the terms'), 'terms must be ticked');
  await page.click('[data-act="showpw"]'); ok(await page.getAttribute('#s-pass', 'type') === 'text', 'show password works');

  // ---------- editor signs up, goes to the "create your profile" step ----------
  await signup('editor', 'Ravi Editor', '98765 43210', 'ravi@x.in');
  ok(await has('Welcome, Ravi') && await has('Create my profile'), 'new editor lands on "create your profile", not on a payment screen');
  ok(!(await has('Pay ₹500 and go live')), 'no payment is asked at this point');
  let d = await db();
  ok(d.profiles.find(p => p.full_name === 'Ravi Editor').role === 'editor' && !d.profiles.find(p => p.full_name === 'Ravi Editor').paid, 'account is created as an unpaid editor');
  await shot('02-create-step'); await noOverflow('create step');

  // profile form validation
  await page.click('[data-act="editprofile"]'); await wait();
  await page.click('#sheet button[type="submit"]'); await wait();
  ok(await has('Pick at least one kind of video'), 'profile needs at least one kind of video');
  await page.click('[data-picker="skills"] [data-val="youtube"]'); await page.click('[data-picker="skills"] [data-val="shorts"]');
  await page.click('#sheet button[type="submit"]'); await wait();
  ok(await has('Add your price'), 'profile needs a price');
  ok((await page.inputValue('#p-unit')) === 'min', 'price defaults to "per finished minute"');
  await page.fill('#p-rate', '600');
  await page.click('#sheet button[type="submit"]'); await wait();
  ok(await has('link to your best work'), 'profile needs a portfolio link');
  await page.fill('#p-headline', 'Fast YouTube and Reels editor'); await page.fill('#p-city', 'Indore'); await page.fill('#p-portfolio', 'youtube.com/@raviedits'); await page.fill('#p-about', 'Five years of cutting talking-head videos.');
  await shot('03-profile-form'); await noOverflow('profile form');
  await page.click('#sheet button[type="submit"]'); await wait(500);
  ok(await has('Under review') && await has('Waiting for the owner'), 'after sending, the editor sees "under review"');
  ok(await has('Your profile is under review'), 'the editor is notified that the profile is under review');
  d = await db();
  ok(d.editors.length === 1 && d.editors[0].approval === 'pending' && d.editors[0].portfolio === 'https://youtube.com/@raviedits' && d.editors[0].rate === 600 && d.editors[0].rate_unit === 'min', 'profile saved as pending with price per minute and portfolio');
  await shot('04-under-review'); await noOverflow('under review');
  await signOut();

  // ---------- client signs up and posts a job ----------
  await signup('client', 'Meera Films', '99887 76655', 'meera@x.in');
  ok(await has('Post my job'), 'new client lands on "post your first job"');
  await page.click('[data-act="newjob"]'); await wait();
  await page.fill('#j-title', 'Wedding highlight reel'); await page.fill('#j-brief', 'Three-minute highlight from 4 hours of footage.'); await page.fill('#j-budget', '4000');
  await page.selectOption('#j-type', 'wedding'); await page.fill('#j-length', '3 min');
  await shot('05-job-form'); await noOverflow('job form');
  await page.click('#sheet button[type="submit"]'); await wait(500);
  ok(await has('Under review') && await has('Wedding highlight reel'), 'client sees the job under review');
  ok(await has('Your job is under review'), 'the client is notified that the job is under review');
  await signOut();

  // ---------- the owner ----------
  await login('owner@cr.in', 'owner-pass-1'); await settle('Review');
  ok(await has('Nothing goes live until you approve it'), 'owner lands on the Review desk');
  ok((await page.locator('.nav .badge').innerText()) === '2', 'owner sees 2 waiting (badge on Review)');
  ok(await has('Wedding highlight reel') && await has('Ravi Editor'), 'both submissions are in the queue');
  await shot('06-owner-review'); await noOverflow('owner review');
  await page.click('.card:has-text("Ravi Editor")'); await wait();
  ok(await has('ravi@x.in') && await has('98765 43210') && await has('youtube.com/@raviedits') && await has('600'), 'owner sees who sent it, contact, portfolio and price');
  ok(await page.locator('#sheet a:has-text("WhatsApp")').count() === 1, 'owner can message the sender on WhatsApp');
  await shot('07-owner-sheet'); await noOverflow('owner sheet');
  await page.click('[data-act="decide"][data-v="rejected"]'); await wait();
  ok(await has('Write a short reason'), 'rejecting without a reason is refused');
  await page.fill('#rv-note', 'Portfolio link shows someone else’s channel.');
  await page.click('[data-act="decide"][data-v="rejected"]'); await wait(450);
  ok(await has('Rejected') && await has('They can see your note'), 'owner sees the rejection confirmed');
  const waHref = await page.locator('#sheet a:has-text("Message on WhatsApp")').getAttribute('href');
  ok(waHref.startsWith('https://wa.me/919876543210?text=') && decodeURIComponent(waHref).includes('needs a fix') , 'rejection comes with a ready WhatsApp message to the editor');
  await page.click('#sheet [data-act="close"]:has-text("Done")'); await wait();
  await page.click('.card:has-text("Wedding highlight reel")'); await wait();
  await page.click('[data-act="decide"][data-v="approved"]'); await wait(450);
  ok(await has('Approved') && await has('told in the app to pay'), 'owner approves the job and sees it confirmed');
  const waHref2 = decodeURIComponent(await page.locator('#sheet a:has-text("Message on WhatsApp")').getAttribute('href'));
  ok(waHref2.includes('919988776655') && waHref2.includes('pay the one-time'), 'approval comes with a ready WhatsApp message to the client');
  await page.click('#sheet [data-act="close"]:has-text("Done")'); await wait();
  d = await db();
  ok(d.editors[0].approval === 'rejected' && d.jobs[0].approval === 'approved', 'decisions are stored');
  ok(d.notifications.filter(x => x.kind === 'rejected').length === 1 && d.notifications.filter(x => x.kind === 'approved').length === 1, 'both members were notified');
  ok(await has('All caught up'), 'the queue is empty again');
  await page.click('[data-act="tab"][data-tab="owner"]'); await wait();
  ok(await has('approved, waiting to pay'), 'owner stats show someone waiting to pay');
  await shot('08-owner-stats'); await noOverflow('owner stats');
  await signOut();

  // ---------- editor: rejected -> fix -> approved -> pay ----------
  await login('ravi@x.in'); await settle('Not approved yet');
  ok(await has('Not approved yet') && await has('shows someone else'), 'editor sees the rejection and the reason');
  ok(await has('Not approved') && (await page.locator('.steps li.now').innerText()).includes('reviews'), 'steps show we are at the review stage');
  await shot('09-rejected'); await noOverflow('rejected');
  await page.click('[data-act="editprofile"]'); await wait();
  await page.fill('#p-portfolio', 'https://instagram.com/raviedits');
  await page.click('#sheet button[type="submit"]'); await wait(500);
  ok(await has('Under review'), 'after fixing, the profile is under review again');
  d = await db();
  ok(d.editors[0].approval === 'pending', 'edited profile went back to pending');
  await signOut();
  await login('owner@cr.in', 'owner-pass-1'); await settle('Review');
  await page.click('.card:has-text("Ravi Editor")'); await wait();
  ok(await has('instagram.com/raviedits'), 'owner sees the corrected link');
  await page.click('[data-act="decide"][data-v="approved"]'); await wait(450);
  await page.click('#sheet [data-act="close"]:has-text("Done")'); await wait();
  await signOut();

  await login('ravi@x.in'); await settle('Approved. One last step');
  ok(await has('Approved. One last step') && await has('Pay ₹500 and go live'), 'approved editor is asked to pay once');
  ok(await has('Approved. Pay once to go live'), 'the "approved, pay to go live" notification is shown');
  ok(await has('every client can see your price, portfolio and contact'), 'pay screen explains what paying does for an editor');
  await shot('10-pay'); await noOverflow('pay screen');
  await page.click('#paybtn'); await wait(400);
  d = await page.evaluate(() => window.__opened);
  ok(d.length === 1 && d[0] === 'https://rzp.io/i/test-' + (await db()).users.find(u => u.email === 'ravi@x.in').id, 'Pay opens the Razorpay page in the browser');
  ok(await has('Finish the payment'), 'screen tells them what to do next');
  await page.click('[data-act="paycheck"]'); await wait(300);
  ok(await has('not received your payment yet'), 'checking before paying says it has not arrived');
  ok(!(await has('Find work')), 'still locked before paying');
  await page.evaluate(() => window.__mock.pay('ravi@x.in'));
  await page.click('[data-act="paycheck"]'); await settle('Find work', 4000); await wait(300);
  ok(await has('Find work') && await has('Payment received'), 'after paying, the app unlocks by itself');
  d = await db();
  ok(d.profiles.find(p => p.email === undefined && p.full_name === 'Ravi Editor').paid === true, 'account is marked paid');
  ok(await has('No jobs yet'), 'editor sees no jobs yet: the only job belongs to a client who has not paid');
  await shot('11-editor-home'); await noOverflow('editor home');
  await signOut();

  // ---------- client pays; now both sides see each other ----------
  await login('meera@x.in'); await settle('Approved. One last step');
  ok(await has('Approved. One last step') && await has('every editor can see it'), 'approved client is asked to pay once');
  await page.click('#paybtn'); await wait(300);
  await page.evaluate(() => window.__mock.pay('meera@x.in'));
  await page.click('[data-act="paycheck"]'); await settle('Find editors', 4000); await wait(300);
  ok(await has('Find editors') && await has('Ravi Editor'), 'client is in, and sees the approved, paid editor');
  ok(await has('Fast YouTube and Reels editor') && await has('600'), 'the editor card shows the price');
  await shot('12-client-home'); await noOverflow('client find editors');
  await page.click('.card:has-text("Ravi Editor")'); await wait();
  ok(await has('per finished minute') && await has('instagram.com') && await has('98765 43210'), 'editor details show price per minute, portfolio and contact');
  await shot('13-editor-sheet'); await noOverflow('editor sheet');
  await page.click('#sheet .x'); await wait();
  await page.click('[data-act="tab"][data-tab="jobs"]'); await wait();
  ok(await has('Wedding highlight reel') && await hasi('Live'), 'client’s job now shows as Live');
  await signOut();

  // ---------- editor sees the job and applies ----------
  await login('ravi@x.in'); await settle('Find work');
  ok(await has('Wedding highlight reel') && await has('Meera Films'), 'editor now sees the client’s job');
  ok(await has('Payment received'), 'the "payment received" notification is in the inbox');
  ok((await page.locator('#bell .dot').innerText()) >= '1', 'bell shows unread notifications');
  await page.click('#bell'); await wait();
  ok(await has('Notifications') && await has('Not approved') && await has('Approved. Pay once to go live'), 'inbox lists the history');
  await page.click('#sheet .x'); await wait();
  ok(await page.locator('#bell .dot').count() === 0, 'opening the inbox clears the unread count');
  await page.click('.card:has-text("Wedding highlight reel")'); await wait();
  await page.click('[data-act="apply"]'); await wait();
  await page.fill('#a-msg', 'I cut weddings every week. Can deliver in 3 days.');
  await page.fill('#a-quote', '3500');
  await page.click('#sheet button[type="submit"]'); await wait(500);
  ok(await has('You applied with a quote of ₹3,500'), 'application is sent');
  await page.click('#sheet .x'); await wait();
  await page.click('[data-act="tab"][data-tab="applied"]'); await wait();
  ok(await has('Wedding highlight reel') && await hasi('New'), 'Applied tab lists it');
  await signOut();

  // ---------- client hires ----------
  await login('meera@x.in'); await settle('Find editors');
  await page.click('[data-act="tab"][data-tab="jobs"]'); await wait();
  ok(await has('1 applied · 1 new'), 'client sees the application');
  await page.click('.rowitem:has-text("Wedding highlight reel")'); await wait();
  ok(await has('Ravi Editor') && await has('₹3,500') && await has('I cut weddings every week'), 'client sees quote, message and applicant');
  await shot('14-applicant'); await noOverflow('applicant sheet');
  await page.click('[data-act="setstatus"][data-status="hired"]'); await wait(500);
  d = await db();
  ok(d.jobs[0].status === 'filled' && d.applications[0].status === 'hired', 'hire fills the job');
  await page.click('#sheet .x'); await wait();
  await signOut();
  await login('ravi@x.in'); await settle('Find work');
  await page.click('[data-act="tab"][data-tab="applied"]'); await wait();
  await page.click('.rowitem:has-text("Wedding highlight reel")'); await wait();
  ok(await has('You are hired'), 'the editor sees they are hired');
  await page.click('#sheet .x'); await wait();

  // ---------- a paid editor who edits their profile goes back to review but stays in the app ----------
  await page.click('[data-act="tab"][data-tab="me"]'); await wait();
  ok(await has('Unlocked') && await has('Your editor profile'), 'Me tab shows access and profile');
  await page.click('.section [data-act="editprofile"]'); await wait();
  await page.fill('#p-rate', '700');
  await page.click('#sheet button[type="submit"]'); await wait(500);
  ok(await has('In review'), 'editing sends the profile back to review');
  d = await db();
  ok(d.editors[0].approval === 'pending' && d.notifications.some(x => x.title === 'Your profile is under review again'), 'and they are told');
  await noOverflow('me tab');
  await shot('15-me');

  // ---------- nobody sees the wrong side ----------
  ok(!(await has('Find editors')), 'an editor never gets the editor directory');
  await signOut();
  await login('meera@x.in'); await settle('Find editors');
  ok(await has('No editors listed yet'), 'client no longer sees the edited profile until the owner approves it again');
  ok(!(await has('Find work')), 'a client never gets the job board');

  // ---------- owner: Live tab ----------
  await signOut();
  await login('owner@cr.in', 'owner-pass-1'); await settle('Review');
  ok((await page.locator('.nav .badge').innerText()) === '1', 'owner sees the re-submitted profile as 1 waiting');
  await page.click('[data-act="tab"][data-tab="live"]'); await wait();
  ok(await has('Wedding highlight reel'), 'Live tab lists approved posts');
  await page.click('.card:has-text("Wedding highlight reel")'); await wait();
  ok(await page.locator('[data-act="decide"][data-v="rejected"]:has-text("Take down")').count() === 1, 'an approved post can be taken down');
  await page.click('#sheet .x'); await wait();
  await page.click('[data-act="tab"][data-tab="owner"]'); await wait();
  ok(await has('₹1,000') && await has('paid members'), 'owner sees money collected (two members paid ₹500 each)');
  await signOut();

  // ---------- client: a second job, edit it, search, close, delete ----------
  await login('meera@x.in'); await settle('Find editors');
  await page.click('[data-act="tab"][data-tab="jobs"]'); await wait();
  await page.click('.btns [data-act="newjob"], [data-act="newjob"]'); await wait();
  await page.fill('#j-title', 'Podcast episode edit'); await page.fill('#j-brief', 'One hour interview, remove silences, add intro music.'); await page.fill('#j-budget', '1500');
  await page.selectOption('#j-type', 'podcast');
  await page.click('#sheet button[type="submit"]'); await wait(500);
  ok(await has('Podcast episode edit') && await hasi('In review'), 'a paid client’s new job also goes to review first');
  await page.click('.rowitem:has-text("Podcast episode edit")'); await wait();
  ok(await has('Waiting for review'), 'job sheet explains it is waiting');
  await page.click('[data-act="editjob"]'); await wait();
  await page.fill('#j-budget', '1800');
  await page.click('#sheet button[type="submit"]'); await wait(500);
  d = await db();
  ok(d.jobs.find(j => j.title === 'Podcast episode edit').budget === 1800 && d.jobs.find(j => j.title === 'Podcast episode edit').approval === 'pending', 'editing a pending job keeps it pending');
  await signOut();
  await login('owner@cr.in', 'owner-pass-1'); await settle('Review');
  await page.click('.card:has-text("Podcast episode edit")'); await wait();
  await page.click('[data-act="decide"][data-v="approved"]'); await wait(450);
  ok(await has('It is live now'), 'job posted by a paid client goes live straight away on approval');
  await page.click('#sheet [data-act="close"]:has-text("Done")'); await wait();
  await signOut();
  await login('ravi@x.in'); await settle('Find work');
  ok(await has('Podcast episode edit') && await has('1,800'), 'the editor sees the new job');
  await page.fill('#q', 'zzzz'); await wait();
  ok(await has('Nothing matches'), 'a search with no results says so');
  await page.click('[data-act="clear"]'); await wait();
  ok(await has('Podcast episode edit'), 'clearing the search brings the job back');
  await page.click('#chips [data-v="youtube"]'); await wait();
  ok(await has('Nothing matches'), 'filtering by another kind hides it');
  await page.click('#chips [data-v="podcast"]'); await wait();
  ok(await has('Podcast episode edit'), 'filtering by its kind shows it');
  await shot('16-editor-jobs'); await noOverflow('editor job board');
  await signOut();
  await login('meera@x.in'); await settle('Find editors');
  await page.click('[data-act="tab"][data-tab="jobs"]'); await wait();
  await page.click('.rowitem:has-text("Podcast episode edit")'); await wait();
  await page.click('[data-act="closejob"]'); ok(await has('Tap again to confirm'), 'closing a job asks for a second tap');
  await page.click('[data-act="closejob"]'); await wait(500);
  d = await db();
  ok(d.jobs.find(j => j.title === 'Podcast episode edit').status === 'closed', 'job is closed');
  await page.click('[data-act="deletejob"]'); await page.click('[data-act="deletejob"]'); await wait(500);
  d = await db();
  ok(!d.jobs.some(j => j.title === 'Podcast episode edit'), 'job is deleted');
  await signOut();

  // ---------- deleting an account from the waiting screen ----------
  await signup('client', 'Tia Test', '90909 80808', 'tia@x.in');
  ok(await has('Delete my account'), 'a member who has not paid can still delete their account');
  await page.click('[data-act="deleteaccount"]'); ok(await has('Tap again to confirm'), 'deleting asks for a second tap');
  await page.click('[data-act="deleteaccount"]'); await wait(500);
  d = await db();
  ok(!d.users.some(u => u.email === 'tia@x.in') && !d.profiles.some(p => p.full_name === 'Tia Test') && await has('Create account'), 'account and profile are gone, and the app is back at sign-up');

  // ---------- login problems ----------
  await login('nobody@x.in'); ok(await has('Wrong email or password'), 'wrong login is explained plainly');
  await page.click('[data-act="mode"][data-v="forgot"]'); await page.fill('#f-email', 'ravi@x.in');
  await page.click('form[data-form="forgot"] button[type="submit"]'); await wait();
  ok(await has('reset link is on its way') && (await db()).resets[0].opts.redirectTo === 'https://me.github.io/cutting-room/reset.html', 'password reset sends the link to the reset page');

  // ---------- email confirmation mode ----------
  await page.evaluate(() => window.__mock.confirmEmail(true));
  await page.click('[data-act="mode"][data-v="login"]').catch(() => {});
  await page.click('[data-act="mode"][data-v="signup"]');
  await signup('client', 'Sam', '90000 11111', 'sam@x.in');
  ok(await has('We sent a confirmation link to sam@x.in'), 'if email confirmation is on, the app says so');

  ok(errors.length === 0, 'no console errors or crashes' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close(); server.close();
  console.log('\n' + (fails ? fails + ' FAILED of ' + n : 'ALL ' + n + ' PASSED') + '   (screenshots in ' + OUT + ')');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(2); });
