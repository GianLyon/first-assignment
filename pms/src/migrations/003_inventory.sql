-- Phase 3: Inventory, purchasing, requisitions, recipes and stock counts

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','front_office','housekeeping','accountant','night_auditor','waiter','kitchen','storekeeper'));

INSERT INTO accounts (code, name, type) VALUES
  ('1300', 'Inventory', 'asset'),
  ('2000', 'Accounts payable (suppliers)', 'liability'),
  ('5000', 'Cost of sales: food & beverage', 'expense'),
  ('5100', 'Departmental supplies', 'expense'),
  ('5900', 'Stock variances & wastage', 'expense')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE stores (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  kind   TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('main','kitchen','bar','housekeeping','maintenance','other')),
  active BOOLEAN NOT NULL DEFAULT TRUE
);
-- Which store a POS outlet sells from (recipe ingredients are deducted here)
ALTER TABLE outlets ADD COLUMN stock_store_id INT REFERENCES stores(id);

CREATE TABLE stock_items (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL,                       -- kg, litre, bottle, piece…
  category      TEXT NOT NULL DEFAULT 'General',
  reorder_level NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  avg_cost      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),  -- weighted average cost per unit (UGX)
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE stock_balances (
  item_id  INT NOT NULL REFERENCES stock_items(id),
  store_id INT NOT NULL REFERENCES stores(id),
  qty      NUMERIC(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, store_id)
);

CREATE TABLE stock_movements (
  id            BIGSERIAL PRIMARY KEY,
  business_date DATE NOT NULL,
  item_id       INT NOT NULL REFERENCES stock_items(id),
  store_id      INT NOT NULL REFERENCES stores(id),
  qty           NUMERIC(14,3) NOT NULL CHECK (qty <> 0),   -- + in, - out
  unit_cost     NUMERIC(14,2) NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('receipt','opening','transfer_in','transfer_out','issue','sale','count','write_off')),
  ref_type      TEXT,
  ref_id        TEXT,
  note          TEXT,
  user_id       INT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_item_idx ON stock_movements(item_id, created_at DESC);
CREATE INDEX stock_movements_date_idx ON stock_movements(business_date);

CREATE TABLE suppliers (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  contact TEXT,
  phone   TEXT,
  email   TEXT,
  tin     TEXT,
  active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE SEQUENCE po_code_seq START 1001;
CREATE TABLE purchase_orders (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE DEFAULT ('PO' || nextval('po_code_seq')),
  supplier_id   INT NOT NULL REFERENCES suppliers(id),
  store_id      INT NOT NULL REFERENCES stores(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','partly_received','received','cancelled')),
  expected_date DATE,
  notes         TEXT,
  created_by    INT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   INT REFERENCES users(id),
  approved_at   TIMESTAMPTZ
);
CREATE TABLE purchase_order_lines (
  id           SERIAL PRIMARY KEY,
  po_id        INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id      INT NOT NULL REFERENCES stock_items(id),
  qty          NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost    NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
  received_qty NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0)
);

CREATE SEQUENCE grn_code_seq START 1001;
CREATE TABLE goods_received (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE DEFAULT ('GRN' || nextval('grn_code_seq')),
  supplier_id      INT REFERENCES suppliers(id),        -- NULL for opening stock
  store_id         INT NOT NULL REFERENCES stores(id),
  po_id            INT REFERENCES purchase_orders(id),
  is_opening       BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_ref      TEXT,
  business_date    DATE NOT NULL,
  total            BIGINT NOT NULL,
  received_by      INT REFERENCES users(id),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  CHECK (is_opening OR supplier_id IS NOT NULL)
);
CREATE TABLE goods_received_lines (
  id         SERIAL PRIMARY KEY,
  grn_id     INT NOT NULL REFERENCES goods_received(id),
  item_id    INT NOT NULL REFERENCES stock_items(id),
  po_line_id INT REFERENCES purchase_order_lines(id),
  qty        NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost  NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0)
);

CREATE SEQUENCE req_code_seq START 1001;
CREATE TABLE requisitions (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE DEFAULT ('RQ' || nextval('req_code_seq')),
  department    TEXT NOT NULL,
  from_store_id INT NOT NULL REFERENCES stores(id),
  to_store_id   INT REFERENCES stores(id),               -- NULL = used up by the department (expensed)
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','issued','rejected','cancelled')),
  notes         TEXT,
  business_date DATE NOT NULL,
  requested_by  INT REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   INT REFERENCES users(id),
  approved_at   TIMESTAMPTZ,
  issued_by     INT REFERENCES users(id),
  issued_at     TIMESTAMPTZ,
  reject_reason TEXT,
  total_cost    BIGINT,
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  CHECK (to_store_id IS NULL OR to_store_id <> from_store_id)
);
CREATE INDEX requisitions_status_idx ON requisitions(status);
CREATE TABLE requisition_lines (
  id            SERIAL PRIMARY KEY,
  req_id        INT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  item_id       INT NOT NULL REFERENCES stock_items(id),
  qty_requested NUMERIC(14,3) NOT NULL CHECK (qty_requested > 0),
  qty_approved  NUMERIC(14,3) CHECK (qty_approved >= 0),
  qty_issued    NUMERIC(14,3) CHECK (qty_issued >= 0),
  unit_cost     NUMERIC(14,2)
);

-- Ingredients used per portion of a menu item
CREATE TABLE recipe_lines (
  menu_item_id INT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  item_id      INT NOT NULL REFERENCES stock_items(id),
  qty          NUMERIC(14,4) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (menu_item_id, item_id)
);

CREATE TABLE stock_counts (
  id             SERIAL PRIMARY KEY,
  store_id       INT NOT NULL REFERENCES stores(id),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','cancelled')),
  business_date  DATE NOT NULL,
  notes          TEXT,
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by      INT REFERENCES users(id),
  posted_at      TIMESTAMPTZ,
  variance_value BIGINT
);
CREATE UNIQUE INDEX one_open_count_per_store ON stock_counts(store_id) WHERE status = 'open';
CREATE TABLE stock_count_lines (
  count_id     INT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id      INT NOT NULL REFERENCES stock_items(id),
  expected_qty NUMERIC(14,3) NOT NULL,     -- system quantity when the count started
  counted_qty  NUMERIC(14,3) CHECK (counted_qty >= 0),
  posted_qty   NUMERIC(14,3),              -- system quantity when posted (difference is based on this)
  PRIMARY KEY (count_id, item_id)
);

-- Inventory cost postings on POS bills (one per settled bill)
ALTER TABLE pos_checks ADD COLUMN cost_of_sales BIGINT;
