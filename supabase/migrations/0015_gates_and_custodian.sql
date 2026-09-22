-- ---------------------------------------------------------------------
-- FDS-JBMP-001 §5, §6, §7 — the governance spine.
--
-- Until now the app measured a job book and said nothing about who owned
-- it or whether it was allowed to advance. The program's force comes from
-- exactly those two things, and §2 names their absence as root causes 1
-- and 2 of the baseline review:
--
--   "No single named person owned a job book. Ownership was implied by
--    proximity to the work."
--
-- So: a book gets a Custodian, and it gets gates.
--
-- WHAT A GATE REVIEW IS. §7: "A gate review is a documented decision, not
-- a conversation." Three outcomes — Pass, Conditional Pass with a dated
-- action list, Fail. The rule that gives gates their force is the ten-day
-- ceiling on a Conditional Pass, issuable once per gate, after which it
-- becomes a Fail and escalates to the VP the same day.
--
-- WHY THE CRITERIA ARE SNAPSHOTTED. A gate decision asserts something
-- about the book ON THE DAY IT WAS TAKEN. Re-deriving those criteria later
-- would answer a different question, and would quietly rewrite history
-- every time a record changed. The evaluation travels with the decision,
-- frozen, the same reasoning that put `computed_pct` on the section row.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not let the database decide a
-- gate. Several criteria (peer-audit score, client confirmation, lessons
-- learned held) are human attestations by construction, and several others
-- depend on the Tier 1/2/3 audit model that does not exist yet. The domain
-- engine reports those as INDETERMINATE rather than met, and a chair who
-- passes a gate on an indeterminate criterion has to say so in writing.
-- Silence is never scored as compliance.
-- ---------------------------------------------------------------------

create type gate_id        as enum ('G0','G1','G2','G3','G4','G5');
create type gate_outcome   as enum ('pass','conditional_pass','fail');

-- §5.1 / FDS-JBMP-004. A Custodian holds JB-2 or above; a Peer Auditor
-- holds JB-3. Competency is a property of the person, not of the book, and
-- gate criteria read it.
create type competency_level as enum ('JB-1','JB-2','JB-3','JB-4');

alter table app_user
  add column competency_level competency_level,
  add column competency_granted_at date,
  add column competency_granted_by uuid references app_user(id);

comment on column app_user.competency_level is
  'FDS-JBMP-004 competency. JB-2 or above may hold Custodian; JB-3 or above
   may perform a Tier 2 peer audit. Null means not yet assessed, which is
   not the same as JB-1 and must never be read as qualified.';

-- ---------------------------------------------------------------------
-- §5: "Every job book has exactly one Custodian." Named at Gate 0, in
-- writing, and appearing on every gate review and every submission.
-- ---------------------------------------------------------------------
alter table job_book
  add column custodian_id          uuid references app_user(id),
  add column custodian_assigned_at timestamptz,
  add column custodian_assigned_by uuid references app_user(id),
  -- §6.2. The curve is agreed at Gate 0 against the construction schedule
  -- and defaults to the program's milestones. Stored as the book's own
  -- copy because a later revision of the program must not silently move
  -- the bar a running book is measured against.
  add column planned_curve         jsonb,
  -- Set once a gate is decided; kept denormalised so a book list can show
  -- where every book stands without replaying every review.
  add column current_gate          gate_id,
  add column current_gate_at       timestamptz;

-- §7 Gate 0: "Section expected by dates set against the construction
-- schedule." The section already declares HOW MUCH it will hold
-- (expected_count, 0005); this declares WHEN. Without it a book can be
-- behind and look merely incomplete.
alter table job_book_section
  add column expected_by date;

comment on column job_book_section.expected_by is
  'FDS-JBMP-001 §7 Gate 0. The date this section is expected to be complete,
   set from the construction schedule. Null means no date was set, which is
   a Gate 0 criterion unmet, not a section with no deadline.';

