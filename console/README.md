# Azeli Console

The Azeli Technologies admin panel (`admin.azelitech.com`):

- **Enquiries**: every contact / free-audit request from azelitech.com, with status (new → contacted → proposal → won / lost), who handles it, follow-up date, expected fee and notes. Optional email alert to the team.
- **Website**: edit contact details, announcement banner, homepage headline, packages (with optional prices), the Amaya case-study results and quote, and the Google title and description. Changes are saved as drafts; **Publish** rebuilds the website on Vercel. The website build (`scripts/build-site.mjs`) writes the content into the HTML, so search engines see it.
- **Client hotels**: every hotel running Azeli PMS, checked every 10 minutes (online or not), this month's occupancy and revenue (with the hotel's group access key), package and monthly fee.
- **Team**: owner, website editor and sales roles; activity log.

Run locally: PostgreSQL, then `npm install`, then
`OWNER_EMAIL=you@example.com OWNER_PASSWORD=choose-a-strong-one npm start` → http://localhost:3300

Tests: `npm test` (database `azeli_console_test`). Deployment: see `../docs/GO-LIVE.md`.
