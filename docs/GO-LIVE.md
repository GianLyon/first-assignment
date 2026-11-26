# Going live: azelitech.com, the Azeli Console and Azeli PMS

You do the account sign-ups and payments; everything else is already set up in this repository:
`vercel.json` (website), `render.yaml` (Azeli PMS and the Azeli Console, each with a private database) and `scripts/build-site.mjs`.

## What you are setting up

| Address | What | Where | Approx. cost |
|---|---|---|---|
| `azelitech.com`, `www.azelitech.com` | Azeli Technologies website | **Vercel Pro** (required for a business site) | $20 / month |
| `admin.azelitech.com` | **Azeli Console**: your admin panel (enquiries, website editing, client hotels, team) | **Render** Starter + Postgres Basic-256MB, Frankfurt | $7 + $6 = $13 / month |
| `amaya.azelitech.com` | Amaya's **Azeli PMS** (each hotel gets its own, e.g. `hotel2.azelitech.com`) | **Render** Starter + Postgres Basic-1GB, Frankfurt, continuous backups | $7 + $19 = $26 / month per hotel |
| (domain and DNS) | azelitech.com | **Cloudflare** | ≈ $11 / year |
| later: team mailboxes | `you@`, `hello@`, `sales@`… | Google Workspace Business Starter | ≈ $7 / user / month |
| later: system email | reports, guest emails, enquiry alerts | Brevo Starter | ≈ $9 / month |

**Website, console and Amaya's PMS: about $60 a month. With 5 mailboxes and Brevo: about $105.** Each extra hotel adds about $26.

The PMS and the console run on Render because they must be on all the time (night-audit emails, checks every few minutes). Vercel runs code only briefly per visit, which suits the website.

---

> **Beta:** how to install the app on phones and computers, run the beta, and what to pay for and when: see [BETA.md](BETA.md).

# Part A: website and systems live (do this now)

## Step 1: Domain ✅ done
`azelitech.com` is registered at Cloudflare (renews October 2027). Leave Cloudflare *Email Routing* off: Google Workspace will receive your email later.

## Step 2: Put the code on the main branch
Vercel and Render deploy from one branch of the `gianlyon/first-assignment` repository on GitHub. Ask Claude to open a pull request, then merge it on GitHub, so everything is on `main`. (Or choose the branch `claude/hospitality-consulting-website-0qbh0e` in Steps 3 and 4.)

## Step 3: Website on Vercel
1. Go to **vercel.com → Sign up → Continue with GitHub**. Choose the **Pro** plan.
2. **Add New → Project** → import `first-assignment`. Vercel reads `vercel.json`; leave *Framework* as **Other** and the root directory as it is.
3. Before deploying, open **Environment Variables** and add:
   `CONSOLE_URL` = `https://admin.azelitech.com`
   (the website reads your published text from the console and sends enquiries to it).
4. **Deploy**. Until the console is live the site is built exactly as it is in the code; nothing breaks.
5. **Settings → Domains**: add `azelitech.com` and `www.azelitech.com`, and set `www` to redirect to `azelitech.com`. Keep the DNS records Vercel shows; you add them in Step 5.
6. **Settings → Git → Deploy Hooks**: create a hook named `Azeli Console`, branch `main`. **Copy the address** it shows; it goes into Render next. It lets the console's **Publish** button rebuild the website.

