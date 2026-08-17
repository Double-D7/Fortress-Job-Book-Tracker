-- =====================================================================
-- Fortress Job Book Tracker — core schema
-- Two book types (flowline | facility) share one schema. The section
-- template is data-driven: a new book type is configuration, not a
-- migration.
-- =====================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------------------------------------------------------------------
-- Controlled vocabularies. These exist as enums specifically because the
-- source data proves free text does not survive contact with the field
-- ("ASME XI" for "ASME IX", four spellings of one welder's name).
-- ---------------------------------------------------------------------
create type book_type          as enum ('flowline', 'facility');
create type job_book_status    as enum ('setup','in_progress','ready_for_review','submitted','accepted','archived');
create type section_status     as enum ('not_started','in_progress','ready_for_review','approved','na');
create type requirement_type   as enum ('document','personnel_certs','equipment_certs','records','derived','supplemental');
create type user_role          as enum ('fortress_admin','qaqc_manager','qaqc_tech','fortress_read_only','client_user','third_party_inspector');
create type applies_to         as enum ('flowline','facility','both');
create type ndt_method         as enum ('RT','PT','MT','UT');
create type pass_fail          as enum ('Pass','Fail');
create type weld_status        as enum ('planned','welded','visual_complete','ndt_complete','not_used','cut_out');
create type joint_type         as enum ('Butt','O-let','Socket','Branch');
create type qualification_code as enum ('ASME_IX','API_1104');
create type mtr_status         as enum ('on_file','missing','illegible','unidentified');
create type doc_visibility     as enum ('internal','client','inspector');
create type flag_severity      as enum ('critical','warning','info');
create type flag_state         as enum ('open','acknowledged','resolved','dismissed');
create type cert_subject_type  as enum ('welder','cwi','ndt_technician','torque_wrench','pressure_recorder');

-- ---------------------------------------------------------------------
-- Organizations, users, access
-- ---------------------------------------------------------------------
create table client_org (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  logo_url    text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,                    -- maps to auth.users.id
  email         citext not null unique,
  full_name     text not null,
  role          user_role not null,
  client_org_id uuid references client_org(id),
  sso_subject   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- A client user is meaningless without an org; a Fortress user must not
  -- carry one, or client isolation would leak in both directions.
  constraint client_user_has_org check (
    (role = 'client_user' and client_org_id is not null)
    or (role <> 'client_user' and (client_org_id is null or role = 'third_party_inspector'))
  )
);

create table project (
  id               uuid primary key default gen_random_uuid(),
  client_org_id    uuid not null references client_org(id),
  name             text not null,
  operator_pic_name text,
  afe_number       text,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table job_book (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references project(id),
  book_template_id      uuid not null,          -- fk added after book_template
  book_type             book_type not null,
  job_number            text not null,
  facility_name         text,
  drill_pad_name        text,
  well_names            text[] not null default '{}',
  construction_company  text,
  welding_company       text,
  cwi_names             text[] not null default '{}',
  pipe_size_in          text,
  pipe_schedule         text,
  pipe_grade            text,
  status                job_book_status not null default 'setup',
  target_turnover_date  date,
  -- Construction window. Reports and records dated outside it are flagged.
  construction_start    date,
  construction_end      date,
  -- The as-of date the field logs were closed against. Records dated after
  -- this are "future-dated" relative to the log itself — the single most
  -- common transcription error in these books.
  data_as_of_date       date,
  -- Per-job compliance thresholds. These are operator-spec driven, never
  -- hard-coded.
  required_xray_pct         numeric(5,2) not null default 10.00,
  required_torque_inspect_pct numeric(5,2) not null default 10.00,
  torque_tolerance_pct      numeric(5,2) not null default 5.00,
  cert_expiry_warning_days  integer not null default 60,
  -- Which welder on a split-pass joint receives X-ray credit.
  xray_credit_rule      text not null default 'all_passes' check (
    xray_credit_rule in ('all_passes','root_welder','cap_welder')
  ),
  created_by            uuid references app_user(id),
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  unique (project_id, job_number)
);

create table job_assignment (
  job_book_id   uuid not null references job_book(id) on delete cascade,
  user_id       uuid not null references app_user(id),
  assigned_role text not null,
  assigned_at   timestamptz not null default now(),
  primary key (job_book_id, user_id)
);

create table inspector_grant (
  id          uuid primary key default gen_random_uuid(),
  job_book_id uuid not null references job_book(id) on delete cascade,
  user_id     uuid not null references app_user(id),
  expires_at  timestamptz,
  can_comment boolean not null default false,
  granted_by  uuid references app_user(id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (job_book_id, user_id)
);

-- ---------------------------------------------------------------------
-- Section templates. Versioned so historical scores stay reproducible.
-- ---------------------------------------------------------------------
create table book_template (
  id             uuid primary key default gen_random_uuid(),
  book_type      book_type not null,
  version        integer not null,
  effective_date date not null,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (book_type, version)
);

alter table job_book
  add constraint job_book_template_fk
  foreign key (book_template_id) references book_template(id);

create table section_definition (
  id                 uuid primary key default gen_random_uuid(),
  book_template_id   uuid not null references book_template(id) on delete cascade,
  section_number     text not null,             -- text: flowline uses "19-22"
  sort_order         integer not null,
  title              text not null,             -- verbatim from the checklist
  applies_to         applies_to not null default 'both',
  weight             numeric(6,2) not null default 0,
  requirement_type   requirement_type not null,
  min_documents      integer not null default 1,
  linked_record_type text,
  is_required        boolean not null default true,
  -- Supplemental sections (e.g. the Flexpipe DFRs delivered in DP452 that
  -- appear nowhere on the checklist) carry weight 0 and never distort the
  -- percentage.
  is_supplemental    boolean not null default false,
  notes              text,
  unique (book_template_id, section_number)
);

create table job_book_section (
  id                    uuid primary key default gen_random_uuid(),
  job_book_id           uuid not null references job_book(id) on delete cascade,
  section_definition_id uuid not null references section_definition(id),
  status                section_status not null default 'not_started',
  na_reason             text,
  ready_for_review_by   uuid references app_user(id),
  ready_for_review_at   timestamptz,
  approved_by           uuid references app_user(id),
  approved_at           timestamptz,
  computed_pct          numeric(5,2) not null default 0,
  internal_notes        text,                   -- never exposed to clients
  unique (job_book_id, section_definition_id),
  -- Two-person control: approval must be recorded with an approver, and the
  -- approver may not be the tech who marked it ready. Enforced again in the
  -- approve_section() function.
  constraint approval_is_attributed check (
    (status <> 'approved') or (approved_by is not null and approved_at is not null)
  ),
  constraint approver_is_not_submitter check (
    approved_by is null or ready_for_review_by is null or approved_by <> ready_for_review_by
  )
);

-- ---------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------
create table document (
  id                     uuid primary key default gen_random_uuid(),
  job_book_id            uuid not null references job_book(id) on delete cascade,
  section_id             uuid references job_book_section(id),
  record_type            text,                  -- polymorphic attachment target
  record_id              uuid,
  original_filename      text not null,
  normalized_filename    text not null,
  storage_path           text not null,
  mime_type              text,
  byte_size              bigint,
  sha256                 text not null,
  page_count             integer,
  version                integer not null default 1,
  supersedes_document_id uuid references document(id),
  is_superseded          boolean not null default false,
  visibility             doc_visibility not null default 'internal',
  uploaded_by            uuid references app_user(id),
  uploaded_at            timestamptz not null default now(),
  approved_by            uuid references app_user(id),
  approved_at            timestamptz,
  -- Soft delete only. Nothing in a compliance record is ever destroyed.
  deleted_at             timestamptz,
  deleted_by             uuid references app_user(id),
  delete_reason          text
);
create index document_book_idx    on document(job_book_id) where deleted_at is null;
create index document_section_idx on document(section_id)  where deleted_at is null;
create index document_sha_idx     on document(job_book_id, sha256);
create index document_record_idx  on document(record_type, record_id);

-- ---------------------------------------------------------------------
-- Personnel and equipment
-- ---------------------------------------------------------------------
create table welder (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null,
  initials    text not null,
  employer    text,
  active      boolean not null default true,
  -- The source data carries four spellings of one man's name. Welders are a
  -- managed entity keyed by initials + qualification record; the misspellings
  -- live here as aliases so imports resolve to one person.
  name_aliases text[] not null default '{}',
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (initials)
);

create table welder_qualification (
  id                      uuid primary key default gen_random_uuid(),
  welder_id               uuid not null references welder(id) on delete cascade,
  code                    qualification_code not null,
  process                 text,
  qualification_date      date not null,
  expiry_date             date,
  continuity_last_verified date,
  document_id             uuid references document(id),
  created_at              timestamptz not null default now(),
  deleted_at              timestamptz
);

create table cwi (
  id         uuid primary key default gen_random_uuid(),
  full_name  text not null,
  initials   text not null,
  employer   text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table ndt_technician (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  initials       text,
  employer       text,
  classification text,                          -- Formal | VAR | PQC
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create table torque_wrench (
  id                   uuid primary key default gen_random_uuid(),
  wrench_id            text not null,
  capacity_ft_lb       numeric(10,2),
  last_calibration_date date,
  calibration_due_date  date,
  cert_document_id     uuid references document(id),
  cert_on_file         boolean not null default false,
  -- Present in the log's roster header block, as opposed to merely used.
  on_roster            boolean not null default false,
  created_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (wrench_id)
);

-- One shape for every certificate. Validity is always evaluated against the
-- date the work was performed, never merely against today.
create table certificate (
  id           uuid primary key default gen_random_uuid(),
  job_book_id  uuid references job_book(id) on delete cascade,
  subject_type cert_subject_type not null,
  subject_id   uuid not null,
  cert_type    text not null,
  issuing_body text,
  issue_date   date not null,
  expiry_date  date,
  document_id  uuid references document(id),
  verified_by  uuid references app_user(id),
  verified_at  timestamptz,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index certificate_subject_idx on certificate(subject_type, subject_id);

-- ---------------------------------------------------------------------
-- Weld records — the heaviest entity
-- ---------------------------------------------------------------------
create table weld_line (
  id               uuid primary key default gen_random_uuid(),
  job_book_id      uuid not null references job_book(id) on delete cascade,
  line_code        text not null,               -- FL1..FL25, FWT, MMB, A-1..G-1
  line_description text,
  workbook         text,                        -- 'Flow Lines' | 'Gas Lift'
  well_name        text,
  drill_pad_name   text,
  facility_name    text,
  operator_pic     text,
  welding_company  text,
  pipe_size        text,
  pipe_schedule    text,
  pipe_grade       text,
  service_type     text,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (job_book_id, line_code)
);

create table weld (
  id                     uuid primary key default gen_random_uuid(),
  weld_line_id           uuid not null references weld_line(id) on delete cascade,
  job_book_id            uuid not null references job_book(id) on delete cascade,
  weld_number            text not null,         -- text: "NP-2" repairs exist
  sort_order             integer not null default 0,
  weld_date              date,
  welder_pass_assignment text,                  -- "HS2/HS2/CT/CT" Root/Hot/Fill/Cap
  root_welder_id         uuid references welder(id),
  hot_welder_id          uuid references welder(id),
  fill_welder_id         uuid references welder(id),
  cap_welder_id          uuid references welder(id),
  joint_type             joint_type,
  component_description  text,
  part_length            text,
  heat_numbers           text[] not null default '{}',
  cwi_initials           text,
  cwi_id                 uuid references cwi(id),
  cwi_visual_result      pass_fail,             -- null = not yet inspected
  visual_inspection_date date,
  ndt_company            text,
  xray_number            text,
  ndt_ticket_number      text,
  ndt_method             ndt_method,
  ndt_result             pass_fail,
  ndt_report_id          uuid,
  status                 weld_status not null default 'planned',
  comments               text,                  -- internal only
  -- Optimistic concurrency for the shared grid.
  row_version            integer not null default 1,
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  unique (weld_line_id, weld_number)
);
create index weld_book_idx  on weld(job_book_id) where deleted_at is null;
create index weld_line_idx  on weld(weld_line_id) where deleted_at is null;
create index weld_date_idx  on weld(job_book_id, weld_date);
create index weld_heat_idx  on weld using gin (heat_numbers);

-- ---------------------------------------------------------------------
-- Torque records
-- ---------------------------------------------------------------------
create table torque_connection (
  id                   uuid primary key default gen_random_uuid(),
  job_book_id          uuid not null references job_book(id) on delete cascade,
  iso_flange_number    text not null,
  iso_number           text,
  flange_pipe_size     text,
  bolt_diameter        text,
  bolt_count           integer,
  required_torque_ft_lb numeric(10,2),
  actual_torque_ft_lb   numeric(10,2),
  wrench_id            uuid references torque_wrench(id),
  wrench_id_raw        text,                    -- as recorded, before resolution
  cp_test_on_flange    boolean not null default false,
  torque_date          date,
  employee_initials    text,
  inspection_date      date,
  inspector_initials   text,
  status               text not null default 'recorded',
  row_version          integer not null default 1,
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index torque_book_idx on torque_connection(job_book_id) where deleted_at is null;

-- ---------------------------------------------------------------------
-- NDE reports
-- ---------------------------------------------------------------------
create table nde_report (
  id                    uuid primary key default gen_random_uuid(),
  job_book_id           uuid not null references job_book(id) on delete cascade,
  report_number         text,
  report_date           date not null,
  ndt_company           text,
  method                ndt_method not null,
  procedure_reference   text,
  revision              text,
  acceptance_criteria   text,
  technician_id         uuid references ndt_technician(id),
  work_order_number     text,
  client_po_afe         text,
  equipment_model       text,
  equipment_serial      text,
  equipment_cal_due_date date,
  -- Free text as printed on the report. Compared against the job book's own
  -- facility/pad to catch a document filed into the wrong book.
  referenced_facility   text,
  referenced_pad        text,
  document_id           uuid references document(id),
  supersedes_report_id  uuid references nde_report(id),
  is_superseded         boolean not null default false,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

create table nde_report_line (
  id            uuid primary key default gen_random_uuid(),
  nde_report_id uuid not null references nde_report(id) on delete cascade,
  weld_id       uuid references weld(id),
  part_number   text,
  weld_number   text,                            -- as printed, may not resolve
  result        pass_fail,
  location      text,
  welder_code   text,
  weld_joint    text,
  weld_size     text,
  weld_schedule text,
  indications   text
);
create index nde_line_weld_idx on nde_report_line(weld_id);

alter table weld add constraint weld_ndt_report_fk
  foreign key (ndt_report_id) references nde_report(id);

-- ---------------------------------------------------------------------
-- Materials
-- ---------------------------------------------------------------------
create table material_heat (
  id                uuid primary key default gen_random_uuid(),
  job_book_id       uuid not null references job_book(id) on delete cascade,
  heat_number       text not null,
  component_type    text,
  nominal_size      text,
  schedule_or_class text,
  grade             text,
  description       text,
  mtr_document_id   uuid references document(id),
  mtr_status        mtr_status not null default 'missing',
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (job_book_id, heat_number)
);

-- ---------------------------------------------------------------------
-- Pressure testing, cathodic protection, ultrasonic baselines
-- ---------------------------------------------------------------------
create table pressure_test (
  id                     uuid primary key default gen_random_uuid(),
  job_book_id            uuid not null references job_book(id) on delete cascade,
  test_identifier        text not null,
  line_codes             text[] not null default '{}',
  test_date              date,
  test_medium            text,
  test_pressure_psi      numeric(10,2),
  duration_minutes       integer,
  result                 pass_fail,
  recorder_serial        text,
  recorder_cert_id       uuid references certificate(id),
  chart_document_id      uuid references document(id),
  witnessed_by           text,
  created_at             timestamptz not null default now(),
  deleted_at             timestamptz
);

create table cp_test_point (
  id                  uuid primary key default gen_random_uuid(),
  job_book_id         uuid not null references job_book(id) on delete cascade,
  test_point_id       text not null,
  location            text,
  torque_connection_id uuid references torque_connection(id),
  baseline_potential_v numeric(8,3),
  reading_date        date,
  technician          text,
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create table ut_reading (
  id             uuid primary key default gen_random_uuid(),
  job_book_id    uuid not null references job_book(id) on delete cascade,
  location_id    text not null,
  description    text,
  nominal_wall   numeric(8,4),
  measured_wall  numeric(8,4),
  reading_date   date,
  technician_id  uuid references ndt_technician(id),
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- ---------------------------------------------------------------------
-- Compliance flags
-- ---------------------------------------------------------------------
create table compliance_flag (
  id              uuid primary key default gen_random_uuid(),
  job_book_id     uuid not null references job_book(id) on delete cascade,
  rule_id         text not null,
  severity        flag_severity not null,
  title           text not null,
  detail          text not null,
  entity_type     text,
  entity_id       uuid,
  section_number  text,
  fingerprint     text not null,                -- stable id for dedupe across runs
  state           flag_state not null default 'open',
  assigned_to     uuid references app_user(id),
  resolution_note text,
  resolved_by     uuid references app_user(id),
  resolved_at     timestamptz,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique (job_book_id, fingerprint),
  -- Resolution always carries a reason. Auditors ask.
  constraint resolution_has_note check (
    state not in ('resolved','dismissed') or (resolution_note is not null and resolved_by is not null)
  )
);
create index flag_open_idx on compliance_flag(job_book_id, severity) where state = 'open';

-- Inspector comments, when the grant enables them.
create table inspector_comment (
  id          uuid primary key default gen_random_uuid(),
  job_book_id uuid not null references job_book(id) on delete cascade,
  section_id  uuid references job_book_section(id),
  document_id uuid references document(id),
  author_id   uuid not null references app_user(id),
  body        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Score snapshots. The weights are versioned, so a score computed last
-- quarter can be reproduced exactly.
-- ---------------------------------------------------------------------
create table score_snapshot (
  id               uuid primary key default gen_random_uuid(),
  job_book_id      uuid not null references job_book(id) on delete cascade,
  book_template_id uuid not null references book_template(id),
  overall_pct      numeric(5,2) not null,
  breakdown_json   jsonb not null,
  computed_at      timestamptz not null default now()
);
