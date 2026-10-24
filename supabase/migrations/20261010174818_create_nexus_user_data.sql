-- RECONSTRUCTED migration baseline.
-- The original file was absent from repository history. This version is based on
-- the schema and owner-only RLS policy contract documented in README.md.
-- The matching version is already recorded in the remote migration history;
-- this file restores local history alignment and must not be treated as proof
-- that any live database has this exact schema.
create table if not exists public.nexus_user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.nexus_user_data enable row level security;

drop policy if exists "Users can read own Nexus backup" on public.nexus_user_data;
drop policy if exists "Users can insert own Nexus backup" on public.nexus_user_data;
drop policy if exists "Users can update own Nexus backup" on public.nexus_user_data;

create policy "Users can read own Nexus backup"
  on public.nexus_user_data
  for select
  using (auth.uid() = user_id);

create policy "Users can insert own Nexus backup"
  on public.nexus_user_data
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update own Nexus backup"
  on public.nexus_user_data
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
