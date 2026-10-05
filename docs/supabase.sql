-- Run once in Supabase -> SQL Editor. Tables are only reachable through the
-- server-side secret key (api/store/*); RLS is on with no policies, so the
-- public publishable key can read/write nothing.

create table if not exists public.watchlists (
  fyers_id   text primary key,
  symbols    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.strategies (
  id         uuid primary key default gen_random_uuid(),
  fyers_id   text not null,
  name       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists strategies_fyers_id_idx on public.strategies (fyers_id, updated_at desc);

alter table public.watchlists enable row level security;
alter table public.strategies enable row level security;
