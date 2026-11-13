// Optional: email the team when a website enquiry arrives (set SMTP_URL and LEAD_NOTIFY).
import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport = null;
let override = null;
export const setMailer = (fn) => { override = fn; };

export async function notifyLead(l) {
  if (!config.leadNotify.length || (!config.smtpUrl && !override)) return;
  const text = [`New enquiry ${l.ref} from the website`, '', `Name: ${l.name}`, `Business: ${l.business}${l.business_type ? ` (${l.business_type})` : ''}`, `Email: ${l.email}`,
    l.phone ? `Phone: ${l.phone}` : '', l.package ? `Package: ${l.package}` : '', l.services.length ? `Interested in: ${l.services.join(', ')}` : '', '', l.message || '', '', 'Open the Azeli Console to reply and track it.'].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
  const msg = { from: config.emailFrom, to: config.leadNotify.join(', '), replyTo: l.email, subject: `New enquiry: ${l.business} (${l.ref})`, text };
  if (override) return override(msg);
  transport ??= nodemailer.createTransport(config.smtpUrl, { disableFileAccess: true, disableUrlAccess: true });
  return transport.sendMail({ ...msg, disableFileAccess: true, disableUrlAccess: true });
}

/** A client hotel's system went offline, or came back. */
export async function notifyStatus(client, online, detail) {
  const to = config.alertEmails.length ? config.alertEmails : config.leadNotify;
  if (!to.length || (!config.smtpUrl && !override)) return;
  const msg = { from: config.emailFrom, to: to.join(', '),
    subject: online ? `Back online: ${client.name}` : `OFFLINE: ${client.name}'s Azeli PMS`,
    text: online ? `${client.name}'s system (${client.pms_url}) is answering again.` : `${client.name}'s system (${client.pms_url}) is not answering.\n\n${detail}\n\nCheck Render (azeli-pms service of this hotel: Events and Logs) and the hotel's internet.` };
  if (override) return override(msg);
  transport ??= nodemailer.createTransport(config.smtpUrl, { disableFileAccess: true, disableUrlAccess: true });
  return transport.sendMail({ ...msg, disableFileAccess: true, disableUrlAccess: true });
}
