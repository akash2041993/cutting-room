# Cutting Room: setup guide

A marketplace Android app. **Editors** post a profile (price per minute, portfolio). **Clients** post jobs. You, the owner, check every post. After you approve, the member pays **₹500 once** and their post goes live: editors see jobs, clients see editors.

Everything below is free to set up. You need a PC browser for most steps (a phone works too, just slower). Plan for about 1 to 1.5 hours the first time. Do the parts in order: **A Supabase, B GitHub, C Razorpay, D back in Supabase, E install and become the owner.**

> Words you will see: **Supabase** = free online database and login. **GitHub** = free place that stores this project, hosts your website pages and builds the APK for you. **Razorpay** = collects the ₹500 and pays it to your bank.

---

## How it works for your members

1. Sign up as Editor or Client (free, no payment).
2. They fill in their post (editor profile with price and portfolio, or a job). They get the message **"Under review"**.
3. You open the app, go to **Review**, and check it. Tap **Approve**, or **Reject** with a reason (they can fix it and send again).
4. On approval they get **"Approved. Pay once to go live"**. They pay ₹500 through Razorpay.
5. Payment unlocks their account automatically and their post goes live. Editors only ever see jobs. Clients only ever see editors.
6. Later posts from a paid member need your approval again but **no second payment**.

Rules the database enforces (not just the screens): nobody sees a post until you approve it **and** its author has paid, and nobody can mark themselves as paid.

---

## Part A: Supabase (database, login, payment function)

