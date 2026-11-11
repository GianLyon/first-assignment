# Going live: Azeli Technologies website, Azeli PMS and team email

This takes about an afternoon. You do the account sign-ups and payments; everything else is already set up in this repository (`vercel.json` for the website, `render.yaml` for the PMS, `scripts/build-site.sh`).

## What you are setting up

| Piece | Service & plan | Why | Approx. cost |
|---|---|---|---|
| Domain name + DNS | **Cloudflare** Registrar + DNS | .com at cost, best DNS. Cloudflare's paid plans add protection for traffic that passes through Cloudflare; ours goes straight to Vercel and Render, so they would add nothing | ≈ $11 / year |
| Website | **Vercel Pro** | Required for a business site; fast worldwide, deploys itself on every change | $20 / month |
| Azeli PMS (one per hotel) | **Render** Starter web service + **Postgres Basic-1GB**, Frankfurt | Always on (night-audit and guest emails every minute), private database with continuous backups you can restore to any moment (3-day window) | $7 + $19 = **$26 / month per hotel** |
| Team mailboxes | **Google Workspace Business Starter** | Gmail, Calendar, Meet, Drive on your domain; works with Google Ads and Business Profile | ≈ $7 / user / month (annual), $8.40 monthly |
| Emails the PMS sends | **Brevo Starter** | No daily sending cap (reports, guest emails, campaigns), better standing with inboxes than personal mailboxes | ≈ $9 / month for 5,000 emails |
| Off-site backup copy | **Cloudflare R2** | A nightly copy of each hotel's data outside Render (being built next) | cents / month |

**Example: 5 team mailboxes, the website and Amaya's PMS cost about $90 a month.** Each extra hotel adds about $26 a month, which you can include in your package price.

Worth paying for later, not now: Google Workspace *Business Standard* ($14 / user) if you need 2 TB storage per person or recorded meetings; Render *Standard* PMS instance ($25) if pages feel slow at busy times; Render's *Pro* account tier if you want a 7-day restore window and team access to the Render dashboard.

### Is that enough capacity?
Yes, with room to spare. A 50-room hotel with 50 staff signed in generates a few hundred requests an hour; the Starter instance (0.5 CPU, 512 MB) handles that comfortably, and a year of bookings, bills and accounts is a few tens of megabytes in the database. Move up when you see it:
- **Pages feel slow at busy times** → change the PMS plan to *Standard* ($25) in Render, one click, no data moved.
- **Database storage near its limit** → raise the database plan in Render.
- **More than 5,000 system emails a month** (large campaigns) → the next Brevo band.
- **Each new hotel** gets its own PMS + database (copy the two blocks in `render.yaml`), so one hotel's busy night never slows another, and their data is kept apart.

Render has no African region; Frankfurt is the closest (≈150–200 ms from Kampala, fine for a web system). Uganda's Data Protection and Privacy Act allows storing data abroad where it is adequately protected; mention it in your client contracts.

---

## Step 1: Domain ✅ done
**azelitech.com** is registered at Cloudflare (renews October 2027) and its DNS is managed there.

Addresses used below:
| Address | What |
|---|---|
| `https://azelitech.com` (and `www.`) | Azeli Technologies website (Vercel) |
| `https://amaya.azelitech.com` | Amaya's Azeli PMS (Render); each new hotel gets its own, e.g. `hotel2.azelitech.com` |
| `hello@azelitech.com` | Shown on the website (a Google group: reaches several people) |
| `reports@azelitech.com` | Sender of the PMS's reports and guest emails (Brevo) |

Do **not** switch on Cloudflare *Email Routing*: Google Workspace receives your email, and the two cannot both do it.

## Step 2: Team mailboxes (Google Workspace)
1. Go to **workspace.google.com → Get started**, choose *Business Starter*, and use your new domain.
2. Google asks you to verify the domain: choose **Cloudflare**; Google can add the records for you, or copy the TXT record into Cloudflare → *DNS → Records*.
3. Add Google's **MX** record when asked (Google shows it; in Cloudflare it is: Type `MX`, Name `@`, Mail server `smtp.google.com`, Priority `1`).
4. Create mailboxes, for example: `you@`, `hello@` (shown on the website), `sales@`, `support@` (clients' PMS questions). Use **groups** for shared addresses such as `hello@`, so several people receive them at no extra cost.
5. In the Google Admin console → *Apps → Gmail → Authenticate email*, generate the **DKIM** key and add it to Cloudflare as a TXT record, then press *Start authentication*.

## Step 3: System email (Brevo)
1. Create an account at **brevo.com** and choose the **Starter** plan (check on the pricing page that SMTP sending is included at your volume).
2. **Senders, Domains & Dedicated IPs → Domains → Add a domain**: enter your domain and add the records Brevo shows to Cloudflare (DNS only).
3. **SMTP & API → SMTP → Generate a new SMTP key**. Note the *login* and the *key*.
4. Your PMS email setting will be:
   `smtp://LOGIN:SMTP_KEY@smtp-relay.brevo.com:587`
   If the login or key contains `@` or `:`, replace it with `%40` or `%3A`.

### SPF and DMARC (one-time, so mail is trusted)
In Cloudflare DNS add, or edit if one exists:
- TXT, Name `@`: `v=spf1 include:_spf.google.com include:spf.brevo.com ~all` (only **one** SPF record may exist).
- TXT, Name `_dmarc`: `v=DMARC1; p=none; rua=mailto:you@azelitech.com` (tighten to `p=quarantine` after a few weeks of clean reports).

## Step 4: Website (Vercel)
1. Create an account at **vercel.com** and sign in **with GitHub**, allowing access to the `first-assignment` repository. Choose the **Pro** plan (business use).
2. **Add New → Project**, import the repository. Vercel reads `vercel.json`: it builds the site with `scripts/build-site.sh` and publishes only the website's files (never the PMS code). Leave *Framework* as **Other** and the root directory as the repository root. Press **Deploy**.
3. Under **Settings → Git**, set the *Production Branch* to the branch you deploy from (e.g. `main`).
4. **Settings → Domains**: add `azelitech.com` and `www.example.com` (choose one to redirect to the other). Vercel shows the DNS records to create; add them in Cloudflare (Step 6).

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
   | `EMAIL_FROM` | `Amaya Hotel & Luxury Suites <reports@azelitech.com>` |
4. **Apply**. The first deploy takes a few minutes. The PMS creates its database tables and sets up the property on its own.
5. `azeli-pms` → **Settings → Custom Domains**: add `amaya.example.com` (one sub-address per hotel). Render shows a DNS record for it.

## Step 6: Point your addresses (Cloudflare DNS)
In Cloudflare → your domain → **DNS → Records**, add exactly the records Vercel and Render showed you:
- website: for `azelitech.com` and `www` (usually an `A` record to Vercel's address and a `CNAME` to Vercel)
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
- Render keeps continuous backups of the database (restore to any moment in the last 3 days from the database's *Recovery* page). A nightly off-site copy to Cloudflare R2 is being added. Keep the admin password in a password manager.
