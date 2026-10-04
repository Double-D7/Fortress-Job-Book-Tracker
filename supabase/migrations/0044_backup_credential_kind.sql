-- ---------------------------------------------------------------------
-- The backup learns a third kind of file.
--
-- `backup_object.kind` records what each copied file is, so the run
-- bookkeeping can tell a document from a library certificate. The
-- personnel credential library (0042) is the third, and without this
-- the backup refuses every card with an enum violation.
--
-- Separate from 0042 because `alter type ... add value` has its own
-- transaction rules and does not belong in the middle of a table
-- definition. Idempotent, so re-running costs nothing.
-- ---------------------------------------------------------------------

alter type backup_object_kind add value if not exists 'credential';
