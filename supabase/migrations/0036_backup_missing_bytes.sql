-- ---------------------------------------------------------------------
-- Telling "could not copy it" apart from "there was nothing to copy".
--
-- The first real run found all 128 document rows unbackupable, every one
-- of them reporting "Not in storage: Object not found". The documents are
-- catalogued — filename, section, sha256, byte size — and the bytes they
-- describe are not in the bucket.
--
-- Counting those as failures is wrong in a way that matters. They are two
-- different alarms with two different responses:
--
--   files_failed   SharePoint, the network or a path refused the write.
--                  The backup is broken. Fix it and the files go next run.
--
--   files_missing  The application has no bytes for a document it lists.
--                  The backup is working perfectly; the catalogue is
--                  lying. Nothing about the backup will fix it, and
--                  retrying nightly forever will not either.
--
-- Rolled together, a hundred missing files make every run read 'partial'
-- and bury the one genuine upload failure in a detail array of a hundred
-- identical entries — which is how a broken backup hides inside a noisy
-- one. The run status now ignores missing files: a run that wrote
-- everything it had bytes for is 'ok', and says separately how many
-- documents it could not find bytes for.
--
-- That count is worth surfacing on its own account. A job book whose
-- documents are listed but absent looks complete on screen and is not,
-- and §15 retention is a promise about the file rather than the row.
--
-- WHY `backup_health` IS LEFT ALONE. Reporting this in the one-row health
-- answer means adding a column to its return type, which Postgres will
-- not do without dropping the function first. Nothing reads
-- `backup_health` yet — no screen, no digest, only the commentary in 0031
-- and DEPLOY.md — so dropping and recreating a function in production to
-- change an interface with no callers is risk spent for nothing. It goes
-- in the migration that gives it its first caller, where the new column
-- can be verified against something that actually displays it.
-- ---------------------------------------------------------------------

alter table backup_run
  add column if not exists files_missing integer not null default 0;

comment on column backup_run.files_missing is
  'Documents the application lists but has no stored bytes for. Not a '
  'backup failure — a gap in the catalogue the backup can only report.';
