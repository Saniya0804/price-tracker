-- Run this in Supabase SQL editor (Project -> SQL Editor -> New query)

-- Cached copy of the store's product listing (the store has no search of
-- its own and is JS-rendered with no server-side filtering, so search reads
-- this cache instead of re-crawling 50 pages on every keystroke).
create table if not exists catalog (
  id bigint generated always as identity primary key,
  name text not null,
  sku text,
  brand text,
  category text,
  product_url text not null unique,
  updated_at timestamptz not null default now()
);

create index if not exists idx_catalog_name on catalog using gin (to_tsvector('english', name));

create table if not exists products (
  id bigint generated always as identity primary key,
  name text not null,
  sku text,
  brand text,
  category text,
  product_url text not null unique,
  scrape_interval_minutes int not null default 120, -- bonus: configurable per-product frequency
  created_at timestamptz not null default now()
);

create table if not exists price_history (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  price numeric,
  original_price numeric,
  in_stock boolean,
  stock_count int,
  scraped_at timestamptz not null default now()
);

create table if not exists scrape_logs (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  attempt_number int not null default 1,
  status text not null check (status in ('success','retried','failed')),
  http_status int,
  duration_ms int,
  error_message text
);

create index if not exists idx_price_history_product on price_history(product_id, scraped_at desc);
create index if not exists idx_scrape_logs_product on scrape_logs(product_id, attempted_at desc);

-- The backend uses Supabase's service_role key. These grants make a fresh
-- project usable without manually repairing table permissions in the dashboard.
grant usage on schema public to service_role;
grant select, insert, update, delete on table catalog, products, price_history, scrape_logs to service_role;
grant usage, select on all sequences in schema public to service_role;