-- Having a curve is not the same as having agreed one. Gate 0 checks the
-- agreement.
alter table job_book
  add column planned_curve_agreed_at date,
  add column planned_curve_agreed_by uuid references app_user(id);

comment on column job_book.planned_curve is
  'FDS-JBMP-001 §6.2 planned completion curve: an array of
   {milestone, minimumPct} agreed at Gate 0. Actual weighted completion is
   reported against it weekly.';

-- The program default, applied to books that have not set their own. A
-- book still has to AGREE it at Gate 0 — having a curve is not the same as
-- having agreed one, so Gate 0 checks the agreement, not the column.
alter table job_book alter column planned_curve set default
  '[{"milestone":"gate_0_passed","minimumPct":8},
    {"milestone":"construction_25","minimumPct":25},
    {"milestone":"construction_50","minimumPct":50},
    {"milestone":"mechanical_completion","minimumPct":85},
    {"milestone":"gate_4_entry","minimumPct":98},
    {"milestone":"submission","minimumPct":100}]'::jsonb;

-- Books that already exist adopt the program default.
update job_book
   set planned_curve = '[{"milestone":"gate_0_passed","minimumPct":8},
    {"milestone":"construction_25","minimumPct":25},
    {"milestone":"construction_50","minimumPct":50},
    {"milestone":"mechanical_completion","minimumPct":85},
    {"milestone":"gate_4_entry","minimumPct":98},
    {"milestone":"submission","minimumPct":100}]'::jsonb
 where planned_curve is null;

-- ---------------------------------------------------------------------
-- The decision record. Form FDS-JB-F06.
-- ---------------------------------------------------------------------
create table gate_review (
  id                uuid primary key default gen_random_uuid(),
  job_book_id       uuid not null references job_book(id) on delete cascade,
  gate              gate_id not null,
  -- A gate may be reviewed more than once: a Fail is re-reviewed, and a
  -- Conditional Pass that lapses is re-decided. Attempts are numbered so
  -- "failed the same gate twice" (§7) is a query, not an interpretation.
  attempt           integer not null default 1,
  outcome           gate_outcome not null,

  -- §7: chaired by the QA/QC Manager, attended by the Custodian and the
  -- Project Manager. All three are recorded because the program makes the
  -- gate a project milestone co-signed by the PM, not a QA/QC formality.
  chaired_by        uuid not null references app_user(id),
  custodian_id      uuid references app_user(id),
  project_manager_id uuid references app_user(id),
  decided_at        timestamptz not null default now(),

  -- The criteria as they stood when the decision was taken. Frozen.
  criteria_snapshot jsonb not null,
  -- Weighted completion at the moment of decision, for the §6.2 curve.
  completion_pct    numeric(5,2),

  -- Conditional Pass only. §7 caps the window at ten calendar days.
  conditional_due_at date,
  cleared_at        timestamptz,
  cleared_by        uuid references app_user(id),

  -- A chair who passes a gate while a criterion is unmet or unevaluable
  -- has to say why, in writing, on the record.
  override_note     text,
  notes             text,

  created_at        timestamptz not null default now(),

  unique (job_book_id, gate, attempt),

  -- §7: "A Conditional Pass carries a maximum of ten calendar days."
  constraint conditional_has_due_date check (
    (outcome <> 'conditional_pass') or conditional_due_at is not null
  ),
  constraint conditional_window_is_ten_days check (
    conditional_due_at is null
    or conditional_due_at <= (decided_at at time zone 'UTC')::date + 10
  ),
  -- A clean Pass carries no dated action list and no clearing step.
  constraint pass_carries_no_conditions check (
    outcome <> 'pass' or (conditional_due_at is null and cleared_at is null)
  ),
  constraint cleared_is_attributed check (
    cleared_at is null or cleared_by is not null
  ),
  -- Two-person control, same principle as section approval: the chair may
  -- not be the Custodian of the book being gated.
  constraint chair_is_not_custodian check (
    custodian_id is null or chaired_by <> custodian_id
  )
);

