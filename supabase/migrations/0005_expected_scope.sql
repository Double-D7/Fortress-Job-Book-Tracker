-- =====================================================================
-- Declared scope.
--
-- Every percentage in this application is a fraction, and before this
-- migration the denominator was "records entered so far". That makes a
-- partly-entered section read as complete: 100 joints typed out of 2,342,
-- all of them filled in correctly, scored 100%.
--
-- expected_count is the denominator declared at job setup from the drawing
-- set. It is a floor, not a cap — the scoring engine takes
-- max(expected, actual), so a job that runs bigger than scoped cannot push
-- a section past 100%, and a scope guessed low cannot make a half-finished
-- section look finished.
-- =====================================================================

alter table job_book_section
  add column expected_count integer
    check (expected_count is null or expected_count >= 0);

comment on column job_book_section.expected_count is
  'Records or documents this section is expected to hold when complete,
   declared at job setup. The scoring denominator. Null means undeclared,
   in which case the section scores against what exists.';

-- Joints per line, off the isometrics. Summed across lines, this scopes
-- section 12 more accurately than a single book-wide figure.
alter table weld_line
  add column expected_weld_count integer
    check (expected_weld_count is null or expected_weld_count >= 0);

comment on column weld_line.expected_weld_count is
  'Joints this line is expected to carry, from the isometric.';

-- ---------------------------------------------------------------------
-- Scaffold a new book with all checklist sections in one transaction.
--
-- A book that exists with only some of its sections is worse than no book:
-- its percentage is computed over a partial denominator and reads high.
-- Creating the sections here, rather than in application code, means a
-- book cannot come into existence half-scaffolded.
-- ---------------------------------------------------------------------
create or replace function create_job_book(
  p_project_id       uuid,
  p_book_type        book_type,
  p_job_number       text,
  p_header           jsonb default '{}'::jsonb,
  p_thresholds       jsonb default '{}'::jsonb,
  -- [{"section_number": "12", "expected_count": 2342}, ...]
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
    project_id, book_template_id, book_type, job_number,
    facility_name, drill_pad_name, well_names, construction_company,
    welding_company, cwi_names, pipe_size_in, pipe_schedule, pipe_grade,
    status, target_turnover_date, construction_start, construction_end,
    required_xray_pct, required_torque_inspect_pct, torque_tolerance_pct,
    cert_expiry_warning_days, created_by
  ) values (
    p_project_id, v_template.id, p_book_type, p_job_number,
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
        -- Scoping a section to zero is a statement that it has no work in
        -- it, which is what N/A means. A zero denominator would instead
        -- park it at 0% forever.
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
