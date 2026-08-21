-- =====================================================================
-- Facility job book support.
--
-- Greeley Crescent DP-318 is the first facility book in the system. It
-- differs from a flowline book in five ways, and each one is a schema
-- change rather than a branch in application code, so that a third book
-- type later is configuration again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Optional, off-checklist sections.
--
-- Distinct from supplemental. A supplemental section is never scored — it
-- is a home for documents that arrived without a category. An optional
-- section carries real weight when a job enables it and leaves the
-- denominator entirely when it does not, so enabling coating inspection
-- can lower a book's percentage and disabling it can never raise one.
-- ---------------------------------------------------------------------
alter table section_definition
  add column is_optional boolean not null default false;

comment on column section_definition.is_optional is
  'Off the governing checklist but scored when a job enables it, e.g.
   section 23 Coating Inspection. Enabled per job via
   job_book.enabled_optional_sections.';

alter table job_book
  add column enabled_optional_sections text[] not null default '{}',
  add column business_unit             text,
  add column qaqc_representative       text,
  -- Facility work is divided into construction areas; the denominator for
  -- per-area sections such as coating inspection.
  add column construction_areas        text[] not null default '{}',
  -- Used for the inspection-tier calculation where a weld row carries no
  -- design pressure of its own.
  add column default_design_pressure_psi numeric(10,2);

-- ---------------------------------------------------------------------
-- 2. Work organised by construction area, not by line.
--
-- weld_line remains the grouping entity for both book types, because
-- everything consuming it asks the same question either way — which group
-- is this weld in. Only the label changes.
-- ---------------------------------------------------------------------
create type weld_grouping_kind as enum ('line', 'construction_area');

alter table weld_line
  add column grouping_kind weld_grouping_kind not null default 'line';

alter table weld
  add column construction_area text,
  add column equipment_tag     text,
  add column isometric_number  text,
  add column pressure_test_ref text;

create index weld_area_idx on weld(job_book_id, construction_area) where deleted_at is null;
create index weld_iso_idx  on weld(job_book_id, isometric_number)  where deleted_at is null;

-- ---------------------------------------------------------------------
-- 3. One welder stamp per weld, not four pass assignments.
--
-- Both shapes coexist on the same table. A facility weld populates
-- welder_id and leaves the four pass columns null; the rollups read
-- whichever is present, so per-welder percentages, qualification checks
-- and continuity are computed by one code path for both book types.
-- ---------------------------------------------------------------------
alter table weld
  add column welder_stamp text,
  add column welder_id    uuid references welder(id);

alter table weld add constraint weld_has_one_welder_shape check (
  -- Either the four-pass shape or the single-stamp shape, never both.
  welder_id is null
  or (root_welder_id is null and hot_welder_id is null
      and fill_welder_id is null and cap_welder_id is null)
);

-- ---------------------------------------------------------------------
-- 4. Required torque is a range.
--
-- A facility log specifies 130-260 ft-lb rather than a single figure, so
-- "is the actual within spec" is a containment test rather than a
-- tolerance guess. A point value sets both bounds and reads identically.
-- ---------------------------------------------------------------------
alter table torque_connection
  add column required_torque_min_ft_lb numeric(10,2),
  add column required_torque_max_ft_lb numeric(10,2);

alter table torque_connection add constraint torque_range_ordered check (
  required_torque_min_ft_lb is null
  or required_torque_max_ft_lb is null
  or required_torque_min_ft_lb <= required_torque_max_ft_lb
);

-- Backfill the existing flowline books: a point value is a degenerate range.
update torque_connection
   set required_torque_min_ft_lb = required_torque_ft_lb,
       required_torque_max_ft_lb = required_torque_ft_lb
 where required_torque_ft_lb is not null
   and required_torque_min_ft_lb is null;

-- ---------------------------------------------------------------------
-- 5. Pipe engineering inputs, per weld.
--
-- A facility weld log derives each weld's inspection obligation from the
-- pipe rather than from a flat job-wide percentage, so these are per-weld.
-- The derived values (hoop stress, % SMYS, tier) are deliberately NOT
-- stored: they are recomputed from these inputs whenever an input or a
-- tier rule changes, and a stored copy would go stale silently.
-- ---------------------------------------------------------------------
alter table weld
  add column pipe_size_schedule   text,
  add column pipe_grade           text,
  add column design_pressure_psi  numeric(10,2);

