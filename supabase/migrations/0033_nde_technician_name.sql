-- ---------------------------------------------------------------------
-- The technician as printed on the report.
--
-- `technician_id` is set only when the printed name resolves exactly to a
-- managed record, because attributing a radiograph to the wrong person is
-- worse than admitting the name is unknown. That leaves the commonest
-- real case with nothing to show: a report signed by somebody this book
-- holds no credentials for, which is a section 8 finding — and a finding
-- that cannot name the person is one nobody can act on.
--
-- So the name is kept as written, whether or not it resolved.
-- ---------------------------------------------------------------------

alter table nde_report add column technician_name text;

comment on column nde_report.technician_name is
  'The technician as printed on the report, kept whether or not it '
  'resolves to an ndt_technician. A report signed by somebody with no '
  'record is a section 8 finding, and the finding needs the name to be '
  'actionable.';