## Step 4: Azeli Console and Azeli PMS on Render
1. Go to **render.com → Get started → GitHub**.
2. **New → Blueprint** → choose `first-assignment` and the branch. Render shows four items: `azeli-pms`, `azeli-pms-db`, `azeli-console`, `azeli-console-db`.
3. Fill in the values it asks for:

   **azeli-console**
   | Setting | Value |
   |---|---|
   | `OWNER_NAME` | your name |
   | `OWNER_EMAIL` | the email you will sign in with (your Gmail is fine until Workspace is set up) |
   | `OWNER_PASSWORD` | a strong password, at least 10 characters |
   | `VERCEL_DEPLOY_HOOK` | the address from Step 3.6 |
   | `SMTP_URL`, `LEAD_NOTIFY` | leave empty for now (Part B) |

   **azeli-pms**
   | Setting | Value |
   |---|---|
   | `PROPERTY_NAME` | `Amaya Hotel & Luxury Suites` |
   | `ADMIN_PASSWORD` | a strong password for Amaya's first `admin` sign-in |
   | `PUBLIC_URL` | `https://amaya.azelitech.com` |
   | `SMTP_URL`, `EMAIL_FROM` | leave empty for now (Part B); emails are kept in the system meanwhile |
4. **Apply**. The first deploy takes a few minutes. Both create their database tables and set themselves up.
5. Custom domains: `azeli-console` → **Settings → Custom Domains** → `admin.azelitech.com`; `azeli-pms` → `amaya.azelitech.com`. Keep the DNS records Render shows.

## Step 5: Point the addresses (Cloudflare)
Cloudflare → `azelitech.com` → **DNS → Records → Add record**, for each record Vercel and Render showed:
| For | Typically |
|---|---|
| `azelitech.com` (website) | `A` record, name `@`, to Vercel's address |
| `www` (website) | `CNAME` to Vercel |
| `admin` (console) | `CNAME` to `azeli-console….onrender.com` |
| `amaya` (PMS) | `CNAME` to `azeli-pms….onrender.com` |

Set **every one to "DNS only" (grey cloud)**: Vercel and Render issue the HTTPS certificates, and the systems need to see visitors' own addresses for sign-in protection. Within minutes Vercel and Render show the domains as verified.

## Step 6: First sign-ins
1. **Console**: open `https://admin.azelitech.com`, sign in with `OWNER_EMAIL` / `OWNER_PASSWORD`, then **Password** to change it.
   - **Website**: check the contact details, add prices to the packages if you want them shown, fill in Amaya's real results and quote, then **Publish**. The site updates in about a minute.
   - **Team**: add your colleagues (owner, website editor or sales).
2. **Amaya's PMS**: open `https://amaya.azelitech.com`, sign in as `admin` with `ADMIN_PASSWORD`, change the password, then set up rooms, users and rates (**Settings**, **Users**, **Rate plans**).
3. Connect them: in Amaya's PMS open **Group dashboard → Create key**; in the console **Client hotels → Add a hotel**, address `https://amaya.azelitech.com`, paste the key. The console now shows whether Amaya's system is online and its occupancy and revenue for the month.
4. Test the enquiry form: open `https://azelitech.com/contact.html`, send a test request, and see it arrive in the console under **Enquiries**.

## Step 7: Get found on Google
1. **Google Search Console** (search.google.com/search-console) → *Add property* → **Domain** → `azelitech.com`. Google recognises Cloudflare and offers to verify automatically; accept.
   Then **Sitemaps** → submit `https://azelitech.com/sitemap.xml`, and **URL inspection** → `https://azelitech.com/` → *Request indexing*. First pages usually appear within days.
2. **Bing Webmaster Tools** (bing.com/webmasters) → *Import from Google Search Console*. This also covers search engines that use Bing's results.
3. **Google Business Profile** (business.google.com) for Azeli Technologies: a *service-area business* (no shop address shown), category *Marketing agency*, your phone, WhatsApp and `https://azelitech.com`. This is what shows on Google Maps and on the right of search results.
4. Put `https://azelitech.com` on your Instagram, Facebook, LinkedIn and WhatsApp Business profiles, and ask Amaya to link to you from their site. Links from real businesses help ranking.
5. Keep it real: replace the bracketed Amaya results in the console with real figures as soon as you have them. Real numbers and a real quote are what convince both Google and hotel owners.

---

# Part B: email (when you are ready)

