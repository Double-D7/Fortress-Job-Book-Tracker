-- ---------------------------------------------------------------------
-- The two functions 0015 added were left reachable by anon.
--
-- 0012 established the pattern and stated the reason: Postgres grants
-- EXECUTE on a new function to PUBLIC, and `anon` inherits from PUBLIC, so
-- revoking from `anon` alone removes nothing. Every mutating function has
-- to be revoked `from public, anon` and granted back to `authenticated`.
--
-- 0015 revoked from `anon` only. Both functions refuse an unauthenticated
-- caller on their own — each begins by resolving `current_app_user_id()`,
-- which is null for anon, and raises — but 0012's own words apply: "it
-- fails safe" is a weaker claim than "it cannot be called". Caught by the
-- Supabase security advisor after 0015 reached the live project.
-- ---------------------------------------------------------------------

revoke execute on function record_gate_review(
  uuid, gate_id, gate_outcome, jsonb, numeric, uuid, uuid, date, text, text
) from public, anon;
revoke execute on function assign_custodian(uuid, uuid) from public, anon;

grant execute on function record_gate_review(
  uuid, gate_id, gate_outcome, jsonb, numeric, uuid, uuid, date, text, text
) to authenticated;
grant execute on function assign_custodian(uuid, uuid) to authenticated;
