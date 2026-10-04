-- ---------------------------------------------------------------------
-- The personnel credential library.
--
-- Section 7 and section 8 ask whether the people who inspected this pipe
-- were qualified to. Until 0041 there was no way to get a card in at
-- all; 0041 gave one, but filed each card against one book. That is the
-- same mistake the mill certificates had before 0028: an ASNT card is
-- the same card on every job the technician works, so filing it per
-- book means filing it repeatedly and losing it individually.
--
-- So: one library, keyed by person, shared across every book. Upload a
-- card once; every book that person works resolves to it, including
-- books created afterwards and books where they were already working
-- before the card arrived.
--
-- WHY THE BOOK STILL KEEPS ITS OWN ROW. A turnover package has to stand
-- on its own. An auditor reading book DP-452 expects its section 8 to
-- list the technicians who worked DP-452, with their cards, and not a
-- directory of everybody Fortress has ever employed. So the library
-- holds the card and `certificate` stays the book's register; this
-- migration is the machinery that keeps the second in step with the
-- first without anybody retyping.
--
-- WHY A PERSON IS "ON" A BOOK BY SIGNING SOMETHING. There is no roster
-- per book and there should not be one: a roster is a list somebody
-- maintains, and the lists nobody maintains are the ones that go stale.
-- A CWI is on this book when they signed a weld on it. An NDT
-- technician is on it when they signed a report on it. Those are facts
-- the book already records.
--
-- WHY THE CARD IS TYPED IN RATHER THAN READ. Same reason as 0028. These
-- are usually a photograph of a wallet card, at an angle, dates printed
-- small. A misread certification date does not fail loudly: it files a
-- card that certifies the wrong window and section 8 then reports a
-- technician as covered.
-- ---------------------------------------------------------------------

create table if not exists personnel_credential (
  id uuid primary key default gen_random_uuid(),

  -- Who it belongs to. Polymorphic across the two personnel rosters,
  -- both of which are already global tables, so no foreign key can
  -- name both. Constrained to the two that have no register of their
  -- own: a welder's qualification lives in `welder_qualification`, and
  -- an instrument's calibration is not a person's credential.
  subject_type cert_subject_type not null,
  subject_id uuid not null,

  -- As the card prints it: "AWS CWI", "ASNT Level II". Free text,
  -- because the wording varies by issuer and a dropdown would lose more
  -- than it tidied.
  cert_type text not null,
  issuing_body text,

  -- Required, unlike the book-scoped register, which tolerates an unread
  -- certificate so a page can be filed before anybody reads it. Nothing
  -- should enter the library unread: the whole purpose is to answer
  -- "was this person covered on that date" without opening the file.
  issue_date date not null,
  expiry_date date,

  -- Which methods an NDT card certifies. Null is "not recorded", which
  -- certifies nothing; see 0041.
  ndt_methods text[],

  -- The file itself, in the same private bucket as job book documents.
  storage_path text not null,
  original_filename text not null,
  normalized_filename text not null,
  sha256 text not null,
  byte_size bigint,
  page_count integer,
  mime_type text,

  notes text,
  uploaded_by uuid references app_user(id),
  uploaded_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint personnel_credential_subject_is_a_person
    check (subject_type in ('cwi', 'ndt_technician')),
  constraint personnel_credential_methods_known
    check (ndt_methods is null or ndt_methods <@ array['RT','PT','MT','UT']::text[]),
  constraint personnel_credential_methods_only_for_technicians
    check (ndt_methods is null or subject_type = 'ndt_technician'),
  constraint personnel_credential_expiry_after_issue
    check (expiry_date is null or expiry_date >= issue_date)
);

-- One live card per person, type and issue date. A renewal is a
-- different issue date and files alongside; re-uploading the same card
-- replaces rather than duplicates. The history stays readable because
-- withdrawal is a soft delete.
create unique index if not exists personnel_credential_live
  on personnel_credential (subject_id, cert_type, issue_date)
  where deleted_at is null;

create index if not exists personnel_credential_subject
  on personnel_credential (subject_type, subject_id) where deleted_at is null;

-- ---------------------------------------------------------------------
-- The link from a book's register to the library.
--
-- `certificate.document_id` already existed and points at a per-book
-- `document` row, a card somebody filed against this book specifically.
-- That stays. This is the second, shared route, exactly as
-- `material_heat` carries both `mtr_document_id` and `mtr_library_id`.
-- ---------------------------------------------------------------------
alter table certificate
  add column if not exists credential_library_id uuid references personnel_credential(id);

comment on column certificate.credential_library_id is
  'The library card this register entry was pulled from, resolved '
  'automatically when the person signs something on this book. Null for '
  'a certificate filed against this book by hand.';

-- One pulled entry per book per card, so a technician signing forty
-- welds pulls their card once.
create unique index if not exists certificate_pulled_once
  on certificate (job_book_id, credential_library_id)
  where credential_library_id is not null and deleted_at is null;
