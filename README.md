# Hearth & Key: Hospitality Consulting Website

Static multi-page site for a hospitality marketing consultancy (hotels & restaurants).
No build step: open `index.html` in a browser, or host the folder on Netlify, Vercel, GitHub Pages or any web host.

## Pages
- `index.html`: Home (intro, services overview, who we help, case study teaser)
- `services.html`: all nine services in detail; each has its own link, e.g. `services.html#seo-geo`
- `work.html`: Amaya Hotel & Luxury Suites case study
- `how-we-work.html`: four-step process and FAQ
- `packages.html`: Essentials / Growth / Signature
- `contact.html`: free-audit request form

The header and footer are repeated on every page. When you change a menu link, update it on all six pages.

## Shared files
- `styles.css`: design; brand colours and fonts are variables at the top (`:root`)
- `script.js`: mobile menu, scroll animations, contact form

## Quick customisation
- **Brand name**: search-and-replace `Hearth & Key` / `Hearth &amp; Key` across all `.html` files.
- **Contact details**: email and phone in `contact.html`, plus `CONTACT_EMAIL` in `script.js`.
- **Form delivery**: set `FORM_ENDPOINT` in `script.js` to a Formspree (or similar) URL. Until then the form opens the visitor's email app.
- **Photos**: replace the gradient placeholders `.art-hotel`, `.art-restaurant`, `.case-visual` and `.case-teaser-mark` in `styles.css` with real images.