create index gate_review_book_idx on gate_review (job_book_id, gate, attempt desc);

-- §7: a Conditional Pass "may be issued once per gate".
create unique index gate_review_one_conditional_per_gate
  on gate_review (job_book_id, gate)
  where outcome = 'conditional_pass';

comment on table gate_review is
  'FDS-JBMP-001 §7 gate review, form FDS-JB-F06. Append-mostly: a row is
   written when the decision is taken and afterwards only its clearing
   fields move. Every change is captured by the audit trigger.';

-- ---------------------------------------------------------------------
-- The dated action list that a Conditional Pass carries. §7 gives the
-- list its teeth: items are dated, owned, and closed with evidence — the
-- same shape as an NCR, because that is what they are.
-- ---------------------------------------------------------------------
create table gate_condition (
  id              uuid primary key default gen_random_uuid(),
  gate_review_id  uuid not null references gate_review(id) on delete cascade,
  criterion_id    text,                 -- which criterion it answers, if any
  description     text not null,
  owner_id        uuid not null references app_user(id),
  due_at          date not null,
  closed_at       timestamptz,
  closed_by       uuid references app_user(id),
  closure_note    text,
  created_at      timestamptz not null default now(),

  -- §11: findings "are not closed verbally".
  constraint closure_is_attributed check (
    closed_at is null or (closed_by is not null and closure_note is not null)
  )
);

create index gate_condition_review_idx on gate_condition (gate_review_id);

-- ---------------------------------------------------------------------
-- §11.5 — an NCR carries an owner and a due date, and ages against it.
-- Gate 1 reads "zero open NCRs past due date", which the flag table could
-- not answer: it had an assignee but no date to be late against.
-- ---------------------------------------------------------------------
alter table compliance_flag
  add column due_at        date,
  add column escalated_at  timestamptz;

comment on column compliance_flag.due_at is
  'FDS-JBMP-001 §11.5. An NCR with no due date cannot be past due, so gate
   criteria treat a dateless open Critical or Major finding as unmet rather
   than as compliant.';

