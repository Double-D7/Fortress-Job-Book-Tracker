-- ---------------------------------------------------------------------
-- What an NDE report's file did not give up.
--
-- A job book with missing data is incomplete, so a page nobody could read
-- has to become something a person is made to clear rather than a silence
-- in the record. Flags in this system are derived from data by rules, not
-- inserted by hand — which means a gap must be stored before it can be
-- flagged, and this is where it goes.
--
-- Carried on the report rather than in a table of its own because a gap
-- has no life apart from the report it was found in: withdraw the report
-- and the gap goes with it, which is the right behaviour and comes free.
--
-- The shape is the parser's own: kind, severity, detail and, where it
-- applies, the page. Stored as written rather than normalised into
-- columns, because the set of things a file can fail to yield will grow
-- and a migration per new kind would be a tax on noticing new ones.
-- ---------------------------------------------------------------------

alter table nde_report
  add column import_gaps jsonb;

comment on column nde_report.import_gaps is
  'Gaps found while reading the source PDF: pages that yielded nothing, '
  'rows naming no weld, fields that could not be read. Critical entries '
  'become findings against section 10.';

-- The report's own source, so a person clearing a gap can open the file
-- that produced it rather than hunting for it.
alter table nde_report
  add column source_filename text;

comment on column nde_report.source_filename is
  'The uploaded file this report was read from. One file often holds '
  'several reports.';
