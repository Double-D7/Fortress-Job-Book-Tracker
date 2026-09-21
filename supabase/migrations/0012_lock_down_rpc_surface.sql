-- ---------------------------------------------------------------------
-- Close the RPC surface, and fix a mutable search_path.
--
-- Both found by Supabase's own database linter once the schema was live,
-- which is the argument for running `get_advisors` after any DDL: neither
-- of these is visible from the migration file alone.
--
-- 1. `storage_object_book_id` was created without `set search_path`. It is
--    called from the storage object policies, so a caller able to
--    manipulate the search path could shadow what it resolves — inside the
--    function that decides which job book a file belongs to. Every other
--    function in this schema pins it; this one was an oversight.
--
-- 2. Postgres grants EXECUTE on new functions to PUBLIC, and Supabase
--    exposes everything in `public` at `/rest/v1/rpc/<name>`. So all
--    nineteen functions here were callable by `anon` — an unauthenticated
--    caller off the open internet. The definer functions each begin by
--    resolving `current_app_user()`, which is null for anon, so they raise
--    rather than act; but "it fails safe" is a weaker claim than "it
--    cannot be called", and `log_document_access` in particular would have
--    let an anonymous caller write rows into an append-only audit log that
--    nobody — by design — can then delete.
--
-- The read-only predicates (`can_read_job_book`, `is_fortress_staff`, the
-- `current_*` family) deliberately keep their grant to `authenticated`:
-- RLS policy expressions are evaluated as the querying role, so revoking
-- EXECUTE there would break every policy that calls them. They return
-- false or null for an unauthenticated caller and leak nothing.
-- ---------------------------------------------------------------------

create or replace function storage_object_book_id(p_name text)
returns uuid language sql immutable
set search_path = public
as $$
  select case
    when split_part(p_name, '/', 1) ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;

-- Mutating functions: never reachable without a session.
revoke execute on function approve_section(uuid) from public, anon;
revoke execute on function create_job_book(uuid, book_type, text, jsonb, jsonb, jsonb) from public, anon;
revoke execute on function invite_user(citext, text, user_role, uuid) from public, anon;
revoke execute on function set_section_score(uuid, numeric, numeric) from public, anon;
revoke execute on function log_document_access(uuid, text) from public, anon;

grant execute on function approve_section(uuid) to authenticated;
grant execute on function create_job_book(uuid, book_type, text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function invite_user(citext, text, user_role, uuid) to authenticated;
grant execute on function set_section_score(uuid, numeric, numeric) to authenticated;
grant execute on function log_document_access(uuid, text) to authenticated;

-- Trigger functions are invoked by the trigger, never by a caller. A
-- trigger runs its function regardless of the caller's EXECUTE privilege,
-- so revoking from everyone removes the RPC endpoint and changes nothing
-- about how auditing or account linking actually work.
revoke execute on function audit_trigger() from public, anon, authenticated;
revoke execute on function link_auth_user() from public, anon, authenticated;
revoke execute on function link_app_user_to_auth() from public, anon, authenticated;
