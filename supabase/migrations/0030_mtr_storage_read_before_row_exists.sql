-- ---------------------------------------------------------------------
-- The library read policy has to work before the row it describes exists.
--
-- 0029 fixed the missing insert policy and filing a certificate still
-- failed, with the same message. The insert was not the problem by then:
-- `with check` passed, and an insert ran clean as long as nothing read the
-- row back. Adding `returning` to the identical statement failed it again.
--
-- That is the whole bug. Postgres applies SELECT policies to a row
-- returned by `insert ... returning`, and the storage API reads the object
-- back after writing it. 0029's read policy required a matching
-- `mtr_document` row — and the upload path writes the file first and the
-- row second, so at the moment of the read there is nothing to match. The
-- policy denied the uploader sight of the object they had just written.
--
-- 0029 said as much in the comment above its insert policy: "the file is
-- uploaded before the row that describes it exists, so a policy that
-- required the row would refuse every first upload". That reasoning was
-- correct and was applied to one policy out of four.
--
-- Fortress staff may read anything under `mtr-library/` regardless of what
-- points at it, which is also the honest rule: they can already see the
-- whole library through `can_read_mtr`, and making that conditional on a
-- row existing only ever produced this failure. External readers stay
-- row-gated exactly as before — an operator sees a certificate only where
-- a book they can read references that heat — and nothing here widens
-- that.
-- ---------------------------------------------------------------------

drop policy if exists mtr_library_read on storage.objects;
create policy mtr_library_read on storage.objects for select
  using (
    bucket_id = 'job-book-documents'
    and storage_object_is_mtr(name)
    and (
      is_fortress_staff()
      or exists (
        select 1 from mtr_document m
        where m.storage_path = storage.objects.name
          and m.deleted_at is null
          and can_read_mtr(m.id)
      )
    )
  );
