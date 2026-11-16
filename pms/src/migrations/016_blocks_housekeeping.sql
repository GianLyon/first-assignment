-- Phase 16: dated room blocks (out of order / out of service) and the housekeeping task board

/* A room taken off sale (out of order) or kept on sale with a known issue (out of service) for a period.
   date_to is the first night the room is back (like a departure); NULL = until it is fixed. */
CREATE TABLE room_blocks (
  id            SERIAL PRIMARY KEY,
  room_id       INT NOT NULL REFERENCES rooms(id),
  kind          TEXT NOT NULL DEFAULT 'out_of_order' CHECK (kind IN ('out_of_order','out_of_service')),
  date_from     DATE NOT NULL,
  date_to       DATE,
  category      TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('plumbing','electrical','air_conditioning','furniture','appliance','structure','painting','pest_control','deep_clean','renovation','other')),
  reason        TEXT NOT NULL,
  work_order_id INT REFERENCES work_orders(id),
  created_by    INT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at   TIMESTAMPTZ,
  released_by   INT REFERENCES users(id),
  release_notes TEXT,
  CHECK (date_to IS NULL OR date_to >= date_from)
);
CREATE INDEX room_blocks_room ON room_blocks(room_id, date_from);
CREATE INDEX room_blocks_open ON room_blocks(room_id) WHERE released_at IS NULL;

-- rooms already out of order become open-ended blocks from today, so every block lives in one place
INSERT INTO room_blocks (room_id, kind, date_from, category, reason, work_order_id)
SELECT r.id, 'out_of_order', s.business_date, 'other',
  COALESCE((SELECT w.title FROM work_orders w WHERE w.room_id=r.id AND w.room_out_of_order AND w.status IN ('open','in_progress','on_hold') ORDER BY w.id DESC LIMIT 1), 'Out of order'),
  (SELECT w.id FROM work_orders w WHERE w.room_id=r.id AND w.room_out_of_order AND w.status IN ('open','in_progress','on_hold') ORDER BY w.id DESC LIMIT 1)
FROM rooms r CROSS JOIN settings s WHERE r.hk_status='out_of_order';

/* Housekeeping: the day's rooms to clean, who does each, and how far they are */
CREATE TABLE hk_tasks (
  id            SERIAL PRIMARY KEY,
  business_date DATE NOT NULL,
  room_id       INT NOT NULL REFERENCES rooms(id),
  kind          TEXT NOT NULL CHECK (kind IN ('departure','stayover','vacant_dirty','touch_up')),
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),   -- high: someone arrives in this room type today
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','inspected','skipped')),
  assigned_to   INT REFERENCES users(id),
  started_at    TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,
  done_by       INT REFERENCES users(id),
  inspected_at  TIMESTAMPTZ,
  inspected_by  INT REFERENCES users(id),
  skip_reason   TEXT,                                   -- do not disturb, guest declined service …
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_date, room_id)
);
CREATE INDEX hk_tasks_user ON hk_tasks(business_date, assigned_to);
