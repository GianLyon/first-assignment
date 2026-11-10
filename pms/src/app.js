import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, loadUser } from './auth.js';
import { apiRouter } from './routes/api.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
    next();
  });

  // Cross-site request guard: state-changing API calls must be JSON (browsers cannot send that cross-site without CORS).
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Requests must be sent as JSON.');
    }
    next();
  });
  app.use('/api', express.json({ limit: '100kb' }));
  app.use('/api', loadUser(pool));
  app.use('/api', apiRouter(pool));
  app.use('/api', (_req, _res) => { throw new HttpError(404, 'Not found.'); });

  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: '1h' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || 500, message = err.message, details = err.details;
    if (err.code === '23505') { status = 409; message = 'That conflicts with an existing record (for example, a duplicate number or a room that is already occupied).'; }
    else if (err.code === '23503') { status = 400; message = 'A referenced record does not exist.'; }
    else if (err.code === '22P02' || err.code === '22007' || err.code === '22008') { status = 400; message = 'One of the values is not valid.'; }
    else if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON.'; }
    if (status >= 500) { console.error(err); message = status === 500 && !err.status ? 'Something went wrong. Please try again.' : message; }
    res.status(status).json({ error: message, ...(details ? { details } : {}) });
  });
  return app;
}
