-- ---------------------------------------------------------------------
-- FDS-JBMP-001 §8 — Entry Timeliness.
--
-- Root cause 1 of the baseline review, in the program's own words:
--
--   "Job book assembly was treated as a closeout activity rather than a
--    construction activity, so records were reconstructed from memory
--    weeks after the work."
--
-- §6.1 calls progressive documentation "the single change that makes
-- every other control in this program work", and §8 is how it is
-- measured. The application already stored the work date on every record.
-- It never stored when the record was ENTERED, so the one comparison the
-- program asks for could not be made at all.
--
-- TWO DATES, NOT ONE. §8.3: "The date used is the work date carried on the
-- record, not the date the file was saved." So each measurable event gets
-- a work date (already present) and an entry stamp (new). Where one
-- record carries two events with different standards — a weld is completed
-- AND visually inspected, and §8.1 gives those different deadlines and
-- different responsible parties — it gets two entry stamps.
--
-- WHY entry_source EXISTS, AND WHY IT IS NULLABLE. A record migrated out
-- of a delivered 2024 book was never "entered" under this program. Timing
-- it against §8 would produce a number that looks like catastrophic
-- non-compliance and means nothing, and a metric that is meaningless the
-- first time somebody reads it is a metric nobody reads again. So a row
-- declares how it arrived, and the rate is computed over field entries
-- only. Rows that declare nothing are reported as unmeasurable — counted,
-- named, and never folded into the percentage in either direction.
--
-- WHAT THIS DOES NOT DO. It does not stop a late entry. §8.3 is explicit:
-- "A record entered late is entered accurately and flagged late; it is
-- never back dated." Blocking the entry is how you teach people to
-- back-date, and back-dating is a Level 4 accountability event under §14.
-- ---------------------------------------------------------------------

create type entry_source as enum (
  -- Entered by a person against work that had just happened. The only
  -- kind §8 can measure.
  'field_entry',
  -- Loaded in bulk from a legacy book, a spreadsheet or a folder tree.
  -- Real evidence, but its entry date says nothing about the crew.
  'bulk_import'
);

-- §8: "a scheduled working day for the crew performing the work". Crews on
-- these jobs do not all work Monday to Friday, and the difference moves
-- every deadline in §8.1, so it is a property of the book rather than an
-- assumption in the code.
alter table job_book
  add column work_week text not null default 'mon_fri'
    check (work_week in ('mon_fri','mon_sat','all_days'));

comment on column job_book.work_week is
  'FDS-JBMP-001 §8: "Business day means a scheduled working day for the crew
   performing the work." Set per book from the crew schedule. It is the
   denominator of every entry standard in §8.1.';

do $$
declare t text;
begin
  foreach t in array array[
    'weld','torque_connection','nde_report','pressure_test',
    'cp_test_point','ut_reading','material_heat','coating_inspection'
  ] loop
    execute format(
      'alter table %I
         add column entered_at timestamptz,
         add column entry_source entry_source', t);
    execute format(
      'comment on column %I.entered_at is %L', t,
      'FDS-JBMP-001 §8. When this record was entered in the job book, to be '
      || 'compared against the work date it carries. Null means the entry '
      || 'time is unknown, which excludes the record from the Entry '
      || 'Timeliness Rate rather than counting it as on time.');
  end loop;
end $$;

-- §8.1 gives a weld two events with different standards and different
-- owners: "Weld completed — end of next business day — Field Supervisor to
-- Custodian", and "CWI visual inspection performed — end of same business
-- day — Certified Welding Inspector". One stamp cannot answer both.
alter table weld add column visual_entered_at timestamptz;
alter table torque_connection add column inspection_entered_at timestamptz;

-- §8.1: "Material received on site — at receipt, before release to
-- install." That is a precondition, and it cannot be checked at all
-- without knowing when the material arrived.
alter table material_heat add column received_on date;

comment on column material_heat.received_on is
  'FDS-JBMP-001 §8.1 and §8.2 precondition 4: the MTR is captured against
   the heat at receipt, not at closeout. Null means the receipt date was
   never recorded, so the precondition cannot be shown to have been met.';

-- The rate is computed per book over a date range, so the scan is always
-- (book, entered_at).
create index weld_entered_idx              on weld (job_book_id, entered_at);
create index torque_entered_idx            on torque_connection (job_book_id, entered_at);
create index nde_report_entered_idx        on nde_report (job_book_id, entered_at);
create index pressure_test_entered_idx     on pressure_test (job_book_id, entered_at);
create index cp_test_point_entered_idx     on cp_test_point (job_book_id, entered_at);
create index ut_reading_entered_idx        on ut_reading (job_book_id, entered_at);
create index material_heat_entered_idx     on material_heat (job_book_id, entered_at);
create index coating_inspection_entered_idx on coating_inspection (job_book_id, entered_at);

-- ---------------------------------------------------------------------
-- The weekly measurement. §8.3 calculates the rate per book per week and
-- escalates a book below 90% for two consecutive weeks.
--
-- Stored rather than always derived, for the same reason the section score
-- is cached: the weekly number is a REPORTED figure that a Project Manager
-- acts on, and it has to keep saying what it said at the time even after
-- the underlying records move.
-- ---------------------------------------------------------------------
create table timeliness_period (
  id             uuid primary key default gen_random_uuid(),
  job_book_id    uuid not null references job_book(id) on delete cascade,
  -- The Monday of the week measured.
  period_start   date not null,
  period_end     date not null,
  within_standard integer not null,
  total_measured  integer not null,
  -- Entered, but not measurable: bulk imports and records whose entry time
  -- was never recorded. Kept visible so a high rate over four records
  -- cannot be mistaken for a high rate over four hundred.
  unmeasurable    integer not null default 0,
  rate_pct        numeric(5,2),
  computed_at     timestamptz not null default now(),
  escalated_at    timestamptz,
  unique (job_book_id, period_start),
  constraint counts_are_sane check (
    within_standard >= 0 and total_measured >= within_standard and unmeasurable >= 0
  ),
  -- A period with nothing to measure has no rate. Zero would read as
  -- total failure; null reads as "no records were entered this week",
  -- which is what it means.
  constraint rate_matches_counts check (
    (total_measured = 0 and rate_pct is null) or (total_measured > 0 and rate_pct is not null)
  )
);

create index timeliness_period_book_idx on timeliness_period (job_book_id, period_start desc);

alter table timeliness_period enable row level security;
alter table timeliness_period force row level security;

-- Internal performance measurement. A client sees the book's completeness,
-- not how promptly Fortress's crews file their paperwork.
create policy timeliness_period_read on timeliness_period for select using (
  is_fortress_staff() and can_read_job_book(job_book_id)
);
create policy timeliness_period_write on timeliness_period for all
  using (is_fortress_writer() and can_write_job_book(job_book_id))
  with check (is_fortress_writer() and can_write_job_book(job_book_id));

create trigger timeliness_period_audit
  after insert or update or delete on timeliness_period
  for each row execute function audit_trigger();
