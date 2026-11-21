CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  whats TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'cliente',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL DEFAULT 'system',
  brand TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0,
  freight_usd REAL NOT NULL DEFAULT 0,
  weight_kg REAL NOT NULL DEFAULT 0.3,
  margin_pct REAL NOT NULL DEFAULT 25,
  ncm TEXT NOT NULL DEFAULT '',
  hub TEXT NOT NULL DEFAULT 'US',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_title TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  hub TEXT NOT NULL,
  hub_snapshot TEXT NOT NULL DEFAULT '',
  total_brl REAL NOT NULL,
  frete_brl REAL NOT NULL,
  impostos_brl REAL NOT NULL,
  fx_usd_brl REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  agent_pay TEXT,
  tracking TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS hubs (
  country TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  street TEXT NOT NULL,
  suite TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  phone TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
