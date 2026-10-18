-- Nexus Community Syllabus Wishlist
-- Run once in Supabase Dashboard -> SQL Editor for project txugbdavblpettcnhcxl.
create extension if not exists pgcrypto;

create table if not exists public.nexus_syllabus_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  category text not null check (char_length(category) between 1 and 100),
  topics text not null default '' check (char_length(topics) <= 3000),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.nexus_syllabus_votes (
  request_id uuid not null references public.nexus_syllabus_requests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

create index if not exists nexus_syllabus_requests_created_at_idx
  on public.nexus_syllabus_requests (created_at desc);
create index if not exists nexus_syllabus_votes_request_id_idx
  on public.nexus_syllabus_votes (request_id);

alter table public.nexus_syllabus_requests enable row level security;
alter table public.nexus_syllabus_votes enable row level security;

drop policy if exists "Anyone can read syllabus requests" on public.nexus_syllabus_requests;
create policy "Anyone can read syllabus requests"
  on public.nexus_syllabus_requests for select to anon, authenticated using (true);
drop policy if exists "Signed-in users can create syllabus requests" on public.nexus_syllabus_requests;
create policy "Signed-in users can create syllabus requests"
  on public.nexus_syllabus_requests for insert to authenticated
  with check (auth.uid() = owner_id);
drop policy if exists "Owners can delete their own syllabus requests" on public.nexus_syllabus_requests;
create policy "Owners can delete their own syllabus requests"
  on public.nexus_syllabus_requests for delete to authenticated
  using (auth.uid() = owner_id);

drop policy if exists "Anyone can read syllabus votes" on public.nexus_syllabus_votes;
drop policy if exists "Signed-in users can upvote as themselves" on public.nexus_syllabus_votes;
create policy "Signed-in users can upvote as themselves"
  on public.nexus_syllabus_votes for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "Users can remove their own upvotes" on public.nexus_syllabus_votes;
create policy "Users can remove their own upvotes"
  on public.nexus_syllabus_votes for delete to authenticated
  using (auth.uid() = user_id);

grant select on public.nexus_syllabus_requests to anon, authenticated;
grant insert, delete on public.nexus_syllabus_requests to authenticated;
revoke all privileges on table public.nexus_syllabus_votes from public, anon, authenticated;
grant insert, delete on public.nexus_syllabus_votes to authenticated;

-- Request-owner privacy: public clients receive only safe request fields and a server-computed ownership flag.
CREATE OR REPLACE FUNCTION public.get_nexus_syllabus_requests()
RETURNS TABLE (id uuid, name text, category text, topics text, created_at timestamptz, is_owner boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT request.id, request.name, request.category, request.topics, request.created_at,
         (auth.uid() IS NOT NULL AND request.owner_id = auth.uid()) AS is_owner
  FROM public.nexus_syllabus_requests AS request
  ORDER BY request.created_at DESC
  LIMIT 200;
$function$;

CREATE OR REPLACE FUNCTION public.has_my_active_nexus_syllabus_request()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.nexus_syllabus_requests AS request WHERE request.owner_id = auth.uid()
  );
$function$;

CREATE OR REPLACE FUNCTION public.create_nexus_syllabus_request(p_name text, p_category text, p_topics text)
RETURNS TABLE (id uuid, name text, category text, topics text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_request public.nexus_syllabus_requests%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.nexus_syllabus_requests AS request WHERE request.owner_id = v_user_id) THEN
    RAISE EXCEPTION 'ACTIVE_REQUEST_EXISTS' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.nexus_syllabus_requests (name, category, topics, owner_id)
  VALUES (p_name, p_category, COALESCE(p_topics, ''), v_user_id)
  RETURNING * INTO v_request;
  RETURN QUERY SELECT v_request.id, v_request.name, v_request.category, v_request.topics, v_request.created_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_my_nexus_syllabus_request(p_request_id uuid)
RETURNS TABLE (deleted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_deleted boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.nexus_syllabus_requests AS request
  WHERE request.id = p_request_id AND request.owner_id = auth.uid()
  RETURNING true INTO v_deleted;
  RETURN QUERY SELECT COALESCE(v_deleted, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_nexus_syllabus_requests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_nexus_syllabus_requests() TO anon, authenticated;
REVOKE ALL ON FUNCTION public.has_my_active_nexus_syllabus_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_my_active_nexus_syllabus_request() TO authenticated;
REVOKE ALL ON FUNCTION public.create_nexus_syllabus_request(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_nexus_syllabus_request(text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_my_nexus_syllabus_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_nexus_syllabus_request(uuid) TO authenticated;

-- Vote identities are private. Public clients receive only aggregate totals;
-- signed-in clients can retrieve only their own vote IDs.
CREATE OR REPLACE FUNCTION public.get_nexus_syllabus_vote_counts()
RETURNS TABLE (request_id uuid, vote_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT votes.request_id, pg_catalog.count(*)::bigint
  FROM public.nexus_syllabus_votes AS votes
  GROUP BY votes.request_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_nexus_syllabus_votes()
RETURNS TABLE (request_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT votes.request_id
  FROM public.nexus_syllabus_votes AS votes
  WHERE votes.user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.set_nexus_syllabus_vote(p_request_id uuid, p_upvote boolean)
RETURNS TABLE (changed boolean, vote_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_row_count integer := 0;
  v_changed boolean := false;
  v_vote_count bigint := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_upvote THEN
    INSERT INTO public.nexus_syllabus_votes (request_id, user_id)
    VALUES (p_request_id, v_user_id)
    ON CONFLICT (request_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
  ELSE
    DELETE FROM public.nexus_syllabus_votes
    WHERE request_id = p_request_id AND user_id = v_user_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
  END IF;

  v_changed := v_row_count > 0;
  SELECT pg_catalog.count(*) INTO v_vote_count
  FROM public.nexus_syllabus_votes AS votes
  WHERE votes.request_id = p_request_id;

  RETURN QUERY SELECT v_changed, v_vote_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_nexus_syllabus_vote_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_nexus_syllabus_vote_counts() TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_nexus_syllabus_votes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_nexus_syllabus_votes() TO authenticated;
REVOKE ALL ON FUNCTION public.set_nexus_syllabus_vote(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_nexus_syllabus_vote(uuid, boolean) TO authenticated;
