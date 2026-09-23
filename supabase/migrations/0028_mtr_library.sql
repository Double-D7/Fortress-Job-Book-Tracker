-- ---------------------------------------------------------------------
-- The MTR library.
--
-- Mill certificates are the one register with no ingestion path. Every
-- other one reads its real document; §15 has always meant typing a heat
-- number and hoping the certificate is in a folder somewhere. And the
-- certificate for heat D07821 is the same certificate on every job that
-- used that steel, so filing it per-book means filing it repeatedly and
-- losing it individually.
--
-- So: one library, keyed by heat number, shared across every book. Upload
-- a certificate once; every book that references that heat resolves to
-- it, including books created afterwards and books that referenced the
-- heat before the certificate arrived.
--
-- WHY THE HEAT NUMBER IS TYPED RATHER THAN EXTRACTED. Four of the five
-- real mill certificates this was built against have no text layer at
-- all — they are scans, image data only. OCR would be the wrong answer
-- rather than the hard one: a misread heat number does not fail loudly,
-- it files the wrong certificate against a weld and then §15 reports the
-- material as traceable. The application suggests a heat number from the
-- filename, which follows a convention that held on all five samples,
-- and a person confirms it.
-- ---------------------------------------------------------------------

create table mtr_document (
  id                uuid primary key default gen_random_uuid(),

  -- As the mill wrote it, uppercased. `heat_key` is what lookups use.
  heat_number       text not null,
  -- Letters and digits only, so D-07821 and D07821 are one heat. A
  -- generated column rather than application-side normalisation: the
  -- uniqueness below has to hold for any writer, and a key computed by
  -- the caller is a key the next caller computes differently.
  heat_key          text generated always as (
                      upper(regexp_replace(heat_number, '[^A-Za-z0-9]', '', 'g'))
                    ) stored,

  -- What the certificate covers. Free text: mills are not consistent and
  -- a dropdown would lose more than it tidied.
  material_description text,
  nominal_size      text,
  schedule_or_class text,
  grade             text,
  component_type    text,
  heat_treatment    text,
  -- Who made it and who supplied it. §15 asks for traceability to the
  -- mill, not to the distributor, and the two are usually different.
  mill_name         text,
  supplier_name     text,
  certificate_number text,
  certificate_date  date,

  -- The file itself, in the same private bucket as job book documents.
  storage_path      text not null,
  original_filename text not null,
  normalized_filename text not null,
  sha256            text not null,
  byte_size         bigint,
  page_count        integer,
  mime_type         text,

  notes             text,
  uploaded_by       uuid references app_user(id),
  uploaded_at       timestamptz not null default now(),
  deleted_at        timestamptz,

  constraint heat_number_not_blank check (btrim(heat_number) <> '')
);

-- One live certificate per heat. A superseded one is soft-deleted, so a
-- re-issued certificate replaces rather than duplicates — and the old
-- one stays readable, because §15 retention outlives the correction.
create unique index mtr_document_live_heat
  on mtr_document (heat_key) where deleted_at is null;

create index mtr_document_heat on mtr_document (heat_key);
create index mtr_document_sha on mtr_document (sha256) where deleted_at is null;

comment on table mtr_document is
  'The MTR library: one mill certificate per heat number, shared across '
  'every job book. Not scoped to a book — the certificate for a heat is '
  'the same certificate wherever that steel was used.';

-- ---------------------------------------------------------------------
-- The link from a book's heat to the library.
--
-- `material_heat.mtr_document_id` already existed and points at a
-- per-book `document` row — a certificate someone attached to this book
-- specifically. That stays: it is how a book records its own paperwork.
-- This is the second, shared route.
-- ---------------------------------------------------------------------
alter table material_heat
  add column mtr_library_id uuid references mtr_document(id);

comment on column material_heat.mtr_library_id is
  'The library certificate matching this heat, resolved automatically by '
  'heat number. Distinct from mtr_document_id, which is a document '
  'attached to this book specifically.';

