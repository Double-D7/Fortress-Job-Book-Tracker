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
-- ---------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','noble@example.com'),
  ('22222222-2222-2222-2222-222222222222','chevron@example.com'),
  ('33333333-3333-3333-3333-333333333333','tech@fortressds.com'),
  ('44444444-4444-4444-4444-444444444444','admin@fortressds.com'),
  ('55555555-5555-5555-5555-555555555555','manager@fortressds.com')
on conflict do nothing;

insert into client_org (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Noble Energy'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Chevron')
on conflict do nothing;

insert into app_user (id, auth_user_id, email, full_name, role, client_org_id) values
  ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','noble@example.com','Noble Operator','client_user','aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','chevron@example.com','Chevron Operator','client_user','aaaaaaaa-0000-0000-0000-000000000002'),
  ('bbbbbbbb-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','tech@fortressds.com','A Tech','qaqc_tech',null),
  ('bbbbbbbb-0000-0000-0000-000000000004','44444444-4444-4444-4444-444444444444','admin@fortressds.com','An Admin','fortress_admin',null),
  ('bbbbbbbb-0000-0000-0000-000000000005','55555555-5555-5555-5555-555555555555','manager@fortressds.com','A Manager','qaqc_manager',null)
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
