-- ---------------------------------------------------------------------
-- The certificate is the calibration record.
--
-- This application previously reported a torque wrench as having no
-- calibration on record whenever nobody had typed a date into the torque
-- log's roster block — while the wrench's calibration certificate sat in
-- section 13 of the same book. On the Greeley Crescent DP-318 book that
-- produced eighteen findings against connections torqued with a wrench
-- calibrated four months before the work.
--
-- A filed certificate this application has not managed to read is an
-- ingestion gap on our side. It is not a deficiency in the book, and the
-- schema now says so in three places:
--
--   · `cert_read` separates "we have not read it" from "it is not there".
--   · `roster_claimed_calibration_date` keeps the log's typed summary
--     beside the certificate instead of in place of it, so the two can
--     disagree in public.
--   · `certificate.issue_date` becomes nullable, because a certificate on
--     file whose dates have not been read has no known issue date, and
--     inventing one makes an unread page look verified.
-- ---------------------------------------------------------------------

alter table torque_wrench
  add column cert_read boolean not null default false,
  add column roster_claimed_calibration_date date,
  -- The full serial as printed; the log names wrenches by its last four.
  add column serial_number text,
  add column manufacturer text,
  add column model text,
  add column certificate_number text,
  add column calibration_range_min_ft_lb numeric(10,2),
  add column calibration_range_max_ft_lb numeric(10,2),
  add column calibration_frequency text,
  add column calibration_status text
    check (calibration_status is null or calibration_status in ('pass','fail'));

comment on column torque_wrench.cert_read is
  'Whether the certificate on file has actually been read into this book. '
  'False with cert_on_file true means unread, which is an ingestion gap, '
  'not a missing calibration.';

comment on column torque_wrench.roster_claimed_calibration_date is
  'What the torque log roster block claims. Compared against the '
  'certificate, never substituted for it: on DP-318 one roster line '
  'transcribes the handwritten date the wrench went into service.';

-- A wrench cannot be recorded as read without a certificate to read.
alter table torque_wrench
  add constraint cert_read_requires_cert
  check (not cert_read or cert_on_file);

-- Calibration dates come off the certificate, so they are only meaningful
-- once it has been read.
alter table torque_wrench
  add constraint calibration_dates_require_read_cert
  check (cert_read or (last_calibration_date is null and calibration_due_date is null));

-- A window that closes before it opens is a transcription error.
alter table torque_wrench
  add constraint calibration_window_ordered
  check (
    last_calibration_date is null or calibration_due_date is null
    or calibration_due_date >= last_calibration_date
  );

alter table certificate
  alter column issue_date drop not null;

comment on column certificate.issue_date is
  'Null where the certificate is on file but has not been read. Validity '
  'checks refuse to certify work against an unknown issue date, so an '
  'unread page never passes as a valid one.';

-- An expiry with no issue date is half a window, and half a window reads
-- as an unbounded one to anything comparing dates.
alter table certificate
  add constraint expiry_requires_issue_date
  check (expiry_date is null or issue_date is not null);

alter table certificate
  add constraint certificate_window_ordered
  check (issue_date is null or expiry_date is null or expiry_date >= issue_date);
