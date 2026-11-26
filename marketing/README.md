# Azeli marketing material

## Business card (`business-card/`)

- `azeli-business-card-print.pdf`: **send this file to the printer.** It has 2 pages (front and back) at 91 × 61 mm, which is the 85 × 55 mm card plus 3 mm bleed on every side. Ask for 350–400 gsm matt card, printed both sides; matt lamination is optional.
- `azeli-business-card-front.png` and `azeli-business-card-back.png`: previews at the final size, for WhatsApp or social media.
- The QR code opens azelitech.com/contact.html.
- To change the name, title or phone, edit `CARD` at the top of `build.mjs` and rebuild:
  `TOOLS=<node_modules with qrcode and @fontsource/ibm-plex-sans + ibm-plex-mono> node marketing/business-card/build.mjs`

## Outreach email (`email/azeli-outreach.html`)

A 600 px email built from tables with inline styles, so it looks the same in Zoho, Gmail, Outlook and on phones. The charts are coloured HTML bars rather than images, so email apps can't block them. The logo loads from `https://azelitech.com/images/brand/azeli-email-logo.png`, which goes live once this branch is merged and Vercel deploys.

Before each send, replace **[First name]** and **[Hotel name]** (each appears a few times; use the editor's find and replace).

### Save it as a template in Zoho Mail

1. Open `azeli-outreach.html` in Notepad (or any text editor), select all and copy.
2. Zoho Mail → **New Mail** → click the **⋯ (more)** button in the editor toolbar → **Insert HTML** → paste → **Insert**.
3. Subject: `[Hotel name] + Azeli: one system for rooms, F&B and direct bookings`
4. In the compose window open the **⋯ / Templates** menu → **Save as template**, and name it "Hotel outreach".
5. Next time: **New Mail** → **Templates** → "Hotel outreach", then replace [First name] and [Hotel name] and send.

Send from `sales@` or your own `@azelitech.com` address (both use Zoho's DKIM), at most 20–30 personal emails a day. For larger lists, use Zoho Campaigns or Brevo with the same HTML.

The example figures are worked out from: 30 rooms × 60% occupancy × 30 nights × UGX 250,000 = UGX 135M a month in room revenue, with 17% commission on the OTA share.
