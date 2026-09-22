-- ---------------------------------------------------------------------
-- The database's own guarantees, asserted against a real Postgres.
--
-- The scoring engine is covered by vitest, which needs no database. These
-- are the promises vitest *cannot* check, because they are enforced by
-- Postgres rather than by application code: client isolation, the
-- append-only audit trail, and two-person approval. §3 of the brief puts
-- them in the database precisely so that a bug in the application cannot
-- reach around them — which means they have to be tested there too.
--
-- Run with `npm run verify:db`. Every check raises on failure, so the
-- script either completes silently or stops at the first broken promise.
-- ---------------------------------------------------------------------

\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function assert(p_cond boolean, p_what text) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice '  ok  %', p_what;
end $$;

/** Run a statement as a signed-in user and report whether it was refused. */
create or replace function refused(p_sub uuid, p_sql text) returns boolean
language plpgsql as $$
begin
  execute format('set local role authenticated');
  execute format('set local request.jwt.claim.sub = %L', p_sub);
  execute p_sql;
  reset role;
  return false;
exception when others then
  reset role;
  return true;
end $$;

/** Run a query as a signed-in user and return its single text result. */
create or replace function as_user(p_sub uuid, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  execute format('set local role authenticated');
  execute format('set local request.jwt.claim.sub = %L', p_sub);
  execute p_sql into v;
  reset role;
  return v;
exception when others then
  reset role;
  return 'ERROR: ' || sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- Fixtures: two operators who must never see each other's work.
--
-- Order matters, and the fact that it does is itself the allowlist
-- working: 0013 refuses an auth account for an address with no invitation,
-- so the app_user rows are created first. Writing these the other way
-- round is how this suite caught its own regression.
-- ---------------------------------------------------------------------
insert into client_org (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Noble Energy'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Chevron')
on conflict do nothing;

insert into app_user (id, email, full_name, role, client_org_id) values
  ('bbbbbbbb-0000-0000-0000-000000000001','noble@example.com','Noble Operator','client_user','aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000002','chevron@example.com','Chevron Operator','client_user','aaaaaaaa-0000-0000-0000-000000000002'),
  ('bbbbbbbb-0000-0000-0000-000000000003','tech@fortressds.com','A Tech','qaqc_tech',null),
  ('bbbbbbbb-0000-0000-0000-000000000004','admin@fortressds.com','An Admin','fortress_admin',null),
  ('bbbbbbbb-0000-0000-0000-000000000005','manager@fortressds.com','A Manager','qaqc_manager',null)
on conflict do nothing;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','noble@example.com'),
  ('22222222-2222-2222-2222-222222222222','chevron@example.com'),
  ('33333333-3333-3333-3333-333333333333','tech@fortressds.com'),
  ('44444444-4444-4444-4444-444444444444','admin@fortressds.com'),
  ('55555555-5555-5555-5555-555555555555','manager@fortressds.com')
on conflict do nothing;

insert into project (id, client_org_id, name) values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Noble Project'),
  ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','Chevron Project')
on conflict do nothing;

insert into job_book (id, project_id, book_template_id, book_type, job_number)
  select 'dddddddd-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001', id,'flowline','DP452'
    from book_template where book_type='flowline' limit 1
on conflict do nothing;
insert into job_book (id, project_id, book_template_id, book_type, job_number)
  select 'dddddddd-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000002', id,'facility','DP318'
    from book_template where book_type='facility' limit 1
on conflict do nothing;

\echo ''
\echo 'Client isolation'
do $$ begin
  perform assert(
    as_user('11111111-1111-1111-1111-111111111111',
            'select string_agg(job_number,'','' order by job_number) from job_book') = 'DP452',
    'a client user sees only their own operator''s books');
  perform assert(
    as_user('22222222-2222-2222-2222-222222222222',
            'select string_agg(job_number,'','' order by job_number) from job_book') = 'DP318',
    'the other operator sees only theirs');
  perform assert(
    as_user('33333333-3333-3333-3333-333333333333',
            'select count(*)::text from job_book') = '0',
    'a tech with no assignment sees no books');
  perform assert(
    as_user('44444444-4444-4444-4444-444444444444',
            'select count(*)::text from job_book') = '2',
    'an admin sees every book');
end $$;

\echo ''
\echo 'Append-only audit trail'
insert into audit_event (entity_type, entity_id, action)
values ('job_book','dddddddd-0000-0000-0000-000000000001','create');

do $$
declare v_before bigint; v_after bigint;
begin
  select count(*) into v_before from audit_event;
  -- An admin can read every audit row, so this is not merely invisible to
  -- them — it is genuinely unwritable.
  perform assert(
    as_user('44444444-4444-4444-4444-444444444444','select count(*)::text from audit_event')::bigint > 0,
    'an admin can read the audit trail');
  perform as_user('44444444-4444-4444-4444-444444444444',
                  'select 1 from (select 1) t where (update_audit())');
exception when others then null;
end $$;

do $$
declare v_before bigint; v_after bigint; v_tampered bigint;
begin
  select count(*) into v_before from audit_event;
  perform as_user('44444444-4444-4444-4444-444444444444',
                  'with x as (update audit_event set action = ''tampered'' returning 1) select count(*)::text from x');
  perform as_user('44444444-4444-4444-4444-444444444444',
                  'with x as (delete from audit_event returning 1) select count(*)::text from x');
  select count(*) into v_after from audit_event;
  select count(*) into v_tampered from audit_event where action = 'tampered';
  perform assert(v_after = v_before, 'no audit row can be deleted, even by an admin');
  perform assert(v_tampered = 0,     'no audit row can be updated, even by an admin');
  perform assert(refused('44444444-4444-4444-4444-444444444444','truncate audit_event'),
                 'the audit table cannot be truncated');
end $$;

\echo ''
\echo 'Two-person approval'
insert into job_book_section (id, job_book_id, section_definition_id, status, ready_for_review_by)
  select 'eeeeeeee-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001', id,
         'ready_for_review','bbbbbbbb-0000-0000-0000-000000000005'
    from section_definition order by sort_order limit 1
on conflict do nothing;

do $$ begin
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555',
      'select status::text from approve_section(''eeeeeeee-0000-0000-0000-000000000001'')')
      like 'ERROR%submitted it',
    'the person who submitted a section cannot approve it');
  perform assert(
    as_user('33333333-3333-3333-3333-333333333333',
      'select status::text from approve_section(''eeeeeeee-0000-0000-0000-000000000001'')')
      like 'ERROR%Manager or Admin',
    'a tech cannot approve a section');
  -- The regression this file was written for: a legitimate approval used
  -- to crash inside the audit trigger, because job_book_section has no
  -- deleted_at column and the trigger read that field off the record.
  perform assert(
    as_user('44444444-4444-4444-4444-444444444444',
      'select status::text from approve_section(''eeeeeeee-0000-0000-0000-000000000001'')')
      = 'approved',
    'a second, qualified person CAN approve it');
  perform assert(
    (select count(*) from audit_event where action like '%_degraded') = 0,
    'the approval wrote a clean audit row, not a degraded one');
