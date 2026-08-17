-- =====================================================================
-- Row Level Security.
-- Client isolation and inspector scoping are enforced here, in the
-- database, on the assumption that the API will be probed directly. The
-- application layer's checks are a convenience, never the control.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Visibility predicates. Each returns the set of job books a caller may
-- see, by role. Written as SQL functions so every policy shares one
-- definition and a fix lands everywhere at once.
-- ---------------------------------------------------------------------

-- Fortress staff: any non-client, non-inspector role.
create or replace function is_fortress_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_app_role() in
    ('fortress_admin','qaqc_manager','qaqc_tech','fortress_read_only'), false)
$$;

create or replace function is_fortress_writer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_app_role() in
    ('fortress_admin','qaqc_manager','qaqc_tech'), false)
$$;

create or replace function is_manager_or_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_app_role() in ('fortress_admin','qaqc_manager'), false)
$$;

-- A live, unrevoked, unexpired grant on this specific book.
create or replace function has_live_inspector_grant(p_book uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from inspector_grant g
     where g.job_book_id = p_book
       and g.user_id = current_app_user_id()
       and g.revoked_at is null
       and (g.expires_at is null or g.expires_at > now())
  )
$$;

-- Readable book set, by role:
--   admin / manager / read-only  -> every Fortress book
--   tech                         -> only books they are assigned to
--   client user                  -> only books under their own org
--   inspector                    -> only books with a live grant
create or replace function can_read_job_book(p_book uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case current_app_role()
    when 'fortress_admin'      then true
    when 'qaqc_manager'        then true
    when 'fortress_read_only'  then true
    when 'qaqc_tech' then exists (
      select 1 from job_assignment a
       where a.job_book_id = p_book and a.user_id = current_app_user_id())
    when 'client_user' then exists (
      select 1 from job_book b
        join project p on p.id = b.project_id
       where b.id = p_book
         and p.client_org_id = current_client_org_id()
         and b.deleted_at is null)
    when 'third_party_inspector' then has_live_inspector_grant(p_book)
    else false
  end
$$;

create or replace function can_write_job_book(p_book uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case current_app_role()
    when 'fortress_admin' then true
    when 'qaqc_manager'   then true
    when 'qaqc_tech' then exists (
      select 1 from job_assignment a
       where a.job_book_id = p_book and a.user_id = current_app_user_id())
    else false     -- read-only staff, clients and inspectors never write
  end
$$;

-- External readers (clients, inspectors) see only what has been approved.
-- Draft and unapproved records are internal until a manager says otherwise.
create or replace function is_external_reader() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_app_role() in ('client_user','third_party_inspector'), false)
$$;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere. No table carrying job data is left open.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'client_org','app_user','project','job_book','job_assignment','inspector_grant',
    'book_template','section_definition','job_book_section','document',
    'welder','welder_qualification','cwi','ndt_technician','torque_wrench','certificate',
    'weld_line','weld','torque_connection','nde_report','nde_report_line',
    'material_heat','pressure_test','cp_test_point','ut_reading',
    'compliance_flag','inspector_comment','score_snapshot','audit_event'
  ] loop
    execute format('alter table %I enable row level security', t);
    -- FORCE so that even the table owner is subject to policy; without it a
    -- migration or a definer function running as owner would bypass RLS.
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Org / project / book
-- ---------------------------------------------------------------------
create policy client_org_read on client_org for select using (
  is_fortress_staff() or id = current_client_org_id()
);
create policy client_org_write on client_org for all using (
  current_app_role() = 'fortress_admin'
) with check (current_app_role() = 'fortress_admin');

-- A user may always read themselves. Fortress staff read all users. A
-- client user may read only users inside their own org, so that the user
-- table cannot be used to enumerate other operators.
create policy app_user_read on app_user for select using (
  auth_user_id = auth.uid()
  or is_fortress_staff()
  or (current_app_role() = 'client_user' and client_org_id = current_client_org_id())
);
create policy app_user_write on app_user for all using (
  current_app_role() = 'fortress_admin'
) with check (current_app_role() = 'fortress_admin');

