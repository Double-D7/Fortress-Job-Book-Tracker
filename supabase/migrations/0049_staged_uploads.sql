-- ---------------------------------------------------------------------
-- 0049 — staging, so a document never travels through a function body
--
-- Uploading marked-up isometrics failed with "Could not reach the
-- server". The server had answered: it refused the request for being
-- too large. Every document in this application was being posted as a
-- multipart body to a serverless function, and the platform caps that
-- body at a few megabytes — well under the 512 MB the route's own
-- guard advertises, and well under one section's worth of scans.
--
-- The fix is to stop sending bytes through the function at all. The
-- browser uploads each file straight to storage with a signed URL, and
-- the function is told only where the bytes landed.
--
-- ## Why there is a table and not just a path convention
--
-- The route's contract has always been that the SERVER hashes the
-- bytes that actually arrived:
--
--     "A client-supplied hash would make the duplicate check a matter
--      of the browser's word, and the duplicate check is one of the
--      things this application exists to do."
--
-- That still holds, and direct upload does not weaken it. The server
-- reads each staged object back out of storage and hashes it itself.
--
-- The hash is recorded here so that the commit does not have to read
-- the bytes a second time. Preview hashes; commit reads the hash this
-- table holds — server-computed, never client-supplied — and then
-- MOVES the object into its final content-addressed path, which
-- storage does without transferring anything. One read of the bytes
-- per upload instead of two, and none at all through the function body.
--
-- ## Why staging lives under the book id
--
-- `storage_object_book_id()` (0010) reads the first path segment as
-- the book uuid, and every storage policy is built on it. Staging at
-- `<book id>/_staging/<upload id>/<n>` therefore inherits exactly the
-- access rules a finished document has, with no new storage policy to
-- get wrong. A section number never begins with an underscore, so the
-- two namespaces cannot collide.
-- ---------------------------------------------------------------------

create table if not exists staged_upload (
  id uuid primary key default gen_random_uuid(),

  -- One batch of files chosen together. The client holds this between
  -- uploading and committing, and it is what the preview and the
  -- commit name instead of sending bytes.
  upload_id uuid not null,

  job_book_id uuid not null references job_book(id) on delete cascade,
  section_number text not null,

  storage_path text not null unique,
  original_filename text not null,
  byte_size bigint not null,
  mime_type text,

  -- Null until the preview has read the object back and hashed it.
  -- Never written from a request body: `stage_uploads` cannot set it
  -- and `record_staged_hash` is the only thing that does.
  sha256 text,

  -- What the tech typed on the form: type code, identifier, document
  -- date. Carried so the commit classifies the same way the preview
  -- did rather than trusting a second copy from the browser.
  classification jsonb not null default '{}'::jsonb,

  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  -- Set when the object has been moved into the book. A consumed row
  -- is kept briefly so a double-clicked commit is idempotent rather
  -- than an error.
  consumed_at timestamptz,

  constraint staged_upload_size_positive check (byte_size > 0),
  constraint staged_upload_sha_shape
    check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists staged_upload_batch
  on staged_upload (upload_id) where consumed_at is null;
create index if not exists staged_upload_sweep
  on staged_upload (created_at) where consumed_at is null;

alter table staged_upload enable row level security;
alter table staged_upload force row level security;

-- The same authority as writing a document to the book, because that
-- is what staging is the first half of.
drop policy if exists staged_upload_read on staged_upload;
create policy staged_upload_read on staged_upload for select
  using (can_write_job_book(job_book_id));

drop policy if exists staged_upload_write on staged_upload;
create policy staged_upload_write on staged_upload for all
  using (can_write_job_book(job_book_id))
  with check (can_write_job_book(job_book_id));

comment on table staged_upload is
  'Files uploaded straight to storage by the browser and not yet filed '
  'into a section. Exists so document bytes never pass through a '
  'serverless function body, which the platform caps far below one '
  'section''s worth of scans. The sha256 is computed by the server '
  'from the stored object, never supplied by the client.';

-- ---------------------------------------------------------------------
-- Recording a hash the server computed.
--
-- Separated from the table's write policy so that the one column the
-- integrity of the duplicate check rests on is written by exactly one
-- named thing, and that thing takes the hash as an argument rather
-- than from a request.
-- ---------------------------------------------------------------------
create or replace function record_staged_hash(
  p_staged_id uuid,
  p_sha256    text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_book uuid;
begin
  if p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'not a sha256' using errcode = '22023';
  end if;

  select job_book_id into v_book from staged_upload where id = p_staged_id;
  if v_book is null then
    raise exception 'no such staged upload' using errcode = 'P0002';
  end if;
  if not can_write_job_book(v_book) then
    raise exception 'not authorised for this job book' using errcode = '42501';
  end if;

  update staged_upload set sha256 = p_sha256 where id = p_staged_id;
end $$;

revoke all on function record_staged_hash(uuid, text) from public, anon;
grant execute on function record_staged_hash(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Sweeping what was never committed.
--
-- A tech who picks the wrong folder and closes the tab leaves objects
-- in `_staging` that no row will ever point at. Unswept, a section's
-- worth of abandoned scans sits in the bucket indefinitely.
--
-- Returns the paths it removed rows for; the caller deletes the
-- objects, because storage is not reachable from SQL.
-- ---------------------------------------------------------------------
create or replace function sweep_staged_uploads(p_older_than interval default '24 hours')
returns table (storage_path text)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  with gone as (
    delete from staged_upload
     where created_at < now() - p_older_than
       and consumed_at is null
    returning staged_upload.storage_path
  )
  select gone.storage_path from gone;
end $$;

-- `authenticated` too, not just public and anon. Supabase grants
-- execute to `authenticated` explicitly, so revoking from PUBLIC alone
-- leaves it callable by any signed-in user — and this function is
-- SECURITY DEFINER with no per-book check, so one tech could wipe
-- another's in-flight batch.
revoke all on function sweep_staged_uploads(interval)
  from public, anon, authenticated;

comment on function sweep_staged_uploads is
  'Delete staging rows older than the interval that were never '
  'committed, returning their storage paths so the caller can remove '
  'the objects. Service-role only: it is a cleanup job, not a user '
  'action.';
