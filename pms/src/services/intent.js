// Phase 17: intent signals in WhatsApp. Reads a guest's own messages and works out, as they come in:
//  - stage: explorer (just looking) → interested → buyer (comparing specifics) → ready (asking to book or pay)
//  - score: how likely they are to book (0–100)
//  - confidence: how sure the reading is (more messages and clearer signals = higher)
//  - depth: how specific they are (dates, party, room, price, payment, logistics)
//  - signals: what was seen, with the words that showed it, and when purchase intent first appeared
// Plain rules, so it runs on every message for free and staff can see why. English with common Ugandan phrasing.

const RULES = [
  // [key, label, weight, category, regex]  category feeds depth
  ['book', 'Asked to book or reserve', 22, 'commit', /\b(book|reserve|reservation|confirm (it|the room|my)|i('| a)?ll take|we('| wi)?ll take|hold (it|the room|a room)|lock (it|in)|go ahead|sign me up)\b/i],
  ['pay', 'Asked how to pay', 22, 'payment', /\b(pay|payment|deposit|mobile money|momo|mtn money|airtel money|bank (details|account|transfer)|account number|card|visa|invoice|proforma|lpo)\b/i],
  ['dates', 'Gave dates', 14, 'dates', /\b(\d{1,2}(st|nd|rd|th)?\s*(of\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s*\d{1,2}|\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?|tomorrow|tonight|this (weekend|friday|saturday|sunday|week)|next (week|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|from (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i],
  ['nights', 'Said how long', 10, 'dates', /\b(\d+|one|two|three|four|five|six|seven)\s*(night|nights|days|weeks?)\b/i],
  ['party', 'Said who is coming', 12, 'party', /\b(\d+|one|two|three|four|five|six|seven|eight|ten)\s*(adults?|people|persons|pax|guests|kids|children|rooms)\b|\b(my (wife|husband|family|partner|kids|children|team|colleagues)|family of|couple|honeymoon|alone|solo)\b/i],
  ['room', 'Asked about a room type', 8, 'room', /\b(single|double|twin|deluxe|suite|executive|family room|king|queen|standard room|apartment|cottage|view)\b/i],
  ['price', 'Asked the price', 12, 'price', /\b(how much|price|prices|rate|rates|cost|charges|per night|ugx|shs|usd|\$|discount|offer|deal|cheaper|best rate|corporate rate|negotiat)/i],
  ['availability', 'Asked if rooms are free', 12, 'room', /\b(available|availability|do you have (a )?(room|space|vacanc)|any rooms?|vacanc|free rooms?|fully booked)\b/i],
  ['logistics', 'Asked about arrival or extras', 8, 'logistics', /\b(airport|pick ?up|pickup|transfer|check[- ]?in|check[- ]?out|directions|location pin|parking|breakfast|early arrival|late arrival|conference|meeting room|wifi)\b/i],
  ['urgency', 'Needs it soon', 10, 'dates', /\b(today|tonight|asap|urgent|right now|immediately|this evening|in an hour)\b/i],
  ['corporate', 'Booking for a company', 8, 'payment', /\b(company|organisation|organization|ngo|ministry|bill (us|the company)|on account|tin)\b/i],
  // explorer signals pull the score down
  ['vague', 'Only looking for now', -12, null, /\b(just (asking|checking|looking|enquiring)|maybe|not sure|some ?time|later|next year|in future|thinking about|planning to|still deciding)\b/i],
  ['general', 'General questions only', -6, null, /\b(where are you|location\??$|photos?|pictures?|website|brochure|what do you offer|tell me (more )?about)\b/i],
  ['compare', 'Comparing with other hotels', -4, null, /\b(other hotels?|elsewhere|compare|cheaper (place|hotel)|found (a )?cheaper)\b/i],
];
const PURCHASE = new Set(['book', 'pay']);
const DEPTH_CATS = ['dates', 'party', 'room', 'price', 'payment', 'logistics'];
const quote = (t, re) => { const m = t.match(re); if (!m) return ''; const i = Math.max(0, m.index - 30); return (i > 0 ? '…' : '') + t.slice(i, m.index + m[0].length + 30).trim() + (m.index + m[0].length + 30 < t.length ? '…' : ''); };

/** Read inbound messages (oldest first) and return the reading. `history` adds what is known about the person. */
export function analyse(messages, { returning = false, repliedAfterPrice = false } = {}) {
  const inbound = messages.filter((m) => m.direction === 'in' && m.body);
  const signals = [], seen = new Set();
  let firstPurchaseAt = null;
  for (const m of inbound) {
    for (const [key, label, weight, cat, re] of RULES) {
      if (!re.test(m.body)) continue;
      if (PURCHASE.has(key) && !firstPurchaseAt) firstPurchaseAt = m.created_at;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({ key, label, weight, cat, quote: quote(m.body, re).slice(0, 140), at: m.created_at });
    }
  }
  if (returning) signals.push({ key: 'returning', label: 'Has stayed before', weight: 10, cat: null, quote: '' });
  if (repliedAfterPrice) signals.push({ key: 'replied_after_price', label: 'Kept talking after hearing the price', weight: 10, cat: null, quote: '' });
  // engagement: more messages and more words = more serious, up to a point
  const words = inbound.reduce((a, m) => a + String(m.body).split(/\s+/).length, 0);
  const engagement = Math.min(12, inbound.length * 2 + Math.floor(words / 25));
  if (engagement >= 6) signals.push({ key: 'engaged', label: `Engaged (${inbound.length} messages)`, weight: engagement, cat: null, quote: '' });
  const raw = signals.reduce((a, s) => a + s.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const depthCats = new Set(signals.map((s) => s.cat).filter(Boolean));
  const depth = Math.round((DEPTH_CATS.filter((c) => depthCats.has(c)).length / DEPTH_CATS.length) * 100);
  const positive = signals.filter((s) => s.weight > 0).length;
  const confidence = Math.max(15, Math.min(95, 20 + positive * 9 + Math.min(inbound.length, 8) * 4 - (signals.some((s) => s.weight < 0) && positive > 2 ? 10 : 0)));
  const purchase = signals.some((s) => PURCHASE.has(s.key));
  const stage = purchase && score >= 45 ? 'ready' : score >= 40 && depth >= 50 ? 'buyer' : score >= 10 ? 'interested' : 'explorer';
  return { stage, score, confidence, depth, signals: signals.map(({ cat, ...s }) => s).sort((a, b) => b.weight - a.weight), first_purchase_signal_at: firstPurchaseAt };
}

/** Work out and store the reading for one conversation, from the last two weeks of messages. */
export async function refreshIntent(db, conversationId) {
  const { rows: msgs } = await db.query(`SELECT direction, body, created_at FROM wa_messages WHERE conversation_id=$1 AND created_at > now() - interval '14 days' ORDER BY id LIMIT 200`, [conversationId]);
  if (!msgs.some((m) => m.direction === 'in')) return null;
  const { rows: [c] } = await db.query(`SELECT c.guest_id, EXISTS (SELECT 1 FROM reservations r WHERE r.guest_id=c.guest_id AND r.status IN ('checked_out','in_house')) AS returning FROM wa_conversations c WHERE c.id=$1`, [conversationId]);
  // did they keep writing after we sent a price?
  const priceAt = msgs.findIndex((m) => m.direction === 'out' && /\b(ugx|shs|usd|per night|price|rate)\b|\d{2,3},\d{3}/i.test(m.body || ''));
  const repliedAfterPrice = priceAt >= 0 && msgs.slice(priceAt + 1).some((m) => m.direction === 'in');
  const r = analyse(msgs, { returning: !!c?.returning, repliedAfterPrice });
  await db.query(`INSERT INTO wa_intents (conversation_id, stage, score, confidence, depth, signals, first_purchase_signal_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (conversation_id) DO UPDATE SET stage=EXCLUDED.stage, score=EXCLUDED.score, confidence=EXCLUDED.confidence, depth=EXCLUDED.depth, signals=EXCLUDED.signals,
      first_purchase_signal_at=COALESCE(wa_intents.first_purchase_signal_at, EXCLUDED.first_purchase_signal_at), updated_at=now()`,
  [conversationId, r.stage, r.score, r.confidence, r.depth, JSON.stringify(r.signals), r.first_purchase_signal_at]);
  return r;
}
export const STAGE_LABEL = { explorer: 'Explorer', interested: 'Interested', buyer: 'Buyer', ready: 'Ready to book' };
