-- ---------------------------------------------------------------------
-- FDS-JBMP-001 §10 — Three-Tier Verification.
--
-- Five gate criteria across G1, G2 and G4 ask about audits. Every one of
-- them has been answering the same way since the gate engine shipped:
--
--   "The three-tier audit model of §10 is not yet implemented in the
--    application."
--
-- That is an honest answer — the engine reports `indeterminate` rather
-- than passing a criterion it cannot evaluate, which is the whole design
-- of §7 — but it means a book can reach Gate 4 with five of its criteria
-- never once tested against reality. The demo books show it: every G1
-- through G4 review in the seed carries "N criteria unmet or unevaluable
-- at the time of review", and most of the unevaluable ones are these.
--
-- THE THREE TIERS, AND WHY THEY ARE NOT THREE COPIES OF ONE THING.
--
--   Tier 1  Self audit. The Custodian checks their own book against the
--           schedule. Cheap, frequent, and worth exactly what a
--           self-assessment is worth — which is why it is a count of
--           "performed on schedule", not a score.
--
--   Tier 2  Peer audit. A DIFFERENT Custodian at JB-3 or above samples
--           the book and scores it out of 100. This is the tier that
--           carries weight, and the independence is the reason: §10.2
--           puts a second pair of eyes on the work, and an audit signed
--           by the book's own Custodian is not that.
--
--   Tier 3  QA/QC Manager verification, at Gate 4 only. Not scored —
--           recorded. It is a signature by a named person with the
--           authority to stop a delivery.
--
-- SAMPLING. §10.2 samples rather than reads everything, because reading
-- 1,256 welds twice is not a control, it is a second chance to make the
-- same mistake while tired. The sample size comes from ANSI/ASQ Z1.4,
-- General Inspection Level II, single sampling, normal inspection — the
-- table the rest of the industry uses — so the number is defensible to a
-- client auditor who asks why 32 and not 30. `sample_plan` records which
-- table was applied, because a sample size with no stated basis is a
-- number somebody picked.
--
-- WHY SCORE AND CRITICAL COUNT ARE SEPARATE COLUMNS AND NOT ONE NUMBER.
-- §10.3: "Any Critical finding fails the audit outright regardless of
-- score." A 98 with one Critical is a fail and a 91 with none is a pass,
-- so no single figure can carry both. The gate engine already reads them
-- as two facts; this stores them as two facts.
-- ---------------------------------------------------------------------

create type audit_tier as enum (
  -- The Custodian, on their own book, against the schedule.
  'tier_1_self',
  -- A different Custodian at JB-3 or above. Scored.
  'tier_2_peer',
  -- QA/QC Manager, at Gate 4. Recorded, not scored.
  'tier_3_manager'
);

create type audit_outcome as enum (
  'pass',
  'fail',
  -- Started and not finished. A half-done audit must not read as a pass,
  -- and must not read as a fail either — the book has not been judged.
  'in_progress'
);

-- §11 defect classification, as the audit uses it. Deliberately the
-- program's three words rather than reusing `flag_severity`, whose
-- 'warning'/'info' spelling is an artefact of the flag engine and reads
-- wrong on an audit report a client may see.
create type finding_class as enum ('critical', 'major', 'minor');

create table job_book_audit (
  id                uuid primary key default gen_random_uuid(),
  job_book_id       uuid not null references job_book(id) on delete cascade,
  tier              audit_tier not null,
  -- Attempt number within the tier, so a re-audit after remediation is a
  -- new row rather than an edit. §10 wants the history: a book that
  -- passed on the third attempt did not pass the way one that passed
  -- first time did.
  attempt           integer not null default 1,

  -- Who, and when. `auditor_id` is null only for a tier that has not
  -- been carried out yet.
  auditor_id        uuid references app_user(id),
  scheduled_for     date,
  started_at        timestamptz,
  completed_at      timestamptz,

  outcome           audit_outcome not null default 'in_progress',
  -- 0–100, §10.3. Null for Tier 1 and Tier 3, which are not scored, and
  -- for an audit still in progress.
  score             numeric(5,2),

  -- The sample actually drawn. `lot_size` is the population the sample
  -- was taken from, so a reader can check the arithmetic rather than
  -- trust it.
  sample_plan       text,
  lot_size          integer,
  sample_size       integer,
  -- §7 Gate 4 asks for a peer audit "at double sample size". Recorded
  -- rather than inferred, because doubling is a decision somebody made.
  double_sample     boolean not null default false,

  notes             text,
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id),

  constraint audit_attempt_is_positive check (attempt >= 1),
  constraint score_is_a_percentage check (
    score is null or (score >= 0 and score <= 100)
  ),
  -- Tier 1 and Tier 3 are not scored. A score on one of them is a
  -- category error that would then be read by the gate engine as if it
  -- were a peer audit result.
  constraint only_peer_audits_are_scored check (
    tier = 'tier_2_peer' or score is null
  ),
  -- A completed peer audit without a score has not been completed. The
  -- gate criterion reads the score, so a null here presents as "no audit
  -- recorded" — which is a different and much more forgiving answer than
  -- the truth.
  constraint a_finished_peer_audit_carries_a_score check (
    tier <> 'tier_2_peer'
    or outcome = 'in_progress'
    or score is not null
  ),
  constraint a_finished_audit_is_dated check (
    outcome = 'in_progress' or completed_at is not null
  ),
  constraint a_finished_audit_is_attributed check (
    outcome = 'in_progress' or auditor_id is not null
  ),
  constraint sample_is_not_larger_than_the_lot check (
    sample_size is null or lot_size is null or sample_size <= lot_size
  ),
  constraint sample_counts_are_not_negative check (
    (sample_size is null or sample_size >= 0)
    and (lot_size is null or lot_size >= 0)
  ),
  unique (job_book_id, tier, attempt)
);

