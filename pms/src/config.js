// Configuration from environment variables (see .env.example).
const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://hk:hk_dev_pw@localhost:5432/hk_pms',
  production: env.NODE_ENV === 'production',
  sessionHours: Number(env.SESSION_HOURS || 12),
  // How many proxies sit in front of the app (a hosting platform's load balancer = 1). Needed so the
  // sign-in lockout and rate limits see each visitor's own address rather than the proxy's.
  trustProxy: /^\d+$/.test(env.TRUST_PROXY || '') ? Number(env.TRUST_PROXY) : 'loopback',
  // Set up the property on first start (cloud hosts without a shell). Uses PROPERTY_NAME and ADMIN_PASSWORD.
  autoSeed: env.AUTO_SEED === '1' || env.AUTO_SEED === 'true',
};
