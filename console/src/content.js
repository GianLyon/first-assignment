// Editable website content. Defaults equal what the website shows today, so publishing
// without changes never alters the site. The website build (scripts/build-site.mjs) applies it.
import { HttpError } from './auth.js';

export const DEFAULTS = {
  contact: { email: 'hello@azelitech.com', phone: '+27787094814', phone_display: '+27 78 709 4814', whatsapp: '27787094814' },
  announcement: { active: false, text: '', link_text: '', link_url: '' },
  hero: {
    eyebrow: 'Hospitality marketing consultants',
    title: 'Fuller rooms. Busier tables.',
    title_accent: 'More bookings that are yours.',
    lead: 'We help hotels, guesthouses and restaurants get found, look their best and convert lookers into guests, from OTA listings, channel management, photography and menu design to SEO, paid ads, CRM and sales reporting.',
  },
  packages: {
    items: [
      { name: 'Essentials', tagline: 'Get visible & look great', price: '', featured: false, badge: '',
        features: ['OTA listing set-up & optimisation', '**Azeli PMS included**', 'Professional photo shoot', 'Channel manager set-up & parity check', 'Google Business Profile tune-up', 'Monthly sales & performance snapshot'] },
      { name: 'Growth', tagline: 'Drive direct bookings', price: '', featured: true, badge: 'Most popular',
        features: ['Everything in Essentials', '**Azeli PMS included**', 'Website build or rebuild + maintenance', 'Paid advertising (Google, Meta & more)', 'SEO & GEO', 'Social media management', 'Menu design (restaurants & hotel dining)', 'Monthly sales report & strategy call'] },
      { name: 'Signature', tagline: 'Your outsourced marketing department', price: '', featured: false, badge: '',
        features: ['Everything in Growth', '**Azeli PMS included**', 'CRM & email marketing automation', 'Reservation management', 'Full sales reporting: revenue, channels & forecasts', 'Sales support: corporate, groups & events', 'Quarterly content shoots', 'Dedicated account manager'] },
    ],
  },
  case_study: {
    results: [{ value: '[+00%]', label: 'Direct bookings' }, { value: '[+00%]', label: 'OTA conversion' }, { value: '[0.0×]', label: 'Return on ad spend' }, { value: '[0.0★]', label: 'Average guest rating' }],
    quote: '[Add a short quote from the Amaya team about working with us.]',
    cite: '[Name], [Role], Amaya Hotel & Luxury Suites',
  },
  seo: {
    home_title: 'Azeli Technologies | Hospitality Marketing Consultants for Hotels & Restaurants',
    home_description: 'Azeli Technologies helps hotels and restaurants fill rooms and tables: OTA optimisation, channel and reservation management, photography, menu design, websites, SEO & GEO, paid advertising, CRM & email marketing and sales reporting.',
  },
};
export const SECTIONS = {
  contact: 'Contact details', announcement: 'Announcement banner', hero: 'Homepage headline',
  packages: 'Packages', case_study: 'Amaya case study', seo: 'Search engines (homepage)',
};

const str = (v, field, { max = 200, required = false } = {}) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (at most ${max} characters).`);
  if (/[<>]/.test(s)) throw new HttpError(400, `${field} cannot contain < or >.`);
  return s;
};
const link = (v, field) => {
  const s = str(v, field, { max: 300 });
  if (s && !/^(https:\/\/[^\s]+|[a-z0-9-]+\.html(#[\w-]+)?(\?[\w=&-]+)?|#[\w-]+)$/i.test(s)) throw new HttpError(400, `${field} must be a page such as contact.html or a full https:// address.`);
  return s;
};

/** Check and tidy one section; throws a clear message for anything wrong. */
export function validate(section, v = {}) {
  switch (section) {
    case 'contact': {
      const email = str(v.email, 'Email', { required: true, max: 120 }).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new HttpError(400, 'Enter a valid email address.');
      const phone = str(v.phone, 'Phone', { required: true, max: 20 }).replace(/[\s()-]/g, '');
      if (!/^\+\d{8,15}$/.test(phone)) throw new HttpError(400, 'Phone must be in international form, e.g. +256700123456.');
      const whatsapp = str(v.whatsapp, 'WhatsApp number', { required: true, max: 20 }).replace(/\D/g, '');
      if (!/^\d{8,15}$/.test(whatsapp)) throw new HttpError(400, 'WhatsApp number: digits with country code, e.g. 256700123456.');
      return { email, phone, phone_display: str(v.phone_display, 'Phone as shown', { required: true, max: 30 }), whatsapp };
    }
    case 'announcement': {
      const active = v.active === true;
      const text = str(v.text, 'Message', { max: 160, required: active });
      const link_url = link(v.link_url, 'Link');
      return { active, text, link_text: str(v.link_text, 'Link text', { max: 40, required: !!link_url }), link_url };
    }
    case 'hero':
      return { eyebrow: str(v.eyebrow, 'Small heading', { max: 60, required: true }), title: str(v.title, 'Headline', { max: 80, required: true }),
        title_accent: str(v.title_accent, 'Headline (gold part)', { max: 80 }), lead: str(v.lead, 'Introduction', { max: 400, required: true }) };
    case 'packages': {
      const items = Array.isArray(v.items) ? v.items : [];
      if (items.length < 1 || items.length > 4) throw new HttpError(400, 'Show between 1 and 4 packages.');
      const names = new Set();
      const out = items.map((p, i) => {
        const name = str(p.name, `Package ${i + 1} name`, { max: 30, required: true });
        if (!/^[\w ]+$/.test(name)) throw new HttpError(400, `Package name "${name}": letters, numbers and spaces only.`);
        if (names.has(name.toLowerCase())) throw new HttpError(400, 'Package names must be different.');
        names.add(name.toLowerCase());
        const features = (Array.isArray(p.features) ? p.features : String(p.features || '').split('\n')).map((f) => str(f, `${name}: feature`, { max: 120 })).filter(Boolean);
        if (!features.length || features.length > 12) throw new HttpError(400, `${name}: list between 1 and 12 features.`);
        return { name, tagline: str(p.tagline, `${name}: tagline`, { max: 60 }), price: str(p.price, `${name}: price`, { max: 60 }),
          featured: p.featured === true, badge: str(p.badge, `${name}: badge`, { max: 20 }), features };
      });
      if (out.filter((p) => p.featured).length > 1) throw new HttpError(400, 'Highlight at most one package.');
      return { items: out };
    }
    case 'case_study': {
      const results = (Array.isArray(v.results) ? v.results : []).slice(0, 4);
      if (results.length !== 4) throw new HttpError(400, 'Enter four results.');
      return { results: results.map((r, i) => ({ value: str(r.value, `Result ${i + 1}`, { max: 12, required: true }), label: str(r.label, `Result ${i + 1} label`, { max: 40, required: true }) })),
        quote: str(v.quote, 'Quote', { max: 400, required: true }), cite: str(v.cite, 'Quote by', { max: 120, required: true }) };
    }
    case 'seo':
      return { home_title: str(v.home_title, 'Page title', { max: 70, required: true }), home_description: str(v.home_description, 'Description', { max: 170, required: true }) };
    default: throw new HttpError(404, 'Unknown section.');
  }
}