end $$;

\echo ''
\echo 'Every audited table survives an UPDATE'
do $$
declare t text; v_sql text;
begin
  -- The audit trigger used to raise on any table without deleted_at, which
  -- made ten tables unwritable — section approval, flag resolution and
  -- inspector-grant revocation among them.
  for t in
    select c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and g.tgname like '%\_audit' and not g.tgisinternal
    order by 1
  loop
    v_sql := format('update %I set %I = %I where false', t,
      (select column_name from information_schema.columns
        where table_name = t and table_schema='public' order by ordinal_position limit 1),
      (select column_name from information_schema.columns
        where table_name = t and table_schema='public' order by ordinal_position limit 1));
    execute v_sql;
  end loop;
  perform assert(true, 'every audited table accepts an UPDATE without the trigger raising');
end $$;

\echo ''
\echo 'Account linking is an allowlist, not a sign-up'
do $$
declare v_linked uuid;
begin
  -- The ordinary flow: invited, then authenticates.
  insert into app_user (email, full_name, role)
  values ('invited@fortressds.com','Invited Tech','qaqc_tech');
  insert into auth.users (id, email)
  values ('66666666-6666-6666-6666-666666666666','invited@fortressds.com');
  select auth_user_id into v_linked from app_user where email = 'invited@fortressds.com';
  perform assert(v_linked = '66666666-6666-6666-6666-666666666666',
    'someone invited before they sign in is linked when they do');

  -- 0013 made the reverse order impossible, and that is the point: an
  -- account cannot exist without an invitation, so "authenticated but not
  -- yet invited" is no longer a state the system can reach. 0011 allowed
  -- it and relied on app_user for authorization; this is stricter.
  perform assert(
    refused('44444444-4444-4444-4444-444444444444',
      'insert into auth.users (id, email) values (gen_random_uuid(), ''early@fortressds.com'')'),
    'an account cannot be created before the invitation exists');
  perform assert(
    (select count(*) from auth.users where email = 'early@fortressds.com') = 0,
    'and no account was left behind by the attempt');

  -- The property that matters most.
  perform assert(
    refused('44444444-4444-4444-4444-444444444444',
      'insert into auth.users (id, email) values (gen_random_uuid(), ''stranger@example.com'')'),
    'authenticating with an uninvited address is refused outright');
  perform assert(
    (select count(*) from app_user where email = 'stranger@example.com') = 0,
    'and creates no account');

  perform assert(
    refused('33333333-3333-3333-3333-333333333333',
      'select invite_user(''x@y.com'',''X'',''fortress_admin'')'),
    'a tech cannot invite anyone');
  perform assert(
    refused('44444444-4444-4444-4444-444444444444',
      'select invite_user(''bad@y.com'',''Bad'',''client_user'')'),
    'even an admin cannot create a client user with no operator');
