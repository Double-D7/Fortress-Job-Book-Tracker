-- =====================================================================
-- Append-only audit log.
-- The append-only property is enforced by the database, not by convention:
-- rules rewrite UPDATE and DELETE to no-ops, and the privilege grants
-- withhold them regardless. A compromised application role cannot rewrite
-- history.
-- =====================================================================

create table audit_event (
  id           bigserial primary key,
  actor_id     uuid,
  actor_email  text,
  actor_role   user_role,
  job_book_id  uuid,
  entity_type  text not null,
  entity_id    uuid,
  action       text not null,
  before_json  jsonb,
  after_json   jsonb,
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index audit_book_idx   on audit_event(job_book_id, created_at desc);
create index audit_entity_idx on audit_event(entity_type, entity_id);
create index audit_actor_idx  on audit_event(actor_id, created_at desc);

-- Belt: no role may update or delete, ever.
revoke update, delete, truncate on audit_event from public;
revoke update, delete, truncate on audit_event from anon, authenticated;

-- Braces: even a role that somehow held the privilege gets its statement
-- turned into nothing. DO INSTEAD NOTHING silently discards the write
-- rather than erroring, which is deliberate — a rogue DELETE must not be
-- able to distinguish a protected table from an empty one.
create rule audit_event_no_update as on update to audit_event do instead nothing;
create rule audit_event_no_delete as on delete to audit_event do instead nothing;

-- ---------------------------------------------------------------------
-- Actor resolution. Every audited write is attributed to the calling
-- Supabase auth identity; there is no anonymous path to a write.
-- ---------------------------------------------------------------------
create or replace function current_app_user()
returns app_user
language sql stable security definer set search_path = public
as $$
  select * from app_user
   where auth_user_id = auth.uid()
     and is_active
     and deleted_at is null
   limit 1
$$;

create or replace function current_app_user_id() returns uuid
language sql stable security definer set search_path = public
as $$ select id from app_user where auth_user_id = auth.uid() and is_active and deleted_at is null limit 1 $$;

create or replace function current_app_role() returns user_role
language sql stable security definer set search_path = public
as $$ select role from app_user where auth_user_id = auth.uid() and is_active and deleted_at is null limit 1 $$;

create or replace function current_client_org_id() returns uuid
language sql stable security definer set search_path = public
as $$ select client_org_id from app_user where auth_user_id = auth.uid() and is_active and deleted_at is null limit 1 $$;

-- ---------------------------------------------------------------------
-- Generic audit trigger. Attach to every table carrying compliance data.
-- ---------------------------------------------------------------------
create or replace function audit_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor   app_user;
  v_book_id uuid;
  v_before  jsonb;
  v_after   jsonb;
  v_action  text;
begin
  select * into v_actor from current_app_user();

  if tg_op = 'INSERT' then
    v_before := null; v_after := to_jsonb(new); v_action := 'create';
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old); v_after := to_jsonb(new);
    -- A soft delete is a distinct, separately-queryable action.
    v_action := case
      when to_jsonb(old) ? 'deleted_at'
       and old.deleted_at is null and new.deleted_at is not null then 'soft_delete'
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
  -- write path, but never silently drop the event either.
  insert into audit_event (entity_type, entity_id, action, before_json, after_json)
  values (tg_table_name, coalesce((v_after->>'id')::uuid,(v_before->>'id')::uuid),
          v_action || '_degraded', v_before, v_after);
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'client_org','app_user','project','job_book','job_assignment','inspector_grant',
    'book_template','section_definition','job_book_section','document',
    'welder','welder_qualification','cwi','ndt_technician','torque_wrench','certificate',
    'weld_line','weld','torque_connection','nde_report','nde_report_line',
    'material_heat','pressure_test','cp_test_point','ut_reading',
    'compliance_flag','inspector_comment'
  ] loop
    execute format(
      'create trigger %I_audit after insert or update or delete on %I
         for each row execute function audit_trigger()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Document access is itself an audited event — inspectors will ask who
-- read what, and a read leaves no row behind otherwise.
-- ---------------------------------------------------------------------
create or replace function log_document_access(
  p_document_id uuid, p_action text default 'download'
) returns void
language plpgsql security definer set search_path = public
as $$
declare v_actor app_user; v_doc document;
begin
  select * into v_actor from current_app_user();
  select * into v_doc from document where id = p_document_id;
  insert into audit_event (actor_id, actor_email, actor_role, job_book_id,
                           entity_type, entity_id, action, after_json)
  values (v_actor.id, v_actor.email, v_actor.role, v_doc.job_book_id,
          'document', p_document_id, p_action,
          jsonb_build_object('filename', v_doc.normalized_filename,
                             'sha256', v_doc.sha256));
end;
$$;

-- ---------------------------------------------------------------------
-- Section approval as a two-person control. Approval cannot be performed
-- by the user who marked the section ready, and cannot be performed by a
-- tech at all — checked here so it holds for any caller, not just the UI.
-- ---------------------------------------------------------------------
create or replace function approve_section(p_section_id uuid)
returns job_book_section
language plpgsql security definer set search_path = public
as $$
declare v_actor app_user; v_section job_book_section;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role not in ('fortress_admin','qaqc_manager') then
    raise exception 'section approval requires QA/QC Manager or Admin' using errcode = '42501';
  end if;

  select * into v_section from job_book_section where id = p_section_id for update;
  if v_section.id is null then
    raise exception 'section not found' using errcode = 'P0002';
  end if;
  if v_section.ready_for_review_by = v_actor.id then
    raise exception 'a section may not be approved by the user who submitted it'
      using errcode = '42501';
  end if;

  update job_book_section
     set status = 'approved', approved_by = v_actor.id, approved_at = now()
   where id = p_section_id
  returning * into v_section;

  return v_section;
end;
$$;
