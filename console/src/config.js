// Configuration from environment variables.
const env = process.env;
const list = (v, d) => String(v || d).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

export const config = {
  port: Number(env.PORT || 3300),
  databaseUrl: env.DATABASE_URL || 'postgres://hk:hk_dev_pw@localhost:5432/azeli_console',
  production: env.NODE_ENV === 'production',
  sessionHours: Number(env.SESSION_HOURS || 12),
  trustProxy: /^\d+$/.test(env.TRUST_PROXY || '') ? Number(env.TRUST_PROXY) : 'loopback',
  // websites allowed to send enquiries and read published content
  siteOrigins: list(env.SITE_ORIGINS, 'https://azelitech.com,https://www.azelitech.com'),
  // Vercel deploy hook: Publish rebuilds the website with the new content
  deployHook: env.VERCEL_DEPLOY_HOOK || '',
  // first owner account, created on the first start
  ownerEmail: (env.OWNER_EMAIL || '').trim().toLowerCase(),
  ownerPassword: env.OWNER_PASSWORD || '',
  ownerName: (env.OWNER_NAME || 'Owner').trim().slice(0, 120),
  // optional: email the team when an enquiry arrives
  smtpUrl: env.SMTP_URL || '',
  emailFrom: env.EMAIL_FROM || 'Azeli Console <console@azelitech.com>',
  leadNotify: list(env.LEAD_NOTIFY, ''),
  // who is emailed when a client hotel's system goes down (defaults to LEAD_NOTIFY)
  alertEmails: list(env.ALERT_EMAIL, ''),
};