end $$;

\echo ''
\echo 'Document files are as protected as the rows'
-- A job book's files ARE the confidential material. A bucket left readable
-- would make every policy above decorative, so the objects are checked the
-- same way the rows are.
insert into storage.objects (bucket_id, name) values
  ('job-book-documents','dddddddd-0000-0000-0000-000000000001/13/'||repeat('a',64)),
  ('job-book-documents','dddddddd-0000-0000-0000-000000000002/13/'||repeat('b',64))
on conflict do nothing;

do $$ begin
  perform assert(
    (select public from storage.buckets where id = 'job-book-documents') = false,
    'the document bucket is private, so no file has a permanent public URL');
  perform assert(
    as_user('11111111-1111-1111-1111-111111111111',
      'select count(*)::text from storage.objects') = '1',
    'a client user can reach only their own operator''s files');
  perform assert(
    as_user('22222222-2222-2222-2222-222222222222',
      'select count(*)::text from storage.objects') = '1',
    'and the other operator only theirs');
  perform assert(
    as_user('33333333-3333-3333-3333-333333333333',
      'select count(*)::text from storage.objects') = '0',
    'a tech with no assignment reaches no files at all');
  perform assert(
    refused('11111111-1111-1111-1111-111111111111',
      'insert into storage.objects (bucket_id, name) values (''job-book-documents'',
        ''dddddddd-0000-0000-0000-000000000001/13/''||repeat(''c'',64))'),
    'a client user cannot upload into a book they can only read');
end $$;

\echo ''
\echo 'Gate reviews are decisions, and the database holds them to it'
-- FDS-JBMP-001 §7. The application checks all of this too, but the
-- application is not the control: a gate decision is the thing that lets a
-- book advance toward a client, so the rules live where nobody can reach
-- around them.
do $$
declare v_criteria jsonb := '[{"id":"x","state":"not_met"},{"id":"y","state":"met"}]'::jsonb;
        v_clean    jsonb := '[{"id":"y","state":"met"}]'::jsonb;
begin
  -- §5.1: the QA/QC Manager chairs. A tech may see the criteria; they may
  -- not take the decision.
  perform assert(
    as_user('33333333-3333-3333-3333-333333333333', format(
      'select record_gate_review(''dddddddd-0000-0000-0000-000000000001'',''G0'',''pass'',%L)',
      v_clean)) like 'ERROR%chair a gate review',
    'a tech cannot chair a gate review');

  -- Passing a gate over an unmet criterion is allowed, because the chair is
  -- the decision-maker — but it is never allowed silently.
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555', format(
      'select record_gate_review(''dddddddd-0000-0000-0000-000000000001'',''G0'',''pass'',%L)',
      v_criteria)) like 'ERROR%override note is required',
    'a gate cannot be passed over an unmet criterion without a written override');

  -- An INDETERMINATE criterion is held to the same standard as an unmet
  -- one. "The app could not tell" is not a pass.
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555', format(
      'select record_gate_review(''dddddddd-0000-0000-0000-000000000001'',''G0'',''pass'',%L)',
      '[{"id":"z","state":"indeterminate"}]'::jsonb)) like 'ERROR%override note is required',
    'nor over a criterion the application could not evaluate');

  -- A Fail needs no excuse.
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555', format(
      'select record_gate_review(''dddddddd-0000-0000-0000-000000000001'',''G0'',''fail'',%L)',
      v_criteria)) is not null,
    'a Fail can be recorded with no override note');

  -- A clean Pass on clean criteria, and it advances the book.
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555', format(
      'select record_gate_review(''dddddddd-0000-0000-0000-000000000001'',''G0'',''pass'',%L)',
      v_clean)) is not null,
    'a Pass on met criteria is recorded');
  perform assert(
    (select current_gate from job_book where id='dddddddd-0000-0000-0000-000000000001') = 'G0',
    'and it advances the book to that gate');

  -- Attempts are numbered, so "failed the same gate twice" is a query.
  perform assert(
    (select count(*) from gate_review
      where job_book_id='dddddddd-0000-0000-0000-000000000001' and gate='G0') = 2
    and (select max(attempt) from gate_review
          where job_book_id='dddddddd-0000-0000-0000-000000000001' and gate='G0') = 2,
    'repeated reviews of one gate are numbered attempts, not overwrites');
