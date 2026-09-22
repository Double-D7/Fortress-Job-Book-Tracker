-- ---------------------------------------------------------------------
-- A qualification whose expiry is known and whose start is not.
--
-- The Weld Log Overview Sheet (Appendix A §11) carries, for every welder
-- on the job, the one date an operator checks first: "Date WPQ Expires".
-- It does not carry the date the qualification was granted. So importing
-- that sheet — which is the fastest route from a real book to a populated
-- welder register — has to record an expiry with no start.
--
-- Until now `qualification_date` was NOT NULL, which left two options,
-- both bad: invent a start date, or throw the expiry away. Inventing one
-- is worse than it sounds, because `qualifiedOn` reads the pair as a
-- window: a fabricated start silently certifies every weld after it.
--
-- This is the same decision 0007 took for `certificate.issue_date`, and
-- for the same reason, stated there as: "a certificate on file whose dates
-- have not been read has no known issue date, and inventing one makes an
-- unread page look verified."
--
-- The safety comes from the domain refusing to certify against an open
-- start rather than from the column. `qualifiedOn` now returns false where
-- the qualification date is unknown — an unbounded window would make a
-- half-read record qualify every weld in the book, which is exactly
-- backwards, and is the failure mode 0007 was written to close.
-- ---------------------------------------------------------------------

alter table welder_qualification
  alter column qualification_date drop not null;

comment on column welder_qualification.qualification_date is
  'When the WPQ was granted. Null where the source recorded only an expiry —
   the overview sheet does exactly this. A null start is NOT an open window:
   `qualifiedOn` refuses to certify any weld against a qualification whose
   start is unknown, so a partially-read record can never qualify work.';

-- Where a qualification came from, so a register entry built from a
-- summary sheet is distinguishable from one read off the WPQ itself.
alter table welder_qualification
  add column source text
    check (source is null or source in ('wpq_document','overview_sheet','manual')),
  add column entered_at timestamptz,
  add column entry_source entry_source;

comment on column welder_qualification.source is
  'Where this record was read from. An entry built from the overview sheet
   carries an expiry the operator can check and no qualification date; one
   read from the WPQ itself carries both. §10 verification treats them
   differently, so they are not conflated.';

-- Same for the people registers: a name read off a summary sheet is a
-- roster entry, not a verified credential.
alter table welder
  add column entered_at timestamptz,
  add column entry_source entry_source;
alter table cwi
  add column entered_at timestamptz,
  add column entry_source entry_source;
alter table ndt_technician
  add column entered_at timestamptz,
  add column entry_source entry_source;