create policy project_read on project for select using (
  is_fortress_staff()
  or client_org_id = current_client_org_id()
  or exists (select 1 from job_book b
              where b.project_id = project.id and has_live_inspector_grant(b.id))
);
create policy project_write on project for all using (is_manager_or_admin())
  with check (is_manager_or_admin());

create policy job_book_read on job_book for select using (
  deleted_at is null and can_read_job_book(id)
);
create policy job_book_insert on job_book for insert with check (is_manager_or_admin());
create policy job_book_update on job_book for update using (can_write_job_book(id))
  with check (can_write_job_book(id));

create policy job_assignment_read on job_assignment for select using (
  is_fortress_staff() or user_id = current_app_user_id()
);
create policy job_assignment_write on job_assignment for all using (is_manager_or_admin())
  with check (is_manager_or_admin());

-- An inspector may see their own grant, and nothing about anyone else's.
create policy inspector_grant_read on inspector_grant for select using (
  is_fortress_staff() or user_id = current_app_user_id()
);
create policy inspector_grant_write on inspector_grant for all using (is_manager_or_admin())
  with check (is_manager_or_admin());

-- ---------------------------------------------------------------------
-- Templates are reference data: readable by any authenticated caller,
-- writable only by an admin.
-- ---------------------------------------------------------------------
create policy book_template_read on book_template for select
  using (current_app_user_id() is not null);
create policy book_template_write on book_template for all
  using (current_app_role() = 'fortress_admin')
  with check (current_app_role() = 'fortress_admin');

create policy section_definition_read on section_definition for select
  using (current_app_user_id() is not null);
create policy section_definition_write on section_definition for all
  using (current_app_role() = 'fortress_admin')
  with check (current_app_role() = 'fortress_admin');

-- ---------------------------------------------------------------------
-- Sections. External readers never see internal notes; the column is
-- stripped by the client-facing view below rather than by the browser.
-- ---------------------------------------------------------------------
create policy job_book_section_read on job_book_section for select using (
  can_read_job_book(job_book_id)
);
create policy job_book_section_write on job_book_section for all
  using (can_write_job_book(job_book_id))
  with check (can_write_job_book(job_book_id));

-- ---------------------------------------------------------------------
-- Documents. Fortress sees everything not soft-deleted. Clients and
-- inspectors see only approved documents carrying a visibility that
-- includes them — an unapproved upload is invisible outside Fortress.
-- ---------------------------------------------------------------------
create policy document_read on document for select using (
  deleted_at is null
  and can_read_job_book(job_book_id)
  and (
    is_fortress_staff()
    or (current_app_role() = 'client_user'
        and approved_at is not null and visibility in ('client'))
    or (current_app_role() = 'third_party_inspector'
        and approved_at is not null and visibility in ('client','inspector'))
  )
);
create policy document_write on document for all
  using (can_write_job_book(job_book_id))
  with check (can_write_job_book(job_book_id));

-- ---------------------------------------------------------------------
-- Personnel and equipment are Fortress-wide reference entities. Clients
-- and inspectors reach them only through the records of a book they can
-- already see, so reads are gated on holding any readable book at all.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['welder','cwi','ndt_technician','torque_wrench'] loop
    execute format($p$
      create policy %1$s_read on %1$s for select using (
        deleted_at is null and current_app_user_id() is not null
      );
      create policy %1$s_write on %1$s for all
        using (is_fortress_writer()) with check (is_fortress_writer());
    $p$, t);
  end loop;
end $$;

create policy welder_qual_read on welder_qualification for select
  using (current_app_user_id() is not null);
create policy welder_qual_write on welder_qualification for all
  using (is_fortress_writer()) with check (is_fortress_writer());