1. **Google Workspace** (workspace.google.com) → *Business Starter* with `azelitech.com`; when it asks to verify, choose **Cloudflare** and let it add the records. Create mailboxes and a `hello@` group. In the Admin console → *Apps → Gmail → Authenticate email*, generate **DKIM** and add it in Cloudflare.
2. **Brevo** (brevo.com) → *Starter*. **Senders, Domains & Dedicated IPs → Domains**: add `azelitech.com` and the records it shows (DNS only). **SMTP & API → SMTP**: generate a key.
3. Cloudflare DNS, once:
   - TXT `@`: `v=spf1 include:_spf.google.com include:spf.brevo.com ~all` (only one `v=spf1` record may exist)
   - TXT `_dmarc`: `v=DMARC1; p=none; rua=mailto:hello@azelitech.com`
4. Render:
   - `azeli-pms`: `SMTP_URL` = `smtp://LOGIN:SMTP_KEY@smtp-relay.brevo.com:587` and `EMAIL_FROM` = `Amaya Hotel & Luxury Suites <reports@azelitech.com>`
   - `azeli-console`: the same `SMTP_URL`, `EMAIL_FROM` = `Azeli Console <console@azelitech.com>` and `LEAD_NOTIFY` = `hello@azelitech.com` (new enquiries are emailed to the team)
   Render restarts the services with the new settings.
5. In Amaya's PMS: **Automatic emails** → add the review link and switch on the pre-arrival and thank-you emails; **Department reports** → schedules.

---

# Part C: safety (do this before real guest data goes in)

## Two-step sign-in
1. **Turn it on for yourself.** In Azeli PMS and in the Azeli Console, click **Two-step** (top right).
   - Scan the QR code with **Google Authenticator**, **Microsoft Authenticator** or **Authy**, then enter the 6-digit code.
   - **Save the 10 recovery codes**: print them, or keep them in a password manager. Each one signs you in once if you lose your phone.
2. **Require it for others.**
   - PMS: **Settings → Security** → tick Administrator, Manager and Accountant (and any role that sees money or guest data) → **Save**.
   - Console: **Team → Require two-step sign-in** → tick Owner.
   - Each person sets it up at their next sign-in, and can do nothing else until they have.
3. **Someone lost their phone?**
   - In the PMS an administrator opens **Users → Reset two-step**; in the Console an owner opens **Team → Reset two-step**.
   - That person is signed out and sets it up again with the new phone.
   - If the top account itself is locked out, use the reset tool in Render's **Shell** (see *Forgotten password*), then **Two-step** again.

## Backups (Cloudflare R2)
Render already keeps a 3-day restore window. This adds an encrypted copy of each hotel's whole database **every night, outside Render**: one for each day of the last month, and one for every month, kept for good.
1. **Create the storage.** Cloudflare → **R2 Object Storage** → **Create bucket**, name it `azeli-backups`. R2's free allowance covers many hotels; after that it costs cents.
2. **Create an access key for it.** R2 → **Manage API tokens** → **Create API token**: permission **Object Read & Write**, applied to the `azeli-backups` bucket only. Copy the **Access Key ID**, the **Secret Access Key** and the **endpoint** (`https://<account id>.r2.cloudflarestorage.com`).
3. **Make a backup key.** It's a long random passphrase, for example from your password manager's generator (at least 20 characters). **Save it in your password manager.** Without it no one can open a backup, and if Render is ever lost, that copy is the only one.
4. **Fill in the settings.** Render → `azeli-pms` → **Environment**:
   - `BACKUP_KEY`: the passphrase
   - `BACKUP_S3_ENDPOINT`: the endpoint
   - `BACKUP_S3_BUCKET`: `azeli-backups`
   - `BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY`: from step 2
   - `BACKUP_ALERT_EMAIL`: where to be told if a backup fails (needs Part B email)

   Save; Render restarts the PMS.
5. **Check it works.** PMS → **Settings → Backups** shows **On**. Click **Back up now**: the list shows **OK** and the file (`…/daily/13.azbk`), and it appears in the R2 bucket. You can also **Download a backup now** to keep a copy on your own computer (it is encrypted with the same key).