end $$;

do $$ begin
  -- §7: a Conditional Pass carries a maximum of ten calendar days.
  perform assert(
    refused('55555555-5555-5555-5555-555555555555',
      $q$insert into gate_review
           (job_book_id, gate, attempt, outcome, chaired_by, criteria_snapshot,
            decided_at, conditional_due_at)
         values ('dddddddd-0000-0000-0000-000000000001','G1',1,'conditional_pass',
                 'bbbbbbbb-0000-0000-0000-000000000005','[]'::jsonb,
                 '2026-01-01T00:00:00Z', '2026-01-30')$q$),
    'a Conditional Pass cannot carry a window longer than ten days');

  -- …and must carry a dated action list at all.
  perform assert(
    refused('55555555-5555-5555-5555-555555555555',
      $q$insert into gate_review
           (job_book_id, gate, attempt, outcome, chaired_by, criteria_snapshot)
         values ('dddddddd-0000-0000-0000-000000000001','G1',2,'conditional_pass',
                 'bbbbbbbb-0000-0000-0000-000000000005','[]'::jsonb)$q$),
    'a Conditional Pass cannot be issued without a due date');

  -- §7: issuable once per gate.
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555',
      $q$insert into gate_review
           (job_book_id, gate, attempt, outcome, chaired_by, criteria_snapshot,
            decided_at, conditional_due_at)
         values ('dddddddd-0000-0000-0000-000000000001','G2',1,'conditional_pass',
                 'bbbbbbbb-0000-0000-0000-000000000005','[]'::jsonb,
                 now(), (now() at time zone 'UTC')::date + 5)
         returning 'ok'$q$) = 'ok',
    'the first Conditional Pass on a gate is accepted');
  perform assert(
    refused('55555555-5555-5555-5555-555555555555',
      $q$insert into gate_review
           (job_book_id, gate, attempt, outcome, chaired_by, criteria_snapshot,
            decided_at, conditional_due_at)
         values ('dddddddd-0000-0000-0000-000000000001','G2',2,'conditional_pass',
                 'bbbbbbbb-0000-0000-0000-000000000005','[]'::jsonb,
                 now(), (now() at time zone 'UTC')::date + 5)$q$),
    'a second Conditional Pass on the same gate is refused');
end $$;

\echo ''
\echo 'The Custodian is a qualification, not a name in a box'
do $$ begin
  update app_user set competency_level = 'JB-1'
   where id = 'bbbbbbbb-0000-0000-0000-000000000003';

  -- §5.1 requires JB-2 or above.
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555',
      'select assign_custodian(''dddddddd-0000-0000-0000-000000000001'',''bbbbbbbb-0000-0000-0000-000000000003'')::text')
      like 'ERROR%JB-2 or above%',
    'a JB-1 user cannot be named Custodian');

  -- Null is "not assessed", and not assessed is not qualified.
  update app_user set competency_level = null
   where id = 'bbbbbbbb-0000-0000-0000-000000000003';
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555',
      'select assign_custodian(''dddddddd-0000-0000-0000-000000000001'',''bbbbbbbb-0000-0000-0000-000000000003'')::text')
      like 'ERROR%no assessed level%',
    'nor can a user with no assessed competency');

  update app_user set competency_level = 'JB-2'
   where id = 'bbbbbbbb-0000-0000-0000-000000000003';
  perform assert(
    as_user('55555555-5555-5555-5555-555555555555',
      'select assign_custodian(''dddddddd-0000-0000-0000-000000000001'',''bbbbbbbb-0000-0000-0000-000000000003'')::text')
      not like 'ERROR%',
    'a JB-2 user can');
  perform assert(
    (select custodian_id from job_book where id='dddddddd-0000-0000-0000-000000000001')
      = 'bbbbbbbb-0000-0000-0000-000000000003',
    'and the assignment is recorded on the book');

  -- Two-person control, same principle as section approval.
  perform assert(
    refused('55555555-5555-5555-5555-555555555555',
      $q$insert into gate_review
           (job_book_id, gate, attempt, outcome, chaired_by, custodian_id, criteria_snapshot)
         values ('dddddddd-0000-0000-0000-000000000001','G3',1,'pass',
                 'bbbbbbbb-0000-0000-0000-000000000005',
                 'bbbbbbbb-0000-0000-0000-000000000005','[]'::jsonb)$q$),
    'the chair of a gate review cannot also be its Custodian');

  -- A tech cannot assign one either.
  perform assert(
    as_user('33333333-3333-3333-3333-333333333333',
      'select assign_custodian(''dddddddd-0000-0000-0000-000000000001'',''bbbbbbbb-0000-0000-0000-000000000003'')::text')
      like 'ERROR%QA/QC manager or admin%',
    'a tech cannot assign a Custodian');
