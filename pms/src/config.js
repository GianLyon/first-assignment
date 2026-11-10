// Configuration from environment variables (see .env.example).
const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://hk:hk_dev_pw@localhost:5432/hk_pms',
  production: env.NODE_ENV === 'production',
  sessionHours: Number(env.SESSION_HOURS || 12),
};