**Restoring** (only if the database is lost or damaged), in Render → `azeli-pms` → **Shell**:
1. Download the backup file from R2, or upload your downloaded copy.
2. Run `BACKUP_KEY='your key' node src/restore-backup.js path/to/file.azbk` and type `RESTORE` to confirm.

Everything in the database is replaced, in one go: if anything fails, nothing changes. Everyone signs in again afterwards. The backup must come from the same version of Azeli PMS, which it always is for the nightly copies.

## Alerts
- **Client hotels:** the Console checks every hotel's system every 10 minutes and emails `ALERT_EMAIL` (or `LEAD_NOTIFY`) once when one goes offline, and again when it is back. Set it on `azeli-console` in Render (needs Part B email).
- **Your own sites:** add a free outside monitor, e.g. **UptimeRobot** or **Better Stack**, that checks these every few minutes and alerts your phone:
  - `https://azelitech.com`
  - `https://admin.azelitech.com/healthz`
  - `https://amaya.azelitech.com/healthz`

  It notices if Render or Vercel itself is down, which nothing inside them can.

# Part D: WhatsApp for the front desk

Until this is done, the PMS keeps WhatsApp in **practice mode** while it holds sample data: messages stay in the system, and "Reply as the guest" stands in for guests so the team can learn. On a system with real data and no connection, WhatsApp is off.

**What it costs:** the WhatsApp Business Platform charges per template message delivered (business-started messages and automations). Meta has been changing how replies inside the 24 hours after a guest writes are charged (reports say some became chargeable from October 2026), so check *WhatsApp Manager → Insights → Pricing* for Uganda before switching automations on.

**Use a number that is not already on the WhatsApp app**, or one you are ready to move (e.g. a new MTN or Airtel line for the front desk). Meta now also offers "coexistence" for keeping the WhatsApp Business app on the same number; follow Meta's steps if you want that.

1. **Meta Business account**: go to business.facebook.com → create one for *Amaya Hotel & Luxury Suites* (or verify the existing one). Verification (*Security Center → Start verification*) needs the company documents and lifts the limit on how many guests can be messaged per day.
2. **The app**: developers.facebook.com → **My Apps → Create app** → *Business* → add the **WhatsApp** product. Under **WhatsApp → API Setup**, add the hotel's phone number and verify it by SMS. Note the **Phone number ID**.
3. **A permanent token**: business.facebook.com → **Settings → Users → System users → Add** (admin) → **Add assets** (the app and the WhatsApp account, full control) → **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`, *never expires*. Copy it once.
4. **App secret**: developers.facebook.com → the app → **App settings → Basic → App secret → Show**.
5. **Render** → `azeli-pms` → **Environment**, add:
   | Key | Value |
   |---|---|
   | `WHATSAPP_TOKEN` | the token from step 3 |
   | `WHATSAPP_PHONE_NUMBER_ID` | from step 2 |
   | `WHATSAPP_APP_SECRET` | from step 4 |
   | `WHATSAPP_VERIFY_TOKEN` | any long random phrase you make up |
   | `WHATSAPP_DISPLAY_NUMBER` | the number as guests see it, e.g. `+256 772 123456` |

   Save; Render restarts the PMS. **WhatsApp set-up** in the PMS now shows *Connected*.
6. **Webhook** (so guests' messages reach the inbox): developers.facebook.com → the app → **WhatsApp → Configuration → Webhook → Edit**. Callback URL: the *Webhook address* shown on the PMS WhatsApp set-up page (`https://amaya.azelitech.com/api/whatsapp/webhook`); Verify token: the phrase from step 5. **Verify and save**, then **Manage → messages → Subscribe**.
7. **Templates**: WhatsApp Manager → **Message templates → Create template**. For each template on the PMS WhatsApp set-up page, use the same name, category (*Utility* or *Marketing*), language *English* and the exact wording with `{{1}}`, `{{2}}`. When Meta shows it as **Active** (minutes to a day), tick **Approved** on that template in the PMS.
8. **Automations**: on the same page, switch on the ones you want. They only write to guests who agreed to WhatsApp messages (the tick box on the registration card), never during quiet hours, and once per stay. Guests who reply **STOP** are never written to again unless they send **START**.
9. **Check it**: in the PMS → **WhatsApp set-up** press **Check the connection**. Each line should show ✓; if one shows ✗, the message under it says exactly what to fix (wrong token, wrong phone number ID, number not registered …). Then press **Send a test message** and enter your own phone number: WhatsApp's sample "Hello World" should arrive within a minute. (While the Meta app is in development mode, add your number to the test list under WhatsApp → API Setup → "To".)
10. **Try it**: message the hotel number from your own phone. It appears in **WhatsApp inbox** within seconds; reply from there. **Check the connection** now also shows when the last message from Meta arrived, proving the webhook works.

