# Going live: Azeli Technologies website, Azeli PMS and team email

This takes about an afternoon. You do the account sign-ups and payments; everything else is already set up in this repository (`vercel.json` for the website, `render.yaml` for the PMS, `scripts/build-site.sh`).

## What you are setting up

| Piece | Service | Why this one | Approx. cost |
|---|---|---|---|
| Domain name + DNS | **Cloudflare** (Registrar + DNS) | Sells .com at cost with no renewal mark-up; the best free DNS | ≈ $11 / year |
| Website (azeli…com) | **Vercel** (Pro) | Fast worldwide, HTTPS included, deploys itself when the code changes, preview link for every change | $20 / month (Pro is required for a business site: the free Hobby plan is for personal, non-commercial use only) |
| Azeli PMS (one per property) | **Render** web service (Starter) + Render Postgres (Basic 256 MB), Frankfurt | The PMS must run all the time (night-audit report emails, guest emails and channel updates every minute). Vercel only runs code briefly per request, so the PMS cannot run there. Render: no server to look after, HTTPS, health checks, automatic restarts, private database | ≈ $7 + $6 = **$13 / month per property** |
| Team mailboxes (you@, sales@…) | **Google Workspace Business Starter** | Gmail, Calendar, Meet and Drive on your own domain; you already work in Google Ads and Business Profile | ≈ $7 / user / month (annual) or $8.40 monthly |
| Emails the PMS sends (reports, guest emails, campaigns) | **Brevo** (SMTP) | Built for automated sending, which keeps your team's mailboxes off spam lists | Free up to 300 emails / day |

*Budget alternative for mailboxes:* Zoho Mail Lite at about $1 / user / month. It does email only; there's no Docs or Meet.

**Example: 5 team mailboxes, the website on Vercel Pro and Amaya's PMS cost about $70 a month in total.** Each extra hotel you sign up adds about $13 a month, which you can include in your package price.

### Is that enough capacity?
Yes, with room to spare. A 50-room hotel with 50 staff signed in generates a few hundred requests an hour; the Starter instance (0.5 CPU, 512 MB) handles that comfortably, and a year of bookings, bills and accounts is a few tens of megabytes in the database. Move up when you see it:
- **Pages feel slow at busy times** → change the PMS plan to *Standard* ($25) in Render, one click, no data moved.
- **Database storage near its limit** → raise the database plan in Render.
- **More than ~300 system emails a day** (large campaigns) → Brevo's paid Starter plan. Until then, emails over the daily limit are retried automatically over the following hours.
- **Each new hotel** gets its own PMS + database (copy the two blocks in `render.yaml`), so one hotel's busy night never slows another, and their data is kept apart.

Render has no African region; Frankfurt is the closest (≈150–200 ms from Kampala, fine for a web system). Uganda's Data Protection and Privacy Act allows storing data abroad where it is adequately protected; mention it in your client contracts.

---

## Step 1: Choose and buy the domain (Cloudflare)
1. Create an account at **dash.cloudflare.com**.
2. **Domain Registration → Register Domains**, search for your name. Good options, in order: `azelitechnologies.com`, `azelitech.com`, `azeli.co`.
3. Buy it (turn on auto-renew). The domain's DNS is now managed in Cloudflare.

Below, `example.com` stands for the domain you bought.

