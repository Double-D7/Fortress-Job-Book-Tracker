-- ---------------------------------------------------------------------
-- The audit trigger crashed on every table without a `deleted_at` column.
--
-- Found by running the migrations against a real Postgres for the first
-- time and calling `approve_section()`. The two-person control worked
-- exactly as designed — it refused the submitter and refused a tech — and
-- then a legitimate approver hit:
--
--   ERROR: null value in column "action" of relation "audit_event"
--
-- Two defects, stacked, and the second hid the first.
--
-- 1. The UPDATE branch tested `old.deleted_at`, guarded by a jsonb key
--    check. plpgsql resolves `old.deleted_at` as a field reference on the
--    trigger record regardless of that guard, so on a table with no such
--    column it raises before `v_action` is ever assigned.
--
-- 2. The exception handler then wrote `v_action || '_degraded'`. With
--    `v_action` still null that concatenation is null, and the fallback
--    insert violated the not-null constraint — so the handler meant to
--    keep audit failures from blocking writes became the thing blocking
--    them, and reported a confusing error about a column nobody touched.
--
-- Ten audited tables have no `deleted_at`, and every one of them was
-- unwritable on UPDATE: job_book_section (so no section could ever be
-- approved, marked ready for review, or have its score cached),
-- compliance_flag (no flag could be acknowledged, resolved or dismissed),
-- inspector_grant (no grant could be revoked), inspector_comment,
-- job_assignment, nde_report_line, and the four reference tables.
--
-- The fix reads `deleted_at` out of the jsonb images instead of off the
-- record, which is column-agnostic by construction, and makes the
-- degraded path incapable of producing a null action.
-- ---------------------------------------------------------------------

create or replace function audit_trigger() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor   app_user;
  v_book_id uuid;
  v_before  jsonb;
  v_after   jsonb;
  -- Assigned before anything that can raise, so the exception handler
  -- below always has a non-null value to work with. This is the whole
  -- reason the original failure was unreadable.
  v_action  text := lower(tg_op);
begin
  select * into v_actor from current_app_user();

  if tg_op = 'INSERT' then
    v_before := null; v_after := to_jsonb(new); v_action := 'create';
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old); v_after := to_jsonb(new);
    -- Read through the jsonb image rather than the record. `old.deleted_at`
    -- is a field reference plpgsql resolves whatever the guard says, and
    -- ten audited tables do not have that column. A soft delete stays a
    -- distinct, separately-queryable action wherever the column exists.
    v_action := case
      when v_before ? 'deleted_at'
       and v_before ->> 'deleted_at' is null
       and v_after  ->> 'deleted_at' is not null then 'soft_delete'
      else 'update' end;
  else
    v_before := to_jsonb(old); v_after := null; v_action := 'hard_delete';
  end if;

  -- Pull the owning book id from whichever column carries it.
  v_book_id := coalesce(
    (v_after ->> 'job_book_id')::uuid,
    (v_before ->> 'job_book_id')::uuid,
    case when tg_table_name = 'job_book'
         then coalesce((v_after ->> 'id')::uuid, (v_before ->> 'id')::uuid) end
  );

  insert into audit_event (
    actor_id, actor_email, actor_role, job_book_id,
    entity_type, entity_id, action, before_json, after_json,
    ip_address, user_agent
  ) values (
    v_actor.id, v_actor.email, v_actor.role, v_book_id,
    tg_table_name,
    coalesce((v_after ->> 'id')::uuid, (v_before ->> 'id')::uuid),
    v_action, v_before, v_after,
    nullif(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for','')::inet,
    current_setting('request.headers', true)::jsonb ->> 'user-agent'
  );

  return coalesce(new, old);
exception when others then
  -- Never let audit-context extraction (e.g. a malformed header) block the
  -- write path, but never silently drop the event either. `coalesce` is
  -- belt and braces now that v_action is initialised at declaration: this
  -- insert must not be capable of failing, because it is the last line of
  -- defence and its failure takes the caller's transaction with it.
  insert into audit_event (entity_type, entity_id, action, before_json, after_json)
  values (tg_table_name, coalesce((v_after->>'id')::uuid,(v_before->>'id')::uuid),
          coalesce(v_action, lower(tg_op), 'unknown') || '_degraded', v_before, v_after);
  return coalesce(new, old);
end;
$$;
