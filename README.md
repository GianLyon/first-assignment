# Hearth & Key: Hospitality Consulting Website

Static multi-page site for a hospitality marketing consultancy (hotels & restaurants).
No build step: open `index.html` in a browser, or host the folder on Netlify, Vercel, GitHub Pages or any web host.

## Pages
- `index.html`: Home (intro, services overview, who we help, case study teaser)
- `services.html`: all eleven services in detail (intro, why it matters, what's included, illustration); each has its own link, e.g. `services.html#menu-design`
- `work.html`: Amaya Hotel & Luxury Suites case study and photo gallery (see `images/amaya/README.md` for photo file names)
- `how-we-work.html`: four-step process and FAQ
- `pms.html`: Hearth & Key PMS, the all-in-one hotel management system (front office, booking engine, POS, inventory, HR, accounting, assets, events)
- `packages.html`: Essentials / Growth / Signature
- `contact.html`: free-audit request form

The header and footer are repeated on every page. When you change a menu link, update it on all seven pages.

## Shared files
- `styles.css`: design; brand colours and fonts are variables at the top (`:root`)
- `script.js`: mobile menu, scroll animations, contact form

## Quick customisation
- **Brand name**: search-and-replace `Hearth & Key` / `Hearth &amp; Key` across all `.html` files.
- **Contact details**: phone is +27 78 709 4814 (also WhatsApp). Email and phone appear in `contact.html` and every page footer, plus `CONTACT_EMAIL` in `script.js`.
- **Form delivery**: set `FORM_ENDPOINT` in `script.js` to a Formspree (or similar) URL. Until then the form opens the visitor's email app.
- **Illustrations**: the OTA, Google, Meta and other service visuals are HTML/CSS mock-ups (class `mock`). Replace any with a real screenshot if you prefer.
- **Photos**: replace the gradient placeholders `.art-hotel`, `.art-restaurant`, `.case-visual` and `.case-teaser-mark` in `styles.css` with real images.
