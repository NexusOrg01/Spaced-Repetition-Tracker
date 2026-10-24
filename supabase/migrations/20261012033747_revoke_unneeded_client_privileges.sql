-- RECONSTRUCTED migration from the surviving privilege-revocation notes.
-- Original file was not recoverable from repository history.
-- Removes table privileges that ordinary browser clients do not need.
-- Does not revoke SELECT/INSERT/UPDATE, which cloud sync requires.
revoke truncate, trigger, references
  on table public.nexus_user_data
  from anon, authenticated;

-- Prevent ordinary client roles from invoking the helper function, if installed.
do $migration$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$migration$;
