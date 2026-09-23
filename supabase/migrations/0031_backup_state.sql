-- ---------------------------------------------------------------------
-- What the nightly backup has already written.
--
-- Supabase's own backups are a rolling window of days. §15 retention is
-- years, and the two are not the same promise: a document deleted in
-- March is gone from a seven-day window by April while the standard still
-- requires it. This is the cold copy that outlives the window, in the
-- folder shape the books arrived in.
--
-- The table exists so a run can be incremental. One facility book is
-- roughly 850MB — section 15 alone is 286MB — so re-uploading everything
-- nightly is not a slow version of the right answer, it is a different
-- and unaffordable thing. A run writes what changed and nothing else.
--
-- `sha256` is what makes "changed" mean changed. Comparing timestamps
-- would re-upload a book every time a row was touched for an unrelated
-- reason, and comparing nothing at all would miss a document replaced
-- with one of the same size.
-- ---------------------------------------------------------------------

create type backup_object_kind as enum ('document', 'mtr', 'data_export');

create table backup_object (
  id            uuid primary key default gen_random_uuid(),

  kind          backup_object_kind not null,
  -- The document id, the mtr_document id, or for a generated export the
  -- path that identifies it. Text because those three are not one type,
  -- and a foreign key here would delete backup history when a record is
  -- hard-deleted — which is the opposite of the point.
  source_key    text not null,

  job_book_id   uuid references job_book(id) on delete set null,

  -- Where it was written, relative to the backup root. Kept so a later
  -- run can move a file rather than guess where it put it.
  remote_path   text not null,
  sha256        text not null,
  byte_size     bigint,

  written_at    timestamptz not null default now(),
  -- Set when the file has been moved into _superseded. It stays in this
  -- table afterwards: knowing a document was backed up and then replaced
  -- is part of the record.
  superseded_at timestamptz,

  constraint remote_path_not_blank check (btrim(remote_path) <> '')
);

-- One live backup row per source. A superseded row keeps its history, so
-- the uniqueness only binds what is currently in place.
create unique index backup_object_live
  on backup_object (kind, source_key) where superseded_at is null;

create index backup_object_book on backup_object (job_book_id);
create index backup_object_sha on backup_object (sha256);

comment on table backup_object is
  'One row per file the nightly backup has written to the archive folder, '
  'with the hash that decides whether it needs writing again.';

-- ---------------------------------------------------------------------
-- Each run, so a backup that silently stopped is visible.
--
-- The failure this guards against is the only one that matters for a
-- backup: it stops working, nobody notices, and the discovery happens on
-- the day it is needed. A run row exists from the moment a run starts, so
-- an absence of rows is itself the alarm.
-- ---------------------------------------------------------------------
create table backup_run (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  -- 'running' until it ends. A row stuck in 'running' is a run that died
  -- partway, which reads differently from one that failed cleanly.
  status         text not null default 'running',
  files_written  integer not null default 0,
  files_skipped  integer not null default 0,
  files_failed   integer not null default 0,
  bytes_written  bigint not null default 0,
  -- Per-file outcomes, for reading a bad night without server logs.
  detail         jsonb,
  error          text,

  constraint backup_run_status check (status in ('running', 'ok', 'partial', 'failed'))
);

create index backup_run_started on backup_run (started_at desc);

comment on table backup_run is
  'One row per nightly backup attempt. An absence of recent rows means '
  'the backup has stopped, which is the failure worth alarming on.';

-- ---------------------------------------------------------------------
-- Visibility.
--
-- Fortress staff may read both tables: "did last night run" is an
-- operational question they answer. Nobody writes through the API at all
-- — the Edge Function that performs the backup runs as the service role,
-- which is precisely why the key never goes near the web deployment.
-- ---------------------------------------------------------------------
alter table backup_object enable row level security;
alter table backup_object force row level security;
alter table backup_run enable row level security;
alter table backup_run force row level security;

create policy backup_object_read on backup_object for select
  using (is_fortress_staff());

create policy backup_run_read on backup_run for select
  using (is_fortress_staff());

revoke all on backup_object from anon;
revoke all on backup_run from anon;
grant select on backup_object to authenticated;
grant select on backup_run to authenticated;

-- ---------------------------------------------------------------------
-- The question the admin screen and the digest both ask.
-- ---------------------------------------------------------------------
create or replace function backup_health()
returns table (
  last_run_at timestamptz,
  last_status text,
  hours_since numeric,
  files_in_archive bigint,
  bytes_in_archive bigint
) language sql stable security definer set search_path = public as $$
  select
    r.started_at,
    r.status,
    round(extract(epoch from (now() - r.started_at)) / 3600.0, 1),
    (select count(*) from backup_object where superseded_at is null),
    (select coalesce(sum(byte_size), 0) from backup_object where superseded_at is null)
  from backup_run r
  order by r.started_at desc
  limit 1
$$;

revoke all on function backup_health() from public, anon;
grant execute on function backup_health() to authenticated;
