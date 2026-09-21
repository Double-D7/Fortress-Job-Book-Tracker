-- ---------------------------------------------------------------------
-- The storage bucket that holds the actual files.
--
-- Until now a document row recorded a hash, a size and a path, and the PDF
-- itself went nowhere. This creates the bucket the upload path writes to
-- and puts the same access rules on the objects that already govern the
-- rows — because a job book's files ARE the confidential material, and a
-- bucket left readable would make every RLS policy in 0003 decorative.
--
-- The bucket is private. There is no permanent public URL for any document
-- in this system; `signDocumentUrl` in `lib/supabase/storage.ts` mints a
-- two-minute signed URL and writes an audit row before it hands it over,
-- so a file that was accessed is a file whose access was recorded.
--
-- Object paths are `<job_book_id>/<section_number>/<sha256>`. The first
-- segment is what these policies read, so the question "may this person
-- touch this object" reduces to the question already answered for the
-- book — `can_read_job_book` and `can_write_job_book`, the same two
-- functions, not a second copy of the rule that could drift from the first.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('job-book-documents', 'job-book-documents', false, 104857600)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- The leading path segment, as a uuid, or null when the path is not shaped
-- the way this application writes them.
create or replace function storage_object_book_id(p_name text)
returns uuid language sql immutable as $$
  select case
    when split_part(p_name, '/', 1) ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;

drop policy if exists job_book_documents_read on storage.objects;
create policy job_book_documents_read on storage.objects for select
  using (
    bucket_id = 'job-book-documents'
    and storage_object_book_id(name) is not null
    and can_read_job_book(storage_object_book_id(name))
  );

-- Upload and overwrite are both writes. Overwrite matters because the
-- upload path is content-addressed and re-uploading identical bytes is a
-- legitimate retry.
drop policy if exists job_book_documents_insert on storage.objects;
create policy job_book_documents_insert on storage.objects for insert
  with check (
    bucket_id = 'job-book-documents'
    and storage_object_book_id(name) is not null
    and can_write_job_book(storage_object_book_id(name))
  );

drop policy if exists job_book_documents_update on storage.objects;
create policy job_book_documents_update on storage.objects for update
  using (
    bucket_id = 'job-book-documents'
    and storage_object_book_id(name) is not null
    and can_write_job_book(storage_object_book_id(name))
  );

-- Deleting an object is how the upload path cleans up after a failed row
-- insert, so it is permitted — but a document is removed from a book by
-- soft-deleting its row, which leaves the audit trail intact. Hard-deleting
-- the object is not how you withdraw a document.
drop policy if exists job_book_documents_delete on storage.objects;
create policy job_book_documents_delete on storage.objects for delete
  using (
    bucket_id = 'job-book-documents'
    and storage_object_book_id(name) is not null
    and can_write_job_book(storage_object_book_id(name))
  );