## Step 2: Team mailboxes (Google Workspace)
1. Go to **workspace.google.com → Get started**, choose *Business Starter*, and use your new domain.
2. Google asks you to verify the domain: choose **Cloudflare**; Google can add the records for you, or copy the TXT record into Cloudflare → *DNS → Records*.
3. Add Google's **MX** record when asked (Google shows it; in Cloudflare it is: Type `MX`, Name `@`, Mail server `smtp.google.com`, Priority `1`).
4. Create mailboxes, for example: `you@`, `hello@` (shown on the website), `sales@`, `support@` (clients' PMS questions). Use **groups** for shared addresses such as `hello@`, so several people receive them at no extra cost.
5. In the Google Admin console → *Apps → Gmail → Authenticate email*, generate the **DKIM** key and add it to Cloudflare as a TXT record, then press *Start authentication*.

## Step 3: System email (Brevo)
1. Create an account at **brevo.com** (free plan).
2. **Senders, Domains & Dedicated IPs → Domains → Add a domain**: enter your domain and add the records Brevo shows to Cloudflare (DNS only).
3. **SMTP & API → SMTP → Generate a new SMTP key**. Note the *login* and the *key*.
4. Your PMS email setting will be:
   `smtp://LOGIN:SMTP_KEY@smtp-relay.brevo.com:587`
   If the login or key contains `@` or `:`, replace it with `%40` or `%3A`.

### SPF and DMARC (one-time, so mail is trusted)
In Cloudflare DNS add, or edit if one exists:
- TXT, Name `@`: `v=spf1 include:_spf.google.com include:spf.brevo.com ~all` (only **one** SPF record may exist).
- TXT, Name `_dmarc`: `v=DMARC1; p=none; rua=mailto:you@example.com` (tighten to `p=quarantine` after a few weeks of clean reports).

## Step 4: Website (Vercel)
1. Create an account at **vercel.com** and sign in **with GitHub**, allowing access to the `first-assignment` repository. Choose the **Pro** plan (business use).
2. **Add New → Project**, import the repository. Vercel reads `vercel.json`: it builds the site with `scripts/build-site.sh` and publishes only the website's files (never the PMS code). Leave *Framework* as **Other** and the root directory as the repository root. Press **Deploy**.
3. Under **Settings → Git**, set the *Production Branch* to the branch you deploy from (e.g. `main`).
4. **Settings → Domains**: add `example.com` and `www.example.com` (choose one to redirect to the other). Vercel shows the DNS records to create; add them in Cloudflare (Step 6).

## Step 5: Azeli PMS (Render)
1. Create an account at **render.com** and sign in **with GitHub**, allowing access to the repository.
2. **New → Blueprint**, pick the repository and branch. Render reads `render.yaml` and shows `azeli-pms` and its database `azeli-pms-db`.
3. Fill in the values it asks for:
   | Setting | Example |
   |---|---|
   | `PROPERTY_NAME` | `Amaya Hotel & Luxury Suites` |
   | `ADMIN_PASSWORD` | a long password for the first sign-in (change it afterwards) |
   | `PUBLIC_URL` | `https://amaya.example.com` |
   | `SMTP_URL` | the Brevo line from Step 3 |
   | `EMAIL_FROM` | `Amaya Hotel & Luxury Suites <reports@example.com>` |
4. **Apply**. The first deploy takes a few minutes. The PMS creates its database tables and sets up the property on its own.
5. `azeli-pms` → **Settings → Custom Domains**: add `amaya.example.com` (one sub-address per hotel). Render shows a DNS record for it.

## Step 6: Point your addresses (Cloudflare DNS)
In Cloudflare → your domain → **DNS → Records**, add exactly the records Vercel and Render showed you:
- website: for `example.com` and `www` (usually an `A` record to Vercel's address and a `CNAME` to Vercel)
- PMS: a `CNAME` for `amaya` pointing to your `….onrender.com` address

Set each of these to **DNS only (grey cloud)**, not proxied. Vercel and Render issue the HTTPS certificates themselves, and the PMS needs to see visitors' own addresses for its sign-in protection. Within a few minutes both show the domain as verified.

## Step 7: First sign-in
1. Open `https://amaya.example.com`, sign in as `admin` with your `ADMIN_PASSWORD`, then **Password** (top right) to change it.
2. **Settings**: rooms and room types, VAT rate. **Users**: one account per staff member.
3. **Automatic emails**: add the hotel's Google review link; switch on the pre-arrival and thank-you emails.
4. **Department reports → Schedules**: who gets which report.
5. Send yourself a test: **Department reports → Run a report**, add your email, and check it arrives (and not in spam).

## Adding another hotel later
In `render.yaml` copy the `azeli-pms` service and the `azeli-pms-db` database, rename both (e.g. `hotel2-pms`, `hotel2-pms-db`), push, then repeat Step 5 and the PMS part of Step 6 with `hotel2.example.com`, then Step 7. Link the hotels on each one's **Group dashboard** if an owner has several.

## Keeping it safe
- Render restarts the PMS automatically if it stops, and checks `/healthz` before every new version goes live.
- The database is not reachable from the internet (`ipAllowList: []`), only from the PMS.
- Check your Render database plan's backup policy before real data goes in, and keep the admin password in a password manager. Automatic off-site backups are the next item on the roadmap.
