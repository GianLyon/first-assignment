// Email delivery. EMAIL_TRANSPORT=smtp with SMTP_URL sends real mail; the default "test" mode keeps
// messages in the outbox (visible under Scheduled reports) without sending them.
import nodemailer from 'nodemailer';

const env = process.env;
let transport = null;
export const transportInfo = () => {
  const live = env.EMAIL_TRANSPORT === 'smtp' && !!env.SMTP_URL;
  return { live, mode: live ? 'smtp' : 'test', from: env.EMAIL_FROM || 'Azeli PMS <reports@localhost>' };
};
/** Tests can replace delivery with their own function. */
let override = null;
export const setMailer = (fn) => { override = fn; };

export async function sendMail({ to, subject, html, text }) {
  if (override) return override({ to, subject, html, text });
  const info = transportInfo();
  if (!info.live) return { test: true };
  // file and URL access are switched off so message content can never pull in local files or remote URLs
  transport ??= nodemailer.createTransport(env.SMTP_URL, { from: info.from, disableFileAccess: true, disableUrlAccess: true });
  return transport.sendMail({ from: info.from, to, subject, html, text, disableFileAccess: true, disableUrlAccess: true });
}
