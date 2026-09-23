-- ---------------------------------------------------------------------
-- Division: who runs the job.
--
-- `book_type` has been doing two jobs. It says which checklist a book is
-- scored against — which sections apply and what each is weighted — and
-- it has also been standing in for which part of the business the work
-- belongs to. Those were the same thing while there were only two
-- values, and Maintenance is what separates them: a maintenance job is
-- scored against the facility checklist, because that genuinely is the
-- right checklist for it, and belongs under Maintenance on the
-- portfolio.
--
-- So this is a new column rather than a third value on `book_type`.
-- Adding 'maintenance' there would have meant inventing a maintenance
-- checklist before a maintenance job could exist — and a percentage
-- complete against a checklist somebody made up is worse than no
-- percentage at all, because it looks like a measurement.
--
-- NULLABLE ON PURPOSE. `divisionOf()` in the application falls back to
-- `book_type`, so a book with no division recorded keeps appearing
-- exactly where it did. The backfill below makes the existing rows
-- explicit anyway; the fallback is there for any row that arrives later
-- without one, and for the seed provider, which has no column at all.
-- ---------------------------------------------------------------------

create type division as enum ('flowline', 'facility', 'maintenance');

alter table job_book add column division division;

comment on column job_book.division is
  'Which part of the business runs this job. Distinct from book_type, '
  'which decides the checklist it is scored against: a maintenance job '
  'is scored against the facility checklist. Null falls back to book_type.';

-- Every book that exists today. Their division has always been their
-- book type; this just writes down what was already true.
update job_book set division = book_type::text::division where division is null;

create index job_book_division on job_book (division) where deleted_at is null;

-- ---------------------------------------------------------------------
-- Carried on the header rather than as a new argument.
--
-- 0012 locked the RPC surface by exact signature — `revoke ... from
-- public, anon` then `grant ... to authenticated`, naming every type. A
-- new parameter would be a new function, which would arrive with the
-- default grants and none of the revokes, quietly reopening what 0012
-- closed. `p_header` is already jsonb and already carries every other
-- optional field, so division goes there and the signature is untouched.
-- ---------------------------------------------------------------------
create or replace function create_job_book(
  p_project_id       uuid,
  p_book_type        book_type,
  p_job_number       text,
  p_header           jsonb default '{}'::jsonb,
  p_thresholds       jsonb default '{}'::jsonb,
  p_scope            jsonb default '[]'::jsonb
) returns job_book
language plpgsql security definer set search_path = public
as $$
declare
  v_actor    app_user;
  v_template book_template;
  v_book     job_book;
  v_def      section_definition;
  v_expected integer;
  v_applies  boolean;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role not in ('fortress_admin','qaqc_manager') then
    raise exception 'creating a job book requires QA/QC Manager or Admin'
      using errcode = '42501';
  end if;

  select * into v_template
    from book_template
   where book_type = p_book_type and is_active
   order by version desc
   limit 1;
  if v_template.id is null then
    raise exception 'no active template for book type %', p_book_type using errcode = 'P0002';
  end if;

  insert into job_book (
    project_id, book_template_id, book_type, division, job_number,
    facility_name, drill_pad_name, well_names, construction_company,
    welding_company, cwi_names, pipe_size_in, pipe_schedule, pipe_grade,
    status, target_turnover_date, construction_start, construction_end,
    required_xray_pct, required_torque_inspect_pct, torque_tolerance_pct,
    cert_expiry_warning_days, created_by
  ) values (
    p_project_id, v_template.id, p_book_type,
    -- Defaults to the book type, which is what it meant before this
    -- column existed. An unrecognised value is a caller error and the
    -- enum cast raises, rather than silently filing the job nowhere.
    coalesce((p_header ->> 'division')::division, p_book_type::text::division),
    p_job_number,
    p_header ->> 'facility_name',
    p_header ->> 'drill_pad_name',
    coalesce((select array_agg(value) from jsonb_array_elements_text(
      coalesce(p_header -> 'well_names', '[]'::jsonb))), '{}'),
    p_header ->> 'construction_company',
    p_header ->> 'welding_company',
    coalesce((select array_agg(value) from jsonb_array_elements_text(
      coalesce(p_header -> 'cwi_names', '[]'::jsonb))), '{}'),
    p_header ->> 'pipe_size_in',
    p_header ->> 'pipe_schedule',
    p_header ->> 'pipe_grade',
    'setup',
    (p_header ->> 'target_turnover_date')::date,
    (p_header ->> 'construction_start')::date,
    (p_header ->> 'construction_end')::date,
    coalesce((p_thresholds ->> 'required_xray_pct')::numeric, 10),
    coalesce((p_thresholds ->> 'required_torque_inspect_pct')::numeric, 10),
    coalesce((p_thresholds ->> 'torque_tolerance_pct')::numeric, 5),
    coalesce((p_thresholds ->> 'cert_expiry_warning_days')::integer, 60),
    v_actor.id
  ) returning * into v_book;

  -- Unchanged from 0005, verbatim. The scoped-to-zero rule and the
  -- na_reason sentences are load-bearing: a section scoped to zero is
  -- N/A rather than 0%, or it parks at nought forever on a zero
  -- denominator. Nothing about division touches any of it — a
  -- maintenance book scaffolds from the facility template exactly as a
  -- facility book does, which is the whole point.
  for v_def in
    select * from section_definition
     where book_template_id = v_template.id
     order by sort_order
  loop
    v_applies := v_def.applies_to = 'both' or v_def.applies_to::text = p_book_type::text;
    select (elem ->> 'expected_count')::integer into v_expected
      from jsonb_array_elements(p_scope) elem
     where elem ->> 'section_number' = v_def.section_number
     limit 1;

    insert into job_book_section (
      job_book_id, section_definition_id, status, na_reason, expected_count
    ) values (
      v_book.id, v_def.id,
      case
        when not v_applies then 'na'
        when v_expected = 0 then 'na'
        else 'not_started'
      end,
      case
        when not v_applies then v_def.applies_to || '-only section; not applicable to a '
                               || p_book_type || ' book.'
        when v_expected = 0 then 'Scoped to zero at job setup — this job has no work of this kind.'
      end,
      case when v_expected > 0 then v_expected end
    );
  end loop;

  return v_book;
end;
$$;

comment on function create_job_book is
  'Create a job book and scaffold its sections in one transaction. The '
  'division travels on p_header so the signature — and the grants 0012 '
  'pinned to it — stay exactly as they were.';
