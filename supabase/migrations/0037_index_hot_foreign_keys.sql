-- ---------------------------------------------------------------------
-- Two foreign keys that nothing indexed.
--
-- Every page in a book assembles the whole book: fourteen tables filtered
-- on `job_book_id`, plus the NDE exposure rows filtered on
-- `nde_report_id`. Twelve of those tables carry an index on the column
-- they are filtered by. Two did not, so both were answered by a
-- sequential scan on every page load.
--
-- It cost nothing to date because the live database holds 77 certificates
-- and no exposure rows at all. Both are about to stop being small. A
-- facility book carries a few hundred certificates, and
-- `nde_report_line` holds one row per examined weld per report, which on
-- a real flowline book runs to thousands. A sequential scan over those,
-- on every click, on every tab, is the kind of slowness that arrives
-- gradually and gets blamed on everything except the missing index.
--
-- `nde_report_line` is the one that matters most: it is fetched with
-- `in (…)` over every report in the book, so the scan is repeated per
-- report id without an index to drive it.
--
-- CONCURRENTLY so neither takes a write lock on a table the application
-- is using. That also means these cannot run inside a transaction block.
-- ---------------------------------------------------------------------

create index concurrently if not exists certificate_job_book
  on certificate (job_book_id);

create index concurrently if not exists nde_report_line_report
  on nde_report_line (nde_report_id);
