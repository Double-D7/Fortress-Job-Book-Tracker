-- ---------------------------------------------------------------------
-- A welder's qualification gets its certificate.
--
-- Sections 7 and 8 got a filing path in 0041 and a library in 0042.
-- Section 6 did not, and it is the one that needed it most: the Weld Log
-- Overview Sheet records "Date WPQ Expires" and nothing else, so a
-- qualification imported from it has no start date, and
-- `qualificationOn` reports `unverifiable` rather than `qualified`.
-- Nothing on file establishes that the welder was covered on the day
-- they welded.
--
-- The certificate carries the date the sheet omits. Filing it is what
-- turns "we cannot show this" into "qualified", which is the whole job
-- of section 6.
--
-- WHY THE PAGE HANGS OFF THE QUALIFICATION, NOT OFF A SECOND LIBRARY.
-- `personnel_credential` holds CWI and NDT cards because those people
-- have no register of their own. A welder has one, and it is this
-- table. Filing the WPQ as a `personnel_credential` row would give two
-- answers to "was this welder qualified on that date" — the certificate
-- and the register — and this project has shipped four production bugs
-- from exactly that shape. One row, carrying both the facts and the
-- page it came from.
--
-- WHY NULLABLE. A qualification read off the overview sheet has no page
-- and never will until somebody files one. The columns being empty is
-- the honest record of that, and the `unverifiable` verdict is what
-- says so out loud.
--
-- VISIBILITY. The same as the CWI and NDT cards: readable by anybody who
-- can read a book that welder worked on. Decided deliberately rather
-- than by default — a WPQ routinely carries a partial SSN, which the
-- other two do not — so that an inspector auditing section 6 can open
-- the evidence rather than asking for it.
-- ---------------------------------------------------------------------

alter table welder_qualification
  add column if not exists storage_path text,
  add column if not exists original_filename text,
  add column if not exists normalized_filename text,
  add column if not exists sha256 text,
  add column if not exists byte_size bigint,
  add column if not exists page_count integer,
  add column if not exists mime_type text,
  add column if not exists uploaded_by uuid references app_user(id),
  add column if not exists uploaded_at timestamptz;

-- A half-filed page is worse than none: a row claiming a certificate
-- that cannot be fetched is a download that fails in front of an
-- auditor. Either the page is there with what is needed to serve it, or
-- it is not there at all.
alter table welder_qualification
  drop constraint if exists welder_qualification_page_is_complete;

alter table welder_qualification
  add constraint welder_qualification_page_is_complete check (
    storage_path is null
    or (sha256 is not null
        and original_filename is not null
        and normalized_filename is not null)
  );

create index if not exists welder_qualification_filed
  on welder_qualification (welder_id) where storage_path is not null;

comment on column welder_qualification.storage_path is
  'The filed WPQ certificate, in the shared bucket. Null for a '
  'qualification read off the overview sheet, which carries an expiry '
  'and no page - and therefore no provable start date.';
