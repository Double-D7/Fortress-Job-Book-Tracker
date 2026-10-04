-- ---------------------------------------------------------------------
-- Which methods an NDT technician's card actually certifies.
--
-- ASNT SNT-TC-1A certifies per method, not per person. A technician
-- holds PT Level II and RT Level II as two separate qualifications, and
-- plenty hold one without the other. `cert_type` records the level as
-- the card prints it ("ASNT Level II") and cannot answer "which
-- method", so until now the application checked only that *a*
-- certification covered the report date. A technician certified for PT
-- alone passed an RT report. That is the kind of gap a client auditor
-- finds, and it should have been ours to find.
--
-- WHY A COLUMN AND NOT PARSING `cert_type`. The text is whatever the
-- card printed and whoever typed it: "ASNT Level II", "Level 2 UT",
-- "SNT-TC-1A II". Pattern matching that would fail quietly and in the
-- unsafe direction, which is the direction that passes a report nobody
-- was qualified to sign.
--
-- WHY NULL IS NOT "ALL METHODS". Null means nobody has recorded what the
-- card covers, which is not the same as covering none and not the same
-- as covering every one. The application treats an unrecorded list as
-- certifying no method-specific work and raises a *warning* finding
-- asking somebody to read the card, which is distinct from the
-- *critical* finding raised when a card is read and genuinely does not
-- cover the method. One is a gap in our records; the other is a finding
-- against the technician, and conflating them would accuse people on
-- the strength of a blank field.
--
-- Existing rows keep null, so nothing is silently certified by this
-- migration. On a book with NDE reports that raises findings asking for
-- the cards to be read, which is the correct state: we genuinely do not
-- know, and we should say so rather than assume.
-- ---------------------------------------------------------------------

alter table certificate
  add column if not exists ndt_methods text[];

-- The four methods the domain models (`NdtMethod` in types.ts). A
-- constraint rather than an enum so adding VT later is one line here
-- and not a type rewrite, and checked per element so a typo cannot
-- enter a method the application will never match against.
alter table certificate
  drop constraint if exists certificate_ndt_methods_known;

alter table certificate
  add constraint certificate_ndt_methods_known check (
    ndt_methods is null
    or ndt_methods <@ array['RT','PT','MT','UT']::text[]
  );

-- Methods belong to a person's NDT card. A torque wrench calibration or
-- a CWI card carrying one would mean somebody filed against the wrong
-- subject, and a silently ignored value is how that survives review.
alter table certificate
  drop constraint if exists certificate_ndt_methods_only_for_technicians;

alter table certificate
  add constraint certificate_ndt_methods_only_for_technicians check (
    ndt_methods is null or subject_type = 'ndt_technician'
  );

comment on column certificate.ndt_methods is
  'Methods this NDT card certifies (ASNT SNT-TC-1A is per method). Null '
  'means not yet recorded, which certifies nothing - it is not "all".';