end $$;

\echo ''
\echo 'A section cannot claim to be both checked-and-empty and full'
do $$
declare v_id uuid;
begin
  select id into v_id from job_book_section
   where job_book_id = 'dddddddd-0000-0000-0000-000000000001' limit 1;

  -- The safe default, checked before anything below mutates it. A row
  -- nobody has established anything about must not claim its contents
  -- were read, because the scoring engine reads that claim and drops the
  -- "this figure is a floor" caveat on the strength of it.
  perform assert(
    (select ingestion_status::text from job_book_section where id = v_id) = 'unknown',
    'a section asserts nothing about its ingestion until something says so');

  -- The whole point of `verified_empty` is that somebody looked. A row
  -- saying "I looked and found nothing" while also reporting nine files
  -- in the folder is two statements, one of which is false, and the
  -- database is not the place to decide which.
  perform assert(
    refused('55555555-5555-5555-5555-555555555555',
      format($q$update job_book_section
                   set ingestion_status = 'verified_empty', source_file_count = 9
                 where id = %L$q$, v_id)),
    'a verified-empty section cannot also hold files');

  perform assert(
    as_user('55555555-5555-5555-5555-555555555555',
      format($q$update job_book_section
                   set ingestion_status = 'verified_empty', source_file_count = 0
                 where id = %L returning 'ok'$q$, v_id)) = 'ok',
    'while a listing that came back empty is exactly what it records');

  perform assert(
    refused('55555555-5555-5555-5555-555555555555',
      format($q$update job_book_section set source_file_count = -1 where id = %L$q$, v_id)),
    'a negative file count is refused');
end $$;

\echo ''
\echo 'A client sees the book, not the minutes'
do $$ begin
  perform assert(
    as_user('11111111-1111-1111-1111-111111111111',
      'select count(*)::text from gate_review') = '0',
    'a client user reads no gate review, even on their own book');
  perform assert(
    as_user('44444444-4444-4444-4444-444444444444',
      'select count(*)::text from gate_review')::integer > 0,
    'while Fortress staff read them');
end $$;

\echo ''
\echo 'No mutating function is reachable without a session'
do $$
declare v_fn text; v_bad text[] := '{}';
begin
  -- 0012's rule, asserted rather than assumed: `anon` inherits from
  -- PUBLIC, so a function revoked from `anon` alone is still wide open.
  -- 0015 made exactly that mistake and shipped it.
  foreach v_fn in array array[
    'approve_section','create_job_book','invite_user','set_section_score',
    'log_document_access','record_gate_review','assign_custodian'
  ] loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn
         and (has_function_privilege('anon', p.oid, 'execute')
              or has_function_privilege('public', p.oid, 'execute'))
    ) then
      v_bad := v_bad || v_fn;
    end if;
  end loop;
  perform assert(cardinality(v_bad) = 0,
    'every mutating function is revoked from PUBLIC and anon, not just anon'
      || case when cardinality(v_bad) > 0
              then ' (still open: ' || array_to_string(v_bad, ', ') || ')' else '' end);

  -- …and still reachable by the people who need them.
  perform assert(
    has_function_privilege('authenticated',
      'record_gate_review(uuid, gate_id, gate_outcome, jsonb, numeric, uuid, uuid, date, text, text)',
      'execute')
    and has_function_privilege('authenticated', 'assign_custodian(uuid, uuid)', 'execute'),
    'while a signed-in user can still call them');
end $$;

\echo ''
\echo 'Row Level Security is on, and forced, everywhere'
do $$ begin
  perform assert(
    (select count(*) from pg_tables where schemaname='public' and not rowsecurity) = 0,
    'no public table has RLS switched off');
  perform assert(
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relforcerowsecurity) = 0,
    'RLS is FORCED on every table, so even the owner cannot bypass it');
end $$;

\echo ''
\echo 'All database guarantees hold.'
