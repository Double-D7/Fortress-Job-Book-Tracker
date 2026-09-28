-- ---------------------------------------------------------------------
-- How long a calibration stands when the certificate does not say.
--
-- Two of the three instrument certificate styles in a pressure test
-- package print no expiry date at all. A Crystal nVision certificate
-- states a calibration date and an issue date and stops; a PSV repair
-- report states a test date. Only the gauge certificates print an
-- expiration.
--
-- The application read a blank expiry as an unbounded one, so an nVision
-- calibrated in April 2025 certified a pressure test in any later year.
-- That is backwards: an instrument drifts, and a laboratory that states
-- no due date has not certified it for ever.
--
-- Fortress recalibrates on a twelve-month cycle. Some clients require
-- six, so the interval belongs to the job book rather than to the code.
-- ---------------------------------------------------------------------

alter table job_book
  add column calibration_interval_months integer not null default 12
    check (calibration_interval_months between 1 and 60);

comment on column job_book.calibration_interval_months is
  'Months a calibration stands when the certificate prints no expiry '
  'date. Twelve by default; some clients require six. Applies only to '
  'instrument calibrations — a person''s certificate states its own '
  'validity and never has one inferred.';