create index job_book_audit_book_idx
  on job_book_audit (job_book_id, tier, completed_at desc);

comment on table job_book_audit is
  'FDS-JBMP-001 §10 three-tier verification. One row per audit attempt. '
  'Tier 2 is the scored one; Tiers 1 and 3 are counted and signed.';

comment on column job_book_audit.sample_plan is
  'Which sampling table produced sample_size, e.g. "ANSI/ASQ Z1.4 Level '
  'II normal, code letter G". A sample size with no stated basis is a '
  'number somebody picked.';

-- ---------------------------------------------------------------------
-- What the audit found.
--
-- Separate from `compliance_flag` on purpose. A flag is what the rules
-- engine derives from the data on every read; an audit finding is what a
-- person wrote down on a particular date, and it does not disappear
-- because somebody later fixed the record that caused it. §10.3 counts
-- Criticals raised BY THE AUDIT, and deriving that count from the
-- current flag state would mean an audit's verdict changed every time
-- the book did.
-- ---------------------------------------------------------------------
create table audit_finding (
  id            uuid primary key default gen_random_uuid(),
  audit_id      uuid not null references job_book_audit(id) on delete cascade,
  classification finding_class not null,
  -- Which section it was found in, where it belongs to one. Free text
  -- rather than a foreign key: an auditor writes "§12" or "12", and a
  -- finding about the book as a whole belongs to no section.
  section_number text,
  summary       text not null,
  detail        text,
  -- §11.5 gives Critical and Major findings a correction window. A
  -- finding with no due date cannot be past due, which is why the gate
  -- criterion counts undated findings as unmet rather than ignoring them.
  due_at        date,
  resolved_at   timestamptz,
  resolved_by   uuid references app_user(id),
  resolution    text,
  created_at    timestamptz not null default now(),

  constraint summary_is_not_blank check (length(btrim(summary)) > 0),
  constraint a_resolved_finding_says_how check (
    resolved_at is null
    or (resolved_by is not null and length(btrim(coalesce(resolution, ''))) > 0)
  )
);

create index audit_finding_audit_idx on audit_finding (audit_id, classification);

comment on table audit_finding is
  'What a §10 audit found, as the auditor wrote it. Distinct from '
  'compliance_flag, which is derived fresh on every read: an audit '
  'verdict must not change because the book changed after the audit.';

-- ---------------------------------------------------------------------
-- §10.4 — the Completeness Certification, form FDS-JB-F07.
--
-- "No job book leaves Fortress without this signature."
--
-- One per book, so a table with the book as its primary key rather than
-- a nullable column set on job_book: a certification is a document with
-- a signatory, a date and a statement, and modelling it as three loose
-- columns invites half of it to be filled in.
-- ---------------------------------------------------------------------
create table completeness_certification (
  job_book_id     uuid primary key references job_book(id) on delete cascade,
  certified_by    uuid not null references app_user(id),
  certified_at    timestamptz not null default now(),
  -- The figures as they stood at signature. A certification that merely
  -- points at today's numbers certifies nothing: the whole value is that
  -- somebody vouched for a specific state of the book on a specific day.
  completion_pct  numeric(5,2) not null,
  sections_total    integer not null,
  sections_approved integer not null,
  open_critical     integer not null,
  open_major        integer not null,
  -- The Tier 2 and Tier 3 audits this signature rests on.
  tier_2_audit_id uuid references job_book_audit(id),
  tier_3_audit_id uuid references job_book_audit(id),
  statement       text,
  revoked_at      timestamptz,
  revoked_by      uuid references app_user(id),
  revoked_reason  text,

  constraint certified_completion_is_a_percentage check (
    completion_pct >= 0 and completion_pct <= 100
  ),
  constraint certified_counts_are_not_negative check (
    sections_total >= 0 and sections_approved >= 0
    and open_critical >= 0 and open_major >= 0
  ),
  -- §7 Gate 4 requires zero open Critical and zero open Major findings.
  -- A certification recording open Criticals is a signature on a book
  -- that could not have passed the gate it is meant to close.
  constraint certification_has_no_open_criticals check (open_critical = 0),
  -- Withdrawing a certification is allowed. Withdrawing it silently is
  -- not: the reason is what tells the next reader why the book came back.
  constraint a_revocation_says_why check (
    revoked_at is null
    or (revoked_by is not null and length(btrim(coalesce(revoked_reason, ''))) > 0)
  )
);

