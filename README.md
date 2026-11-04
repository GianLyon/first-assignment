# Hearth & Key: Hospitality Consulting Website

Static one-page site for a hospitality marketing consultancy (hotels & restaurants).
No build step: open `index.html` in a browser, or host the folder on Netlify, Vercel, GitHub Pages or any web host.

## Files
- `index.html`: page content (hero, services, who we help, process, packages, FAQ, contact)
- `styles.css`: design; brand colours and fonts are variables at the top (`:root`)
- `script.js`: mobile menu, scroll animations, contact form

## Quick customisation
- **Brand name**: search-and-replace `Hearth & Key` / `Hearth &amp; Key` in `index.html`.
- **Contact details**: email and phone in the contact section, plus `CONTACT_EMAIL` in `script.js`.
- **Form delivery**: set `FORM_ENDPOINT` in `script.js` to a Formspree (or similar) URL. Until then the form opens the visitor's email app.
- **Photos**: replace the gradient placeholders `.art-hotel` / `.art-restaurant` in `styles.css` with real images.
