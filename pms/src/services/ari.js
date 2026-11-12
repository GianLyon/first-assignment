// Availability, rates & inventory (ARI) change queue.
// Anything that changes what can be sold calls enqueueAri; the channel manager pushes the changes out.
/**
 * @param roomTypeId room type affected, or null for all room types
 * @param from first night affected (YYYY-MM-DD)
 * @param toExclusive day after the last night affected
 */
export async function enqueueAri(db, roomTypeId, from, toExclusive, reason) {
  if (!from || !toExclusive || toExclusive <= from) return;
  await db.query(
    "INSERT INTO ari_outbox (room_type_id, date_from, date_to, reason) VALUES ($1, $2::date, $3::date - 1, $4)",
    [roomTypeId ?? null, from, toExclusive, reason ?? null]);
}
/** Queue a long, open-ended change (e.g. a room going out of order) from the business date onward. */
export async function enqueueAriFromToday(db, roomTypeId, reason, days = 365) {
  const { rows: [s] } = await db.query("SELECT to_char(business_date,'YYYY-MM-DD') AS f, to_char(business_date + $1::int,'YYYY-MM-DD') AS t FROM settings WHERE id=1", [days]);
  if (s) await enqueueAri(db, roomTypeId, s.f, s.t, reason);
}