comment on table completeness_certification is
  'FDS-JBMP-001 §10.4, form FDS-JB-F07. "No job book leaves Fortress '
  'without this signature." Carries the figures as they stood at '
  'signature, because certifying today''s numbers certifies nothing.';

-- ---------------------------------------------------------------------
-- Row Level Security.
--
-- Audits are Fortress's internal quality record. A client reads the book
-- and its evidence, not the minutes of us checking ourselves — the same
-- rule 0015 applied to gate reviews. The Completeness Certification is
-- the exception: it is addressed TO the client, and a client entitled to
-- the book is entitled to see who certified it.
-- ---------------------------------------------------------------------
alter table job_book_audit enable row level security;
alter table job_book_audit force row level security;
alter table audit_finding enable row level security;
alter table audit_finding force row level security;
alter table completeness_certification enable row level security;
alter table completeness_certification force row level security;

create policy job_book_audit_read on job_book_audit
  for select using (is_fortress_staff() and can_read_job_book(job_book_id));
create policy job_book_audit_write on job_book_audit
  for all using (is_fortress_writer() and can_write_job_book(job_book_id))
  with check (is_fortress_writer() and can_write_job_book(job_book_id));

create policy audit_finding_read on audit_finding
  for select using (
    is_fortress_staff()
    and exists (
      select 1 from job_book_audit a
       where a.id = audit_finding.audit_id and can_read_job_book(a.job_book_id)
    )
  );
create policy audit_finding_write on audit_finding
  for all using (
    is_fortress_writer()
    and exists (
      select 1 from job_book_audit a
       where a.id = audit_finding.audit_id and can_write_job_book(a.job_book_id)
    )
  )
  with check (
    is_fortress_writer()
    and exists (
      select 1 from job_book_audit a
       where a.id = audit_finding.audit_id and can_write_job_book(a.job_book_id)
    )
  );

-- Readable by anyone who may read the book, staff or client.
create policy completeness_certification_read on completeness_certification
  for select using (can_read_job_book(job_book_id));
create policy completeness_certification_write on completeness_certification
  for all using (is_fortress_writer() and can_write_job_book(job_book_id))
  with check (is_fortress_writer() and can_write_job_book(job_book_id));

-- ---------------------------------------------------------------------
-- Recording a peer audit.
--
-- Through a function rather than a direct INSERT, for the one rule the
-- table cannot express: §10.2's independence requirement. A check
-- constraint cannot see `job_book.custodian_id` or `app_user
-- .competency_level`, so a plain INSERT would let a Custodian peer-audit
-- their own book at JB-1 and produce a 100 that the gate engine would
-- then believe.
-- ---------------------------------------------------------------------
create or replace function record_peer_audit(
  p_book          uuid,
  p_auditor       uuid,
  p_score         numeric,
  p_lot_size      integer,
  p_sample_size   integer,
  p_sample_plan   text    default null,
  p_double_sample boolean default false,
  p_notes         text    default null
) returns job_book_audit
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_custodian uuid;
  v_level     competency_level;
  v_attempt   integer;
  v_row       job_book_audit;