create index material_heat_library on material_heat (mtr_library_id);

-- ---------------------------------------------------------------------
-- Resolution, in both directions.
--
-- A heat entered before its certificate arrives must resolve when the
-- certificate is uploaded; a certificate uploaded before the heat is
-- entered must be found when it is. Either one alone leaves somebody
-- re-checking by hand, which is the work this is meant to remove.
--
-- WHAT THIS DELIBERATELY WILL NOT DO: overwrite a human's judgement.
-- `mtr_status` moves from 'missing' to 'on_file' when a certificate
-- resolves, and from nothing else. A tech who marked a heat 'illegible'
-- or 'unidentified' looked at something and decided; a lookup finding a
-- file does not overrule that.
-- ---------------------------------------------------------------------
create or replace function link_heat_to_library() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_mtr mtr_document;
begin
  select * into v_mtr from mtr_document
   where heat_key = upper(regexp_replace(new.heat_number, '[^A-Za-z0-9]', '', 'g'))
     and deleted_at is null
   limit 1;

  new.mtr_library_id := v_mtr.id;

  if v_mtr.id is not null and new.mtr_status = 'missing' then
    new.mtr_status := 'on_file';
  end if;

  return new;
end $$;

create trigger material_heat_finds_its_mtr
  before insert or update of heat_number on material_heat
  for each row execute function link_heat_to_library();

revoke execute on function link_heat_to_library() from public, anon, authenticated;

create or replace function backfill_heats_for_mtr() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  -- A certificate arriving for a heat somebody typed last month.
  update material_heat
     set mtr_library_id = new.id,
         mtr_status = case when mtr_status = 'missing' then 'on_file' else mtr_status end
   where deleted_at is null
     and upper(regexp_replace(heat_number, '[^A-Za-z0-9]', '', 'g')) = new.heat_key;
  return null;
end $$;

create trigger mtr_backfills_matching_heats
  after insert on mtr_document
  for each row execute function backfill_heats_for_mtr();

revoke execute on function backfill_heats_for_mtr() from public, anon, authenticated;

-- A certificate withdrawn must not leave books claiming it is on file.
create or replace function unlink_heats_for_withdrawn_mtr() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update material_heat
       set mtr_library_id = null,
           mtr_status = case when mtr_status = 'on_file' then 'missing' else mtr_status end
     where mtr_library_id = new.id;
  end if;
  return null;
end $$;

create trigger mtr_withdrawal_unlinks_heats
  after update of deleted_at on mtr_document
  for each row execute function unlink_heats_for_withdrawn_mtr();

revoke execute on function unlink_heats_for_withdrawn_mtr()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Who may see a certificate.
--
-- Fortress staff: the whole library, because it is a Fortress asset and
-- the point of it is to find a certificate before knowing which job
-- wants it.
--
-- An operator or an inspector: only a certificate referenced by a heat
-- on a book they can already read. The library is cross-client — heat
-- D07821 may have gone into three operators' facilities — and the list
-- of every heat Fortress has ever bought is not something one client is
-- entitled to browse.
-- ---------------------------------------------------------------------
alter table mtr_document enable row level security;
alter table mtr_document force row level security;

create policy mtr_document_read on mtr_document for select using (
  is_fortress_staff()
  or exists (
    select 1 from material_heat mh
     where mh.mtr_library_id = mtr_document.id
       and mh.deleted_at is null
       and can_read_job_book(mh.job_book_id)
  )
);

create policy mtr_document_write on mtr_document for all
  using (is_fortress_writer()) with check (is_fortress_writer());

-- The audit trigger, on the same terms as every other compliance table.
do $$
begin
  execute 'create trigger audit_mtr_document after insert or update or delete '
       || 'on mtr_document for each row execute function audit_trigger()';
exception when duplicate_object then null;
end $$;