1. Go to **supabase.com**, sign up, **New project**. Name it `cutting-room`. Pick the region nearest you (for India: *Mumbai*). Make a strong database password and save it somewhere. Wait about 2 minutes.
2. **Turn off email confirmation** (so people can log in right after signing up): left menu **Authentication** → **Sign In / Providers** → **Email** → switch **Confirm email** OFF → Save.
3. **Create the tables and rules:** left menu **SQL Editor** → **New query**. Open `supabase/schema.sql` from this project, copy everything, paste, press **Run**. You should see *Success*. (It is safe to run again.)
4. **Copy your two keys:** **Project Settings** → **API**. Copy the **Project URL** and the **anon public** key (newer projects call it the *publishable* key; either works). You will paste them in Part B. These two are meant to be public. **Never** copy the *service_role* / *secret* key anywhere.
5. **Put the payment function online:** left menu **Edge Functions** → **Deploy a new function** → **Via Editor**. Name it exactly **`payments`**. Delete the sample code, paste all of `supabase/functions/payments/index.ts`, **Deploy**.
6. **Turn off JWT check for it:** open the `payments` function → **Settings** (or the details tab) → switch **Verify JWT** OFF → Save. (Razorpay's server calls it and cannot send a login token. The function checks everything itself.)

Your payment function's address is `https://YOUR-PROJECT-REF.supabase.co/functions/v1/payments` (YOUR-PROJECT-REF is the first part of your Project URL). You need it for Razorpay's webhook.

---

## Part B: GitHub (website pages + APK builder)

1. Sign up at **github.com**. Click **New repository**. Name it `cutting-room`. Choose **Public** (free website pages and free APK builds need it). Create.
2. **Upload this project:** unzip it on your PC. In the new repository click **uploading an existing file**, drag in **everything inside the unzipped folder** (including the `.github` folder), and **Commit changes**.
   *If the `.github` folder did not upload* (check that `.github/workflows/build-apk.yml` exists in the repo): click **Add file → Create new file**, type `.github/workflows/build-apk.yml` as the name (typing `/` makes folders), paste the contents of that file, commit.
3. **Turn on your website:** repo **Settings** → **Pages** → *Build and deployment* → Source **Deploy from a branch** → Branch **main**, folder **/docs** → Save. After a minute the page shows your address: `https://YOURNAME.github.io/cutting-room/`.
4. **Fill in your settings:** in the repo open `docs/config.js` → pencil icon → replace the `PASTE_YOUR...` values with your Project URL, anon key and Pages address; set `SUPPORT_EMAIL` (and optionally `SUPPORT_WHATSAPP`, 10 digits) and `BUSINESS_NAME` → **Commit**.
   *The very first upload starts a build before you filled this in. That build stops with a message about placeholders. That is expected and harmless.*
5. **Get the APK:** your commit in step 4 starts the build automatically. Open the **Actions** tab and watch **Build Android APK** (about 8 to 12 minutes). When it has a green tick, the file is under **Releases** (right side of the repo page) as **CuttingRoom.apk**. Your website home page also has a **Download the Android app** button that always points to the newest one.
   *If it fails (red cross): click the run, click the failed step, and send me the last 20 lines.*
6. Open your website pages once to check them: `.../index.html`, `terms.html`, `privacy.html`, `refund.html`. **Read the Terms, Privacy and Refund pages and edit them to match your business**, or ask a lawyer. They are plain-language drafts, not legal advice. Razorpay also reads them when approving your account.

> Any time you change `docs/config.js`, the app is rebuilt automatically (the keys are packed inside the APK).

---

## Part C: Razorpay (receiving the money)

1. Sign up at **razorpay.com**. Complete **account activation (KYC)**: PAN, bank account, business type (an individual or sole proprietor is fine), and the website link (your GitHub Pages home address). Razorpay checks the Terms, Privacy and Refund pages, so finish Part B first. Activation usually takes a few days.
2. **While you wait, use Test Mode** (switch at the top of the Razorpay dashboard). **Account & Settings** → **API Keys** → **Generate Test Key**. Copy **Key Id** and **Key Secret** (the secret is shown only once) into the Supabase secrets in Part D.
3. **Webhook:** **Account & Settings** → **Webhooks** → **Add New Webhook**. URL: your payment function address from Part A. Secret: make up a long random text and keep it, you will paste the same text into Supabase as `RAZORPAY_WEBHOOK_SECRET` in Part D. Tick the event **Payment Link → payment_link.paid**. Save.
4. **Test it end to end** once Parts D and E are done (see "Test checklist" in Part E) with Razorpay's test card or test UPI details from their docs. No real money moves in Test Mode.
5. **Go live** once KYC is approved: switch Razorpay to **Live Mode**, generate **Live Keys**, replace `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in Supabase (Part D), and add the webhook **again in Live Mode** (webhooks are separate per mode). Make one real ₹500 payment yourself to confirm.

**Money facts:** Razorpay keeps about **2% plus 18% GST on that fee**, so on ₹500 you receive roughly **₹488**. It reaches your bank about **2 working days** after each payment. There is no monthly fee. GST registration is only required once yearly turnover passes ₹20 lakh (check with an accountant). Keep your Razorpay and bank statements for income tax.

---

## Part D: Back in Supabase (secrets and login redirect)

1. **Add the secrets:** **Edge Functions** → **Secrets** → add these:

   | Name | Value |
   |---|---|
   | `RAZORPAY_KEY_ID` | from Razorpay (starts `rzp_test_` or `rzp_live_`) |
   | `RAZORPAY_KEY_SECRET` | from Razorpay |
   | `RAZORPAY_WEBHOOK_SECRET` | any long random text you make up; use the same in Razorpay's webhook |
   | `RETURN_URL` | `https://YOURNAME.github.io/cutting-room/paid.html` (your GitHub Pages address from Part B + `paid.html`) |
   | `PRICE_RUPEES` | `500` (optional, 500 is the default) |

   Supabase adds `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` by itself.
2. **Allow the password-reset page:** **Authentication** → **URL Configuration**. Set **Site URL** to `https://YOURNAME.github.io/cutting-room/` and under **Redirect URLs** add `https://YOURNAME.github.io/cutting-room/reset.html`. Save.

---

## Part E: Install the app and become the owner

1. On your Android phone open your website's home page, tap **Download the Android app**, open the file. If asked, allow **install unknown apps** for that browser. If *Play Protect* warns, tap **More details → Install anyway** (the app is not from the Play Store).
2. **Create your owner login:** open the app, **Sign up** with the email you want as owner.
3. **Make that email the owner.** In Supabase → **SQL Editor** → New query, paste this (change `you@example.com` to your real email) and Run:

   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = lower('you@example.com')
   on conflict do nothing;

   select u.email as owner_email from public.admins a join auth.users u on u.id = a.user_id;
   ```
   The result table at the bottom should list your email. If it is empty, the email has a typo or you have not signed up yet.
4. **Sign out and sign in again.** You will now see **Review**, **Live** and **Owner** tabs. Review is your queue; Owner shows member and revenue counts.
5. The owner account does not pay and cannot post. **To test as a normal member, sign up with a different email** (a second Gmail works).

### Test checklist (Test Mode, with a second email)

1. Sign up as **Editor** → fill profile with price and portfolio → you see "Under review".
2. Owner account: **Review** → open it → **Reject** with a reason → the member's app shows the reason. Fix and resubmit.
3. Owner: **Approve**. The member sees "Approved. Pay once to go live". Tap **Pay** → Razorpay opens in the browser → pay with a test card.
4. Go back to the app: it unlocks within seconds (or tap *I have paid, check now*). The profile shows as live in your **Live** tab.
5. Repeat with a **Client** account (another email): post a job, approve, pay → they can now see the editor and its price and portfolio, and the editor can see the job and apply.

---

## What it cannot do (be aware)

- **No phone push notifications when the app is closed.** Members see updates inside the app (bell icon; it refreshes every 15 seconds on the waiting screens and whenever the app is reopened). When you approve or reject, the app offers a **pre-filled WhatsApp message** to send in one tap. Real push needs Firebase; it can be added later.
- **You are not told about new posts by push either**: the Review tab shows a red count. Check it daily.
- **Do not put this APK on the Google Play Store as is.** Play requires its own billing for digital access fees; Razorpay payments would be refused. Share the APK from your website, WhatsApp or Telegram instead.
- **Supabase's free plan pauses a project after 7 days with no use.** Open the app or the Supabase dashboard at least once a week, or upgrade when you have steady users (about $25/month).
- **Password-reset emails** use Supabase's built-in sender, which is limited to a few emails per hour. For many users add free custom SMTP (for example Brevo or Resend) in Supabase → Authentication → SMTP.
- **The signing key in this project is public** (the password is `cuttingroom`) so builds work with no setup. It is fine for sharing the APK yourself. Anyone could in theory make a fake APK signed the same way, so tell members to download only from your website's button. If you later want a private key, tell me and I will switch the build to a GitHub secret.
- **Applications from editors are not moderated** (only profiles and jobs are). A rejected post is simply hidden from others.
- **No refunds are automated**: refund from the Razorpay dashboard (Payments → select → Refund) following your Refund page.

---

## Running the tests (optional, for developers)

```
npm install
npm run test:db     # needs PostgreSQL 16 locally; checks every security rule (166 checks)
npm run test:fn     # payment function logic with a pretend Razorpay (Node 22)
npm run test:app    # app screens in a headless browser with a pretend Supabase (needs Playwright)
npm run test:site   # website pages in a headless browser
```
Not covered by these tests (they need the real services): the live Supabase and Razorpay connection, the Android build itself, and how the app behaves on a physical phone. That is what your Test Mode run in the checklist above checks.

## Where things are

| Path | What it is |
|---|---|
| `www/` | The app (HTML, CSS, JS) |
| `supabase/schema.sql` | Tables, security rules, owner review functions, notifications |
| `supabase/functions/payments/index.ts` | Creates the ₹500 link and unlocks accounts after payment |
| `docs/` | Your website: home, Terms, Privacy, Refunds, payment return, password reset, and **`config.js` (the one file you edit)** |
| `.github/workflows/build-apk.yml` | Builds and signs the APK in the cloud |
| `scripts/`, `resources/` | Build helpers, app icon, signing key |
| `tests/` | Automated checks |
