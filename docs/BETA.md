# Azeli PMS beta: running it, installing the app, and what to pay for

Azeli PMS version 0.9 is the **beta**. It is complete enough for a real hotel (Amaya first) to run its front desk, housekeeping, restaurant, stores and accounts on it. While it is in beta, staff report anything that goes wrong from inside the app, and Azeli fixes it quickly.

---

## 1. The app on phones and computers

Azeli PMS is an **installable web app**: the same system opens in a browser *or* installs like an app, with its own icon and window. There is nothing to download from an app store, and every device gets each update automatically.

| Device | How to install |
|---|---|
| **Android phone or tablet** | Open the hotel's address (e.g. `https://amaya.azelitech.com`) in **Chrome**, sign in, then tap **Install app** (in the menu under *More*, or the banner Chrome shows). |
| **iPhone or iPad** | Open the address in **Safari** → **Share** → **Add to Home Screen** → **Add**. (In the app: *More → Install the app* shows these steps.) |
| **Windows or Mac computer** | Open the address in **Chrome** or **Edge** → **Install app** button at the top of Azeli PMS (or the install icon in the address bar). It opens in its own window and can be pinned to the taskbar or dock. |

What staff get on a phone:
- A **bottom bar** with the four places they use most (for a receptionist: Today, Rooms, Bookings, WhatsApp; for a room attendant: Housekeeping, Repairs, My HR) and **More** for everything else.
- **Lists as cards**: reservations, bills, stock and every other list turn into easy-to-read cards on small screens.
- Big buttons, and no zooming into fields on iPhone.
- **No connection?** The app still opens and says so; nothing is lost, because everything is saved on the hotel's server, not the phone.
- **Guest data is never stored on the phone.** A lost or shared phone holds the app, not the hotel's bookings.
- **Updates:** when a new version is deployed, a blue bar says *"A new version is ready"* with a **Reload** button.

### App stores (optional, later)
Installing from the browser is enough for hotel staff. Listing Azeli PMS in the **Google Play Store** and **Apple App Store** is only worth it for marketing ("download our app") and costs money every year:

| Store | Cost | Notes |
|---|---|---|
| Google Play | US$25 once | The installable app can be published almost as it is (as a "Trusted Web Activity"). |
| Apple App Store | US$99 a year | Apple needs a small native wrapper and reviews each version; plan a week. |
| Microsoft Store | Free or a small one-time fee | Optional; Windows users can already install from Edge. |

We can do this once the beta is stable; the system itself does not change.

---

## 2. Running the beta

### Before real guests: the go-live checklist
Sign in as the administrator → **Administration → Go-live checklist**. It checks each hotel automatically:
- **Essentials:** hotel details, rooms and rates, sample data removed, staff sign-ins, two-step sign-in for managers, the night audit being run, a secure address and nightly backups.
- **Paid services:** switch these on one at a time (see section 3).

The dashboard shows *"Getting ready to go live: x of 9"* to the administrator until the essentials are done.

### Feedback and problems
- Every staff member has **Feedback** (top bar on a computer, *More → Report a problem or idea* on a phone).
- Reports go to **Administration → System health & feedback**, with the page they were on and the app version. Each can be marked *Seen* or *Done* with a reply.
- If `SUPPORT_EMAIL` is set (e.g. `support@azelitech.com`) and email is set up, every report is also emailed to Azeli.

### Errors and health
The same page, **System health & feedback**, shows:
- **Errors** that happened on anyone's screen or on the server (each kept once, with a count), so problems are seen even when nobody reports them.
- **The essentials:** the last night audit, the last backup, database size and staff activity.
- **Connected services:** email, backups, payments, WhatsApp, OTAs, AI and support, each marked *Live*, *Test* or *Off*.

### Beta routine for Azeli
- **Daily:** open **System health & feedback** for each beta hotel; answer new reports.
- **Weekly:** ship fixes; staff see *"A new version is ready"*.
- **Before leaving beta:** a month with no unanswered problems, backups every night, and the go-live checklist complete.

---

## 3. What to pay for, and when

Prices are what each provider lists; check before paying. Everything except hosting can wait until the hotel needs it, and **the system works without each of them** (it shows *Test* or *Off* until switched on).

| When | What | Cost | What it switches on | Guide |
|---|---|---|---|---|
| **Now (already running)** | Vercel Pro (website), Render (Console + Amaya PMS), Cloudflare domain | ≈ US$60 / month | The website, the admin console, Amaya's PMS | GO-LIVE Part A |
| **Before real guest data** | Cloudflare R2 (backups) | Free at this size | Encrypted nightly backups off-site | GO-LIVE Part C |
| **Before real guest data** | Brevo (email) | Free tier, then ≈ US$9 / month | Reports, guest emails, feedback to Azeli | GO-LIVE Part B |
| **When taking online payments** | Pesapal merchant account | No monthly fee; a % per payment | Card and MTN / Airtel payments on the booking page | GO-LIVE Part H |
| **When ready for OTAs** | Channex | Per property per month (ask for a one-hotel quote; partner plan US$130 + US$7 per hotel) | Booking.com, Expedia, Agoda bookings and availability | GO-LIVE Part F |
| **When ready for WhatsApp** | Meta WhatsApp Business Platform + a dedicated number | Per message sent; replies within 24 h free | WhatsApp inbox, automations, buying signals | GO-LIVE Part D |
| **Optional** | Anthropic API (AI assistant) | Pay as you use, ≈ US$20–40 / month with a limit | Plain-language questions, WhatsApp reply drafts | GO-LIVE Part E |
| **Optional** | Second Render service (public demo) | ≈ US$13 / month | The live demo on azelitech.com | GO-LIVE Part G |
| **Later, optional** | Google Play / Apple App Store | US$25 once / US$99 a year | Store listings for the app | Section 1 above |

**Suggested order:** backups and email first (they protect the data and tell you when something fails), then Pesapal, then Channex, then WhatsApp, then the AI.

---

## 4. Settings for the beta (Render → each hotel's PMS → Environment)

| Key | Value | Why |
|---|---|---|
| `PUBLIC_URL` | `https://amaya.azelitech.com` | Payments, links in emails, the go-live checklist |
| `SUPPORT_EMAIL` | `support@azelitech.com` (or your own) | Staff feedback emailed to Azeli |
| `BACKUP_KEY`, `BACKUP_S3_*` | see GO-LIVE Part C | Nightly backups |
| `EMAIL_TRANSPORT`, `SMTP_URL`, `EMAIL_FROM` | see GO-LIVE Part B | Sending email |

Render sets `RENDER_GIT_COMMIT` itself; the app shows it next to the version number (e.g. *Version 0.9.0+a1b2c3d*) so a report always says exactly which version it came from.
