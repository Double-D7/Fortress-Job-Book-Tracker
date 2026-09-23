-- ---------------------------------------------------------------------
-- Storage policies for the MTR library.
--
-- 0028 gave `mtr_document` its own row policies and the application its
-- own upload path, and the two never met. Every policy in 0010 opens with
--
--   and storage_object_book_id(name) is not null
--
-- which reads the first path segment as a job book id. Library
-- certificates are written to `mtr-library/<sha256>` because they belong
-- to a heat rather than to any one book, so that segment is not a uuid,
-- the expression is null, and no policy matches. Postgres then does the
-- right thing and refuses the insert — "new row violates row-level
-- security policy" — which is what filing a certificate has been doing
-- since the feature shipped.
--
-- The gap survived a live check because that check inserted `mtr_document`
-- rows directly in SQL. It proved the linking triggers and never once
-- walked the path a person walks, where the file is written first and the
-- row second. A verification that skips the step the user cannot skip is
-- not a verification.
--
-- The rule these policies enforce is deliberately not a second copy of the
-- rule in 0028. `can_read_mtr` states it once and both the table policy
-- and the object policy call it, so the certificate and the file it points
-- at cannot drift into disagreeing about who may see them.
-- ---------------------------------------------------------------------

-- True for objects the library owns. Mirrors `storage_object_book_id` in
-- being the one place a path shape is interpreted, and is pinned the same
-- way 0012 pinned that one — it is reachable from a policy, so a caller
-- who could bend its search_path could bend the policy.
create or replace function storage_object_is_mtr(p_name text)
returns boolean language sql immutable set search_path = '' as $$
  select split_part(p_name, '/', 1) = 'mtr-library'
$$;

-- Who may see a certificate: Fortress staff always, because finding one
-- before knowing which job wants it is what a library is for; anyone else
-- only where a book they can already read references that heat.
create or replace function can_read_mtr(p_mtr_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_fortress_staff()
    or exists (
      select 1 from material_heat mh
      where mh.mtr_library_id = p_mtr_id
        and can_read_job_book(mh.job_book_id)
    )
$$;

-- 0028 stated this inline. Restated through the function so there is one
-- definition rather than two that agree today.
drop policy if exists mtr_document_read on mtr_document;
create policy mtr_document_read on mtr_document for select
  using (can_read_mtr(id));

-- Reading the file answers to the same question as reading the row. The
-- join is on `storage_path`, so an object nothing points at is readable by
-- nobody — including an orphan left behind by a failed insert.
drop policy if exists mtr_library_read on storage.objects;
create policy mtr_library_read on storage.objects for select
  using (
    bucket_id = 'job-book-documents'
    and storage_object_is_mtr(name)
    and exists (
      select 1 from mtr_document m
      where m.storage_path = storage.objects.name
        and m.deleted_at is null
        and can_read_mtr(m.id)
    )
  );

-- Writing is `is_fortress_writer()` and nothing more, matching
-- `mtr_document_write`. It cannot be phrased in terms of the row the way
-- reading is: the file is uploaded before the row that describes it
-- exists, so a policy that required the row would refuse every first
-- upload — the exact shape of bug this migration is fixing.
drop policy if exists mtr_library_insert on storage.objects;
create policy mtr_library_insert on storage.objects for insert
  with check (
    bucket_id = 'job-book-documents'
    and storage_object_is_mtr(name)
    and is_fortress_writer()
  );

-- The upload is content-addressed and upserts, so re-filing identical
-- bytes is an update rather than an error.
drop policy if exists mtr_library_update on storage.objects;
create policy mtr_library_update on storage.objects for update
  using (
    bucket_id = 'job-book-documents'
    and storage_object_is_mtr(name)
    and is_fortress_writer()
  );

-- Delete exists for one reason: the upload path removes the object when
-- the row insert fails, so a rejected filing does not leave a file behind.
-- Withdrawing a certificate is a soft delete on the row, which keeps both
-- the audit trail and the file.
drop policy if exists mtr_library_delete on storage.objects;
create policy mtr_library_delete on storage.objects for delete
  using (
    bucket_id = 'job-book-documents'
    and storage_object_is_mtr(name)
    and is_fortress_writer()
  );

revoke all on function storage_object_is_mtr(text) from public, anon;
revoke all on function can_read_mtr(uuid) from public, anon;
grant execute on function storage_object_is_mtr(text) to authenticated;
grant execute on function can_read_mtr(uuid) to authenticated;