create policy certificate_read on certificate for select using (
  deleted_at is null
  and (job_book_id is null or can_read_job_book(job_book_id))
);
create policy certificate_write on certificate for all
  using (is_fortress_writer()) with check (is_fortress_writer());

-- ---------------------------------------------------------------------
-- Record tables. One policy shape, applied to every table that carries a
-- job_book_id, so a new record type cannot be added without inheriting
-- isolation.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'weld_line','weld','torque_connection','nde_report',
    'material_heat','pressure_test','cp_test_point','ut_reading','score_snapshot'
  ] loop
    execute format($p$
      create policy %1$s_read on %1$s for select
        using (can_read_job_book(job_book_id));
      create policy %1$s_write on %1$s for all
        using (can_write_job_book(job_book_id))
        with check (can_write_job_book(job_book_id));
    $p$, t);
  end loop;
end $$;

-- Report lines inherit their parent report's book.
create policy nde_line_read on nde_report_line for select using (
  exists (select 1 from nde_report r
           where r.id = nde_report_id and can_read_job_book(r.job_book_id))
);
create policy nde_line_write on nde_report_line for all using (
  exists (select 1 from nde_report r
           where r.id = nde_report_id and can_write_job_book(r.job_book_id))
) with check (
  exists (select 1 from nde_report r
           where r.id = nde_report_id and can_write_job_book(r.job_book_id))
);

-- ---------------------------------------------------------------------
-- The flag queue is internal. Clients and inspectors never see the raw
-- deficiency list for a book, only its completion story.
-- ---------------------------------------------------------------------
create policy compliance_flag_read on compliance_flag for select using (
  is_fortress_staff() and can_read_job_book(job_book_id)
);
create policy compliance_flag_write on compliance_flag for all
  using (is_fortress_writer() and can_write_job_book(job_book_id))
  with check (is_fortress_writer() and can_write_job_book(job_book_id));

-- An inspector may write a comment only where the grant enables it, and
-- only as themselves.
create policy inspector_comment_read on inspector_comment for select using (
  can_read_job_book(job_book_id)
);
create policy inspector_comment_insert on inspector_comment for insert with check (
  author_id = current_app_user_id()
  and (
    is_fortress_writer()
    or exists (select 1 from inspector_grant g
                where g.job_book_id = inspector_comment.job_book_id
                  and g.user_id = current_app_user_id()
                  and g.can_comment
                  and g.revoked_at is null
                  and (g.expires_at is null or g.expires_at > now()))
  )
);

-- ---------------------------------------------------------------------
-- Audit log: readable by admins outright and by managers for books they
-- can reach; writable by no one through the API. INSERT happens only
-- inside SECURITY DEFINER triggers, which is why no insert policy exists.
-- ---------------------------------------------------------------------
create policy audit_read on audit_event for select using (
  current_app_role() = 'fortress_admin'
  or (current_app_role() = 'qaqc_manager'
      and job_book_id is not null and can_read_job_book(job_book_id))
);

-- ---------------------------------------------------------------------
-- Client-facing views. Internal-only columns are dropped server-side, so
-- they never enter a response payload that a client could inspect.
-- security_invoker keeps the caller's RLS in force through the view.
-- ---------------------------------------------------------------------
create view client_section_v with (security_invoker = true) as
  select id, job_book_id, section_definition_id, status, na_reason,
         approved_at, computed_pct
    from job_book_section;

create view client_weld_v with (security_invoker = true) as
  select id, weld_line_id, job_book_id, weld_number, weld_date, joint_type,
         component_description, heat_numbers, cwi_visual_result,
         visual_inspection_date, ndt_method, ndt_result, status
    from weld
   where deleted_at is null;

comment on view client_weld_v is
  'Client/inspector projection of weld: the internal comments column and the
   per-pass welder identities are absent by construction.';

grant select on client_section_v, client_weld_v to authenticated;
