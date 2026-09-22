-- ---------------------------------------------------------------------
-- Section ingestion status — "we looked and it is not there" versus
-- "nobody has looked yet".
--
-- This closes a gap that has been open since the scoring engine was
-- written. `JobBookSection.ingestionStatus` exists in the domain model,
-- is read in five places by the scoring engine, and drives three numbers
-- on the completeness report. It has never existed as a column. So on
-- every book that lives in this database the field arrives `undefined`,
-- the engine falls back to `unknown`, and the three numbers it feeds are
-- silently wrong in the same direction every time:
--
--   evidenceCoveragePct   always 100%, because no section can be
--                         not_imported, because no section can be
--                         anything but unknown
--   isLowerBound          always false, so a partial read of a book
--                         presents as a complete verdict on it
--   missingSections       includes every zero-scoring section, whether
--                         anyone has read its contents or not
--
-- The domain comment on the field says why this matters, and it is worth
-- repeating here because the schema is where the mistake was made:
--
--   "DP-318's section 17 holds 41 MB of pressure test packs, every one
--    carrying the recorder calibration certificate the section is named
--    for, and the book reported it as 'section absent' because nothing
--    had walked the folder. A turnover report saying a section is missing
--    when it is merely unread is worse than no report: it sends a crew to
--    re-do work that was already done, and it destroys trust in every
--    other number on the page."
--
-- WHY THE DEFAULT IS `unknown` AND NOT `imported`. Defaulting to
-- `imported` would make every existing row claim its contents have been
-- read, which is the precise false statement this column exists to
-- prevent, and it would make the claim silently, for rows nobody
-- inspected. `unknown` is the honest value for a row whose history we do
-- not have, and it scores exactly as today, so applying this migration
-- changes no percentage on any existing book. The value only becomes
-- load-bearing once something asserts it.
--
-- WHAT ASSERTS IT. A book scaffolded in this application has no external
-- source folder — evidence arrives by upload, and what the application
-- holds is all there is — so the create path writes `imported` at
-- scaffold time. An upload into a section flips it to `imported` for the
-- same reason. An importer that walks a delivered folder tree writes
-- `not_imported` with the file count and byte size it found, and
-- `verified_empty` where the folder exists and holds nothing. Any insert
-- path that asserts nothing lands on `unknown` and scores as it does
-- today, which is the safe direction to fail in.
-- ---------------------------------------------------------------------

create type ingestion_status as enum (
  -- Contents loaded. The score is a real verdict on the section.
  'imported',
  -- Contents exist but have not been read into the book. The score is a
  -- floor, not a verdict, and the report must say so rather than
  -- presenting the floor as a finding.
  'not_imported',
  -- Somebody looked and there is genuinely nothing there. Scores zero,
  -- same as `imported` with no evidence, but the report can distinguish
  -- a checked-and-empty section from an unchecked one.
  'verified_empty',
  -- Nobody has established which of the above holds. Scores as today.
  'unknown'
);

alter table job_book_section
  add column ingestion_status ingestion_status not null default 'unknown',
  -- Evidence from the source folder, where a tree listing has been read.
  -- Null means no listing was taken, which is not the same as a listing
  -- that came back empty — that is `verified_empty` with a count of zero.
  add column source_file_count integer,
  add column source_bytes bigint;

alter table job_book_section
  add constraint source_counts_are_not_negative check (
    (source_file_count is null or source_file_count >= 0)
    and (source_bytes is null or source_bytes >= 0)
  ),
  -- A section cannot have been looked at and found empty while also
  -- holding files. One of the two statements is false, and the database
  -- should not be the place that decides which.
  add constraint verified_empty_holds_nothing check (
    ingestion_status <> 'verified_empty'
    or source_file_count is null
    or source_file_count = 0
  );

comment on column job_book_section.ingestion_status is
  'Whether this section''s contents have been loaded into the application '
  'at all, which is a different question from whether they exist. Read by '
  'the scoring engine to distinguish a missing section from an unread one.';

comment on column job_book_section.source_file_count is
  'Files seen in the source folder when a tree listing was taken. Null '
  'means no listing was taken; zero means the listing came back empty.';

-- The column is part of the section payload the client view already
-- serves, so the view has to be rebuilt to carry it. Without this the
-- operator reads a section as absent while staff read it as unread, off
-- one dataset, which is the two-books problem the cache was built to
-- avoid.
-- Same columns as 0008, plus the three new ones. Nothing else widens:
-- internal notes and the reviewer identities stay absent by construction.
--
-- The file count and byte size go to the client deliberately. An operator
-- told a section is "not yet imported" will ask how much is sitting
-- there, and answering that question is the whole point of drawing the
-- distinction in the first place.
drop view if exists client_section_v;
create view client_section_v with (security_invoker = true) as
  select id, job_book_id, section_definition_id, status, na_reason,
         approved_at, computed_pct, collected_pct, computed_at,
         ingestion_status, source_file_count, source_bytes
    from job_book_section;

comment on view client_section_v is
  'Client/inspector projection of job_book_section: internal notes and the
   reviewer identities are absent by construction. computed_pct is a cache
   and ships with computed_at so its age is visible. ingestion_status says
   whether the percentage is a verdict or a floor.';

grant select on client_section_v to authenticated;