# Part E: the front-desk AI assistant

The **Assistant** page and the to-do list on the dashboard work without this. The AI part (questions in plain words, WhatsApp reply drafts) needs an Anthropic API key.

1. Go to console.anthropic.com → sign up with the company email → **Billing**: add a card and buy credit (start with $20; set a monthly limit under *Limits*).
2. **API keys → Create key**, name it `amaya-pms`, copy it once.
3. Render → `azeli-pms` → **Environment** → add `ANTHROPIC_API_KEY` with that key → **Save**.
4. In the PMS → **Assistant**, press **Test the AI connection** (administrators only). It shows the model that answered and the time it took, or the exact reason it failed (key refused, no credit on the account, model not available).

It uses Claude Opus 5.5 ($4 per million tokens in, $20 out; repeated instructions are cached at a tenth of the price). A typical front-desk question costs roughly **3–8 US cents** (it looks several things up); a WhatsApp draft about **1–2 cents**. Check the real figures under *Usage* in the Anthropic console after the first week. Each person can ask 40 questions an hour (`AI_HOURLY_LIMIT`). The Assistant page shows who used it and how much. Optional settings: `AI_MODEL` (e.g. `claude-sonnet-5-5` for about half the price), `AI_EFFORT` (`low` by default).

The assistant only reads. It cannot check anyone in or out, take payments or send messages: WhatsApp drafts wait for a receptionist to press Send.

# Part F: Booking.com, Expedia and Agoda (through Channex)

Booking.com, Expedia and Agoda only connect to systems they have certified, and new certifications take a year or more. So Azeli connects to **Channex**, a channel manager already certified with all three (and Airbnb, Trip.com, Hotelbeds and others). Bookings, changes and cancellations reach Reservations within a minute, each room sold is taken off every site straight away, and prices, minimum stays and stop-sells go out from **Rates & availability**.

**Cost:** Channex bills per property (check channex.io/pricing for a single hotel; the white-label partner plan is $130 a month plus $7 per hotel, worth it once Azeli runs several hotels). Each OTA still charges its own commission.

1. **Try it free first**: sign up at staging.channex.io (no card needed). In Render → `azeli-pms` → Environment add `CHANNEX_API_KEY` (Channex → *Profile → API key*) and `CHANNEX_API_BASE` = `https://staging.channex.io/api/v1`.
2. In Channex, create the property **Amaya Hotel & Luxury Suites** with currency **UGX**, its room types (Standard, Deluxe, Suite …) and rate plans (Flexible, Non-refundable …). Copy the **property id**.
3. In the PMS → **Channels (OTAs) → + Channel**: code `channex`, name `Channex`, connector **Channex**, the property id, commission 15%. Note the secret it shows once.
4. **Mapping** on that channel: for each room type and rate plan, paste the Channex room type id and rate plan id.
5. In Channex → **Webhooks → Create**: URL `https://amaya.azelitech.com/api/channels/channex/channex`, events *booking*, header `X-Azeli-Token` = the channel secret. (Bookings are also checked every minute, so a missed call is not lost.)
6. In the PMS press **More → Push all** on the channel: every date's availability and prices go to Channex.
7. Make a test booking in Channex's test channel. It appears in **Reservations** (source = the OTA's name) and the room's availability drops everywhere.
8. **Go live**: change `CHANNEX_API_BASE` to `https://app.channex.io/api/v1` with the production key, repeat steps 2–6 on the live account, then in Channex → **Channels** connect **Booking.com**, **Expedia** and **Agoda**. Channex shows the steps for each: on each OTA's own extranet you choose Channex as your connectivity provider, and Channex maps their rooms to yours.

