-- RECONSTRUCTED migration from the surviving privilege-revocation notes.
-- Original file was not recoverable from repository history.
-- Nexus cloud sync updates a user's snapshot; it does not need client-side DELETE.
revoke delete
  on table public.nexus_user_data
  from authenticated;
