-- Phase 22: grouping room types (e.g. Serviced apartments / Hotel rooms) and naming the building a room is in.
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS category TEXT CHECK (category IS NULL OR length(category) <= 60);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS building TEXT CHECK (building IS NULL OR length(building) <= 60);
-- finding the bookings that hold a room quickly (rooms given before arrival)
CREATE INDEX IF NOT EXISTS reservations_room_held_idx ON reservations(room_id, arrival, departure) WHERE status IN ('reserved','in_house');
