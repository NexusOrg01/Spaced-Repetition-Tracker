-- Restored from the SQL statements recorded in production migration history.
-- Keep this file aligned with version 20261010174818; do not apply it manually
-- to production or alter remote migration history as part of this repair.

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
  on public.nexus_user_data for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can insert own Nexus backup"
  on public.nexus_user_data for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users can update own Nexus backup"
  on public.nexus_user_data for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
grant select, insert, update on public.nexus_user_data to authenticated;
revoke all on public.nexus_user_data from anon;