-- NPS reference dimensions, imported from the weld log's own
-- 'NPS and Dimensions' sheet so a book's tiers are reproducible against
-- the table that produced them.
create table nps_dimension (
  id             uuid primary key default gen_random_uuid(),
  book_template_id uuid references book_template(id),
  job_book_id    uuid references job_book(id) on delete cascade,
  size_schedule  text not null,
  nps            text not null,
  schedule       text not null,
  od_in          numeric(8,4) not null check (od_in > 0),
  wall_in        numeric(8,4) not null check (wall_in > 0),
  source         text not null default 'ASME B36.10M',
  created_at     timestamptz not null default now(),
  unique (job_book_id, size_schedule)
);

-- ---------------------------------------------------------------------
-- Inspection tier rules.
--
-- In a table rather than in code because the 20% SMYS break point is
-- INFERRED from the Greeley workbook, not quoted from a code clause, and
-- still needs QA/QC confirmation. Confirming it — or moving it to 30% for
-- a different operator's spec — is a row edit and a recomputation, not a
-- deploy. `is_confirmed` lets the UI say which it is next to any number
-- derived from it.
-- ---------------------------------------------------------------------
create table inspection_tier_rule (
  id                    uuid primary key default gen_random_uuid(),
  book_template_id      uuid references book_template(id),
  job_book_id           uuid references job_book(id) on delete cascade,
  rule_key              text not null,
  sort_order            integer not null default 0,
  min_pct_smys          numeric(6,4) not null check (min_pct_smys >= 0),
  max_pct_smys          numeric(6,4) check (max_pct_smys is null or max_pct_smys > min_pct_smys),
  tier                  text not null,
  required_ndt_fraction numeric(5,4) not null default 0
    check (required_ndt_fraction >= 0 and required_ndt_fraction <= 1),
  requires_full_visual  boolean not null default true,
  is_confirmed          boolean not null default false,
  note                  text,
  created_at            timestamptz not null default now()
);

comment on table inspection_tier_rule is
  'Bands of % SMYS and the inspection each requires. The 20% break point is
   inferred from the DP-318 weld log and unconfirmed; is_confirmed marks
   whether QA/QC has signed off on a band.';

-- Coating inspection records, one per construction area (section 23).
create table coating_inspection (
  id                 uuid primary key default gen_random_uuid(),
  job_book_id        uuid not null references job_book(id) on delete cascade,
  construction_area  text not null,
  inspection_date    date,
  inspector          text,
  -- Photographs filed with no readings count as started, not as done.
  has_structured_data boolean not null default false,
  document_count     integer not null default 0,
  notes              text,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (job_book_id, construction_area)
);

-- ---------------------------------------------------------------------
-- Isolation and audit for the new tables, on the same shared predicates
-- as everything else. A record type added without these would be a hole.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['nps_dimension','inspection_tier_rule','coating_inspection'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create trigger %I_audit after insert or update or delete on %I
         for each row execute function audit_trigger()', t, t);
  end loop;
end $$;

create policy coating_inspection_read on coating_inspection for select
  using (can_read_job_book(job_book_id));
create policy coating_inspection_write on coating_inspection for all
  using (can_write_job_book(job_book_id))
  with check (can_write_job_book(job_book_id));

-- Reference tables: readable where the owning book is, or globally when
-- attached to a template rather than a job.
create policy nps_dimension_read on nps_dimension for select
  using (job_book_id is null or can_read_job_book(job_book_id));
create policy nps_dimension_write on nps_dimension for all
  using (is_fortress_writer()) with check (is_fortress_writer());

create policy tier_rule_read on inspection_tier_rule for select
  using (job_book_id is null or can_read_job_book(job_book_id));
-- Moving a tier threshold changes every derived inspection obligation in
-- the book, so it is an admin action, not a tech's.
create policy tier_rule_write on inspection_tier_rule for all
  using (is_manager_or_admin()) with check (is_manager_or_admin());