If a booking cannot be saved (usually a room type that is not mapped), it is not acknowledged: it stays in Channex, the channel shows **Error** with the reason in **Log**, and Channex emails the hotel after 30 minutes. Fix the mapping and press **Get bookings**.

# Part G: the public demo (for the website)

The **Try the live demo** buttons on azelitech.com open a small browser-only mock until this is done. With it, they open the real Azeli PMS with a sample hotel, so prospective clients always see the current version.

**What it costs:** a second Render web service (*Starter*, $7 a month) and a small database (*Basic-256mb*, about $6 a month). Nothing else: the demo sends no emails or WhatsApps and uses no AI unless you add a key to it.

1. Render → **New → PostgreSQL**: name `azeli-demo-db`, region Frankfurt, plan *Basic-256mb*. **Create**.
2. Render → **New → Web Service** → this repository, branch `main`. Name `azeli-demo`, root directory `pms`, build `npm ci`, start `npm start`, region Frankfurt, plan *Starter*.
3. **Environment**:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the *Internal Database URL* of `azeli-demo-db` |
   | `DEMO_MODE` | `1` |
   | `NODE_ENV` | `production` |
   | `TRUST_PROXY` | `1` |
   | `AUTO_SEED` | `1` |
   | `PROPERTY_NAME` | `Azeli Demo Hotel` |
   | `ADMIN_PASSWORD` | a long random password (only you use it) |
   | `PUBLIC_URL` | `https://demo.azelitech.com` |
   | `DEMO_CONTACT_URL` | `https://azelitech.com/contact.html?service=pms` |

   Do **not** add the WhatsApp, Channex, email, backup or Anthropic keys of a real hotel.
4. **Create Web Service.** On first start it fills itself with the sample hotel (about two minutes).
5. **Address**: in the service → **Settings → Custom domains** add `demo.azelitech.com`, then in Cloudflare add the CNAME record Render shows (as in Step 5).
6. **Vercel** → the website project → **Settings → Environment Variables** → add `DEMO_URL` = `https://demo.azelitech.com` → **Deployments → Redeploy**. Every *Try the live demo* button now opens the real system.

Visitors press **Explore the demo hotel** and are in as a general manager. They can take bookings, check guests in, sell in the restaurant and try every page, but cannot change passwords, users or roles, take backups, or send anything outside the system. Everything they do is wiped at 03:00 Kampala time, when the sample hotel is rebuilt. Because the demo runs the same code as the hotels, it updates itself whenever `main` changes.

# Part H: online payments with Pesapal, the website widget and OTA virtual cards

## Pesapal (cards and mobile money)
Each hotel has its **own** Pesapal merchant account, so guests' money settles straight to the hotel's bank.

**What it costs:** no monthly fee from Azeli; Pesapal charges a percentage per transaction. Ask Pesapal for the current card and mobile money rates and the settlement time.

1. **Merchant account:** apply at pesapal.com (Business → Get started) in the hotel's name, with its company documents. Ask Pesapal for **API 3.0** keys.
2. **Test first:** Pesapal also gives sandbox (test) keys. In Render → the hotel's PMS (`azeli-pms`) → **Environment** add:
   | Key | Value |
   |---|---|
   | `PESAPAL_CONSUMER_KEY` | the consumer key |
   | `PESAPAL_CONSUMER_SECRET` | the consumer secret |
   | `PESAPAL_ENV` | `sandbox` |
   | `PUBLIC_URL` | the hotel's address, e.g. `https://amaya.azelitech.com` (already set if the hotel is live) |