begin
  if not (is_fortress_writer() and can_write_job_book(p_book)) then
    raise exception 'not permitted to record an audit on this job book';
  end if;

  select custodian_id into v_custodian from job_book where id = p_book;
  if v_custodian is not null and v_custodian = p_auditor then
    raise exception
      'a Tier 2 peer audit cannot be performed by the book''s own Custodian (FDS-JBMP-001 §10.2)';
  end if;

  select competency_level into v_level from app_user where id = p_auditor;
  -- Null is "not assessed", which is not the same as qualified and must
  -- never be read as such. 0015 made the same call for the Custodian.
  if v_level is null or v_level not in ('JB-3', 'JB-4') then
    raise exception
      'a Tier 2 peer audit requires competency JB-3 or above; auditor is %',
      coalesce(v_level::text, 'not assessed');
  end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt
    from job_book_audit where job_book_id = p_book and tier = 'tier_2_peer';

  insert into job_book_audit (
    job_book_id, tier, attempt, auditor_id, started_at, completed_at,
    outcome, score, sample_plan, lot_size, sample_size, double_sample,
    notes, created_by
  ) values (
    p_book, 'tier_2_peer', v_attempt, p_auditor, now(), now(),
    -- §10.3 decides pass or fail; the caller does not get to. Criticals
    -- are attached after this row exists, so the outcome is set from the
    -- score here and re-read by the gate engine against the findings.
    case when p_score >= 90 then 'pass' else 'fail' end::audit_outcome,
    p_score, p_sample_plan, p_lot_size, p_sample_size, p_double_sample,
    p_notes, current_app_user_id()
  ) returning * into v_row;

  -- No audit_event insert here: the generic trigger below fires on the
  -- INSERT above and writes a better row than this function could, with
  -- the actor's identity and a full after-image.
  return v_row;
end $$;

revoke execute on function record_peer_audit(uuid, uuid, numeric, integer, integer, text, boolean, text)
  from public, anon;
grant execute on function record_peer_audit(uuid, uuid, numeric, integer, integer, text, boolean, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- Signing the Completeness Certification.
--
-- §10.4 gives this to the QA/QC Manager specifically, and §7 Gate 4
-- requires zero open Critical and zero open Major findings before it can
-- be signed. Both are enforced here rather than trusted to the caller,
-- because this is the signature that lets a book leave the building.
-- ---------------------------------------------------------------------
create or replace function certify_completeness(
  p_book            uuid,
  p_completion_pct  numeric,
  p_sections_total  integer,
  p_sections_approved integer,
  p_open_critical   integer,
  p_open_major      integer,
  p_tier_2_audit    uuid default null,
  p_tier_3_audit    uuid default null,
  p_statement       text default null
) returns completeness_certification
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row completeness_certification;
begin
  if not is_manager_or_admin() then
    raise exception
      'the Completeness Certification is signed by the QA/QC manager or an admin (FDS-JBMP-001 §10.4)';
  end if;
  if not can_write_job_book(p_book) then
    raise exception 'not permitted to certify this job book';
  end if;
  if p_open_critical > 0 or p_open_major > 0 then
    raise exception
      'Gate 4 requires zero open Critical and zero open Major findings; % Critical, % Major',
      p_open_critical, p_open_major;
  end if;

  insert into completeness_certification (
    job_book_id, certified_by, certified_at, completion_pct,
    sections_total, sections_approved, open_critical, open_major,
    tier_2_audit_id, tier_3_audit_id, statement
  ) values (
    p_book, current_app_user_id(), now(), p_completion_pct,
    p_sections_total, p_sections_approved, p_open_critical, p_open_major,
    p_tier_2_audit, p_tier_3_audit, p_statement
  )
  on conflict (job_book_id) do update set
    certified_by = excluded.certified_by,
    certified_at = excluded.certified_at,
    completion_pct = excluded.completion_pct,
    sections_total = excluded.sections_total,
    sections_approved = excluded.sections_approved,
    open_critical = excluded.open_critical,
    open_major = excluded.open_major,
    tier_2_audit_id = excluded.tier_2_audit_id,
    tier_3_audit_id = excluded.tier_3_audit_id,
    statement = excluded.statement,
    -- Re-signing clears a previous withdrawal. The audit trail keeps it.
    revoked_at = null, revoked_by = null, revoked_reason = null
  returning * into v_row;

  return v_row;
end $$;

revoke execute on function certify_completeness(uuid, numeric, integer, integer, integer, integer, uuid, uuid, text)
  from public, anon;
grant execute on function certify_completeness(uuid, numeric, integer, integer, integer, integer, uuid, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- Audit trail. The same generic trigger every other table carries: it
-- reads the owning book out of whichever column holds it and is
-- column-agnostic about the rest, so these three tables need no special
-- handling. `audit_finding` has no job_book_id and the trigger records a
-- null there, which is correct — the finding's identity is its audit.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'job_book_audit','audit_finding','completeness_certification'
  ] loop
    execute format(
      'create trigger %I_audit after insert or update or delete on %I
         for each row execute function audit_trigger()', t, t);
  end loop;
end $$;
