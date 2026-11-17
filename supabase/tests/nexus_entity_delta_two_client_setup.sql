-- ONE-SHOT TEST FIXTURE: run ONLY against the disposable local Phase 3.4 Supabase project.
-- Creates three confirmed disposable email/password users with empty snapshots.
-- The returned passwords are for this isolated local test only. Do not reuse them.
-- Accounts persist until supabase/tests/nexus_entity_delta_two_client_cleanup.sql is run.

WITH credentials AS MATERIALIZED (
  SELECT
    gen_random_uuid() AS id,
    'nexus-3-4-two-client-' || replace(gen_random_uuid()::text, '-', '') || '@example.invalid' AS email,
    'Nexus-Staging-' || replace(gen_random_uuid()::text, '-', '') || '!Aa9' AS password
  UNION ALL
  SELECT
    gen_random_uuid(),
    'nexus-3-4-two-client-' || replace(gen_random_uuid()::text, '-', '') || '@example.invalid',
    'Nexus-Staging-' || replace(gen_random_uuid()::text, '-', '') || '!Bb8'
  UNION ALL
  SELECT
    gen_random_uuid(),
    'nexus-3-4-two-client-' || replace(gen_random_uuid()::text, '-', '') || '@example.invalid',
    'Nexus-Staging-' || replace(gen_random_uuid()::text, '-', '') || '!Cc7'
),
inserted_users AS (
  INSERT INTO auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
     confirmation_token, recovery_token, email_change_token_new, email_change,
     email_change_token_current, phone_change, phone_change_token,
     reauthentication_token, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT
    '00000000-0000-0000-0000-000000000000'::uuid,
    id, 'authenticated', 'authenticated', email,
    extensions.crypt(password, extensions.gen_salt('bf')),
    clock_timestamp(),
    '', '', '', '', '', '', '', '',
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
    '{}'::jsonb,
    clock_timestamp(), clock_timestamp()
  FROM credentials
  RETURNING id, email
),
inserted_identities AS (
  INSERT INTO auth.identities
    (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  SELECT
    id::text,
    id,
    jsonb_build_object(
      'sub', id::text,
      'email', email,
      'email_verified', true,
      'phone_verified', false
    ),
    'email',
    clock_timestamp(), clock_timestamp(), clock_timestamp()
  FROM inserted_users
  RETURNING user_id
),
inserted_workspaces AS (
  INSERT INTO public.nexus_user_data (user_id, payload, updated_at)
  SELECT
    id,
    jsonb_build_object(
      'app', 'Nexus Spaced Repetition Tracker',
      'schema', 4,
      'state', jsonb_build_object(
        'streams', '[]'::jsonb,
        'subjects', '[]'::jsonb,
        'topics', '[]'::jsonb,
        'history', '[]'::jsonb,
        'exams', '[]'::jsonb,
        'settings', '{}'::jsonb
      ),
      'featureState', jsonb_build_object(
        'journal', '[]'::jsonb,
        'papers', '[]'::jsonb,
        'goals', '[]'::jsonb,
        'studyLogs', '[]'::jsonb
      )
    ),
    clock_timestamp()
  FROM inserted_users
  RETURNING user_id
),
inserted_pilot_eligibility AS (
  -- The sorted first and third fixture accounts are used for the A1/A2
  -- protocol and large-workspace lifecycle respectively. The second account
  -- is deliberately unlisted so the browser regression proves default-deny.
  INSERT INTO nexus_private.entity_delta_pilot_allowlist
    (user_id, enabled, reason)
  SELECT ranked.id, true, 'Disposable local Phase 3.4 integration fixture'
  FROM (
    SELECT id, email, row_number() OVER (ORDER BY email) AS fixture_order
    FROM inserted_users
  ) AS ranked
  WHERE ranked.fixture_order IN (1, 3)
  RETURNING user_id
)
SELECT
  credentials.email,
  credentials.password,
  inserted_users.id AS user_id,
  'confirmed; empty disposable workspace created' AS status
FROM credentials
JOIN inserted_users USING (email)
JOIN inserted_identities ON inserted_identities.user_id = inserted_users.id
JOIN inserted_workspaces ON inserted_workspaces.user_id = inserted_users.id
LEFT JOIN inserted_pilot_eligibility ON inserted_pilot_eligibility.user_id = inserted_users.id
ORDER BY credentials.email;