3. In the PMS → **Booking engine → Online payment**: tick *Let guests pay online*, choose **Pesapal**, choose *Optional* or *Required* (required: the room is held for the minutes you set, then released if not paid), **Save**. The notification address is registered with Pesapal automatically.
4. Make a booking on the booking page and pay with Pesapal's sandbox test card or test mobile number. It appears on the bill as a payment, under **Recent online payments**, and in the accounts.
5. **Go live:** replace the two keys with the live ones and set `PESAPAL_ENV` = `live`.

## The booking widget on the hotel's own website
PMS → **Booking engine → Website widget**: copy one of the three snippets and paste it into the hotel's website (WordPress: a *Custom HTML* block; Wix: *Embed code*). Choose the hotel's colour under **Booking page**. Nothing else to set up.

## OTA virtual cards
When Expedia, Agoda or Booking.com (Payments by Booking.com) collect from the guest, they pay the hotel with a virtual card. The PMS lists these under **Finance → OTA virtual cards** with the last 4 digits and the dates they can be charged; it never stores the full number.

To charge one, the full card details must come from a secure card store:
- **Channex:** ask Channex to enable card details (PCI) for the property and what it costs; then the card can be opened from the booking in Channex.
- **Charging:** use the hotel's card machine, or ask Pesapal whether it allows the hotel to key in a card (a "virtual terminal" / MOTO). If neither, ask each OTA to pay by bank transfer instead (in the extranet's payment settings, where offered).

Then press **Record charge** in the PMS: it posts the card payment on the guest's bill and, when the OTA paid the net amount, settles the rest as the OTA's commission.

## Adding another hotel
Copy the `azeli-pms` service and `azeli-pms-db` database in `render.yaml`, rename them (e.g. `hotel2-pms`, `hotel2-pms-db`), push, then repeat Step 4 (that service only), its record in Step 5 (`hotel2`), Step 6.2–6.3.

## Forgotten password
- **A PMS user other than `admin`**: an administrator resets it under **Users** in that hotel's PMS. **A Console team member**: an owner resets it under **Team**.
- **The PMS `admin` password**: until it is changed inside the PMS, it is the `ADMIN_PASSWORD` value in Render → `azeli-pms` → **Environment** (click the eye icon). Changing that value later does *not* change the password; it is only used on the first start.
- **If it was changed and forgotten** (PMS `admin`, or the Console owner): Render → the service (`azeli-pms` or `azeli-console`) → **Shell**, then type
  - PMS: `node src/reset-password.js admin`
  - Console: `node src/reset-password.js you@example.com`

  and enter the new password twice. That user is signed out everywhere and can sign in with the new password.
- After 5 wrong attempts, sign-in for that name pauses (PMS 5 minutes, Console 10 minutes). Wait, then try again.

## Capacity
A 50-room hotel with 50 staff signed in is a light load for the Starter instance, and a year of its data is tens of megabytes. If pages feel slow at busy times, change that hotel's PMS to *Standard* ($25) in Render: one click, no data moved. Render's closest region to East Africa is Frankfurt (≈150–200 ms from Kampala, fine for a web system). Uganda's Data Protection and Privacy Act allows storing data abroad with adequate protection; mention it in client contracts.

## Keeping it safe
- Both databases are reachable only from their own system inside Render, never from the internet.
- Render restarts a system automatically if it stops, and checks `/healthz` before each new version goes live.
- Amaya's database is backed up continuously by Render (restore to any moment in the last 3 days from its *Recovery* page), and every night to Cloudflare R2, encrypted (Part C).
- The console is hidden from search engines and locks an email for 10 minutes after 5 wrong passwords.