-- ---------------------------------------------------------------------
-- Advancing the book. The gate decides the phase; nothing else may.
-- ---------------------------------------------------------------------
create or replace function record_gate_review(
  p_book              uuid,
  p_gate              gate_id,
  p_outcome           gate_outcome,
  p_criteria          jsonb,
  p_completion_pct    numeric default null,
  p_custodian         uuid default null,
  p_project_manager   uuid default null,
  p_conditional_due   date default null,
  p_override_note     text default null,
  p_notes             text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_chair    uuid := current_app_user_id();
  v_attempt  integer;
  v_id       uuid;
  v_unmet    integer;
begin
  if v_chair is null then
    raise exception 'no authenticated app user';
  end if;

  -- §5.1: "The only role authorized to submit a job book to a client" also
  -- chairs gate reviews. A tech cannot pass their own book forward.
  if not is_manager_or_admin() then
    raise exception 'only a QA/QC manager or admin may chair a gate review';
  end if;

  if not can_write_job_book(p_book) then
    raise exception 'not authorised for this job book';
  end if;

  -- A Pass or Conditional Pass taken while criteria are unmet or could not
  -- be evaluated is allowed — the chair is the decision-maker, not the
  -- app — but it must be explained. An unexplained override is refused.
  select count(*) into v_unmet
    from jsonb_array_elements(p_criteria) c
   where c->>'state' in ('not_met','indeterminate');

  if p_outcome <> 'fail' and v_unmet > 0
     and coalesce(length(trim(p_override_note)), 0) = 0 then
    raise exception
      'gate % has % unmet or unevaluable criteria; an override note is required',
      p_gate, v_unmet;
  end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt
    from gate_review where job_book_id = p_book and gate = p_gate;

  insert into gate_review (
    job_book_id, gate, attempt, outcome, chaired_by, custodian_id,
    project_manager_id, criteria_snapshot, completion_pct,
    conditional_due_at, override_note, notes
  ) values (
    p_book, p_gate, v_attempt, p_outcome, v_chair,
    coalesce(p_custodian, (select custodian_id from job_book where id = p_book)),
    p_project_manager, p_criteria, p_completion_pct,
    p_conditional_due, nullif(trim(p_override_note), ''), nullif(trim(p_notes), '')
  ) returning id into v_id;

  -- The book advances only on a clean Pass. A Conditional Pass is a
  -- promise, not an advance: §7 makes it lapse into a Fail if the window
  -- closes uncleared, and a book that had already moved on would then be
  -- standing past a gate it did not pass.
  if p_outcome = 'pass' then
    update job_book
       set current_gate = p_gate, current_gate_at = now()
     where id = p_book;
  end if;

  return v_id;
end $$;

revoke execute on function record_gate_review(
  uuid, gate_id, gate_outcome, jsonb, numeric, uuid, uuid, date, text, text
) from anon;

-- ---------------------------------------------------------------------
-- Assigning the Custodian. §5: one book, one Custodian, JB-2 or above,
-- named in writing by the QA/QC Manager.
-- ---------------------------------------------------------------------
create or replace function assign_custodian(p_book uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_level competency_level;
begin
  if not is_manager_or_admin() then
    raise exception 'only a QA/QC manager or admin may assign a Custodian';
  end if;
  if not can_write_job_book(p_book) then
    raise exception 'not authorised for this job book';
  end if;

  select competency_level into v_level from app_user
   where id = p_user and deleted_at is null and is_active;

  if not found then
    raise exception 'no such active user';
  end if;

  -- Null is "not assessed", and not assessed is not qualified.
  if v_level is null or v_level = 'JB-1' then
    raise exception
      'Custodian requires competency JB-2 or above (FDS-JBMP-001 §5.1); user holds %',
      coalesce(v_level::text, 'no assessed level');
  end if;

  update job_book
     set custodian_id = p_user,
         custodian_assigned_at = now(),
         custodian_assigned_by = current_app_user_id()
   where id = p_book;
end $$;

revoke execute on function assign_custodian(uuid, uuid) from anon;

-- ---------------------------------------------------------------------
-- RLS. Gate reviews are Fortress-internal governance: a client sees the
-- book, not the minutes of the meeting where Fortress decided whether to
-- let it advance.
-- ---------------------------------------------------------------------
alter table gate_review enable row level security;
alter table gate_review force row level security;
alter table gate_condition enable row level security;
alter table gate_condition force row level security;

create policy gate_review_read on gate_review for select using (
  is_fortress_staff() and can_read_job_book(job_book_id)
);
create policy gate_review_write on gate_review for all
  using (is_manager_or_admin() and can_write_job_book(job_book_id))
  with check (is_manager_or_admin() and can_write_job_book(job_book_id));

create policy gate_condition_read on gate_condition for select using (
  exists (select 1 from gate_review r
           where r.id = gate_review_id
             and is_fortress_staff() and can_read_job_book(r.job_book_id))
);
-- A condition is closed by the person who owns it, which is usually the
-- Custodian, so writing here is open to any Fortress writer on the book.
create policy gate_condition_write on gate_condition for all
  using (exists (select 1 from gate_review r
                  where r.id = gate_review_id and can_write_job_book(r.job_book_id)))
  with check (exists (select 1 from gate_review r
                       where r.id = gate_review_id and can_write_job_book(r.job_book_id)));

-- ---------------------------------------------------------------------
-- Audit. Both new tables join the append-only trail.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['gate_review','gate_condition'] loop
    execute format(
      'create trigger %I_audit after insert or update or delete on %I
         for each row execute function audit_trigger()', t, t);
  end loop;
end $$;
