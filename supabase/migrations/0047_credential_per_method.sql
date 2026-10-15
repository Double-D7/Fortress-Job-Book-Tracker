-- ---------------------------------------------------------------------
-- 0047 — one credential per method, and a card that prints no issue date
--
-- Both changes come from reading real certificates rather than from
-- reasoning about them. Ten NDT certifications and four CWI cards were
-- uploaded on 2026-10-15; between them they broke two assumptions this
-- table was built on.
--
-- ## Each method certifies on its own dates
--
-- Every ASNT-derived certification examined states its methods in a
-- table, one row per method, each with its own certification date and
-- its own expiry. They are rarely the same:
--
--   Castaneda-Quezadas  MT 2/7/2028   PT 2/7/2028   RT 2/8/2028
--   LeCompte            RT 5/2/2028   MT 5/4/2028   PT 5/10/2028
--   Mercado             PT 2028-10-08 UTT 2028-10-08 MT/RT 2028-10-09
--   Flores              RT 3/25/2028  RT-CR 3/31/2028  UTT 4/23/2028
--
-- The columns already allow this — one row per method, each with its
-- own `issue_date` and `expiry_date`. What did not allow it was
-- `personnel_credential_live`, unique on (subject_id, cert_type,
-- issue_date). Filing Mercado's four methods would have been four
-- upserts onto ONE row: PT, then UTT over it, then MT, then RT. Three
-- methods silently discarded and a register claiming the technician was
-- certified for one.
--
-- The method set joins the key. A renewal is still a different issue
-- date and still files alongside; re-uploading the same method line
-- still replaces rather than duplicates.
--
-- ## A card can print an expiry and no issue date
--
-- All four AWS CWI certificates read — Emig, Kidd, Cole, Hayman — carry
-- a certificate number and an expiration date and no issue date at all.
-- It is not an omission by whoever scanned them; AWS does not print one.
-- `issue_date not null` meant none of the four could be filed, which is
-- the same trap section 6 had: a register that refuses what the paper
-- actually says.
--
-- So the column becomes nullable, with a guard that a credential must
-- carry at least one date. A card with neither is not evidence of
-- anything.
--
-- A null issue date is NOT "valid from the beginning of time".
-- `coversDate` in the domain already refuses to certify any work date
-- against an unknown start, and that behaviour is deliberately
-- unchanged here: an undated card is on file and visible, and it
-- certifies nothing until somebody records when the term began.
-- ---------------------------------------------------------------------

-- The method set is part of a card's identity.
--
-- `nulls not distinct` rather than `coalesce(ndt_methods, '{}')`: both
-- make a null method set equal to itself, but an expression index
-- cannot be named in PostgREST's `on_conflict`, which takes column
-- names. Writing it over the plain columns keeps the upsert working.
-- It matters for both nullable members of the key — two undated CWI
-- cards for the same person and type are the same card re-uploaded, and
-- must replace rather than stack.
drop index if exists personnel_credential_live;

create unique index if not exists personnel_credential_live
  on personnel_credential (subject_id, cert_type, ndt_methods, issue_date)
  nulls not distinct
  where deleted_at is null;

comment on index personnel_credential_live is
  'One live card per person, certificate type, method set and issue '
  'date. The method set is in the key because an ASNT card certifies '
  'each method on its own dates: without it, filing a four-method '
  'certification overwrites itself three times. NULLS NOT DISTINCT so '
  'that a card with no methods recorded, or no issue date printed, '
  'still collides with itself on re-upload.';

-- A nullable issue date, for a card that prints an expiry and no start.
alter table personnel_credential
  alter column issue_date drop not null;

comment on column personnel_credential.issue_date is
  'The date the term began, where the certificate prints one. Null for '
  'a card that does not — an AWS CWI certificate carries a certificate '
  'number and an expiry and nothing else. Null certifies no work date: '
  'the domain refuses to evaluate an unknown start rather than treating '
  'it as unbounded.';

-- The expiry check has to tolerate the null it can now see; without
-- this, `expiry_date >= issue_date` evaluates to null and the row is
-- accepted, which is the right outcome but by accident. State it.
alter table personnel_credential
  drop constraint if exists personnel_credential_expiry_after_issue;

alter table personnel_credential
  add constraint personnel_credential_expiry_after_issue
    check (expiry_date is null or issue_date is null or expiry_date >= issue_date);

-- A credential with no date at all cannot answer the question the
-- library exists to answer.
alter table personnel_credential
  drop constraint if exists personnel_credential_has_a_date;

alter table personnel_credential
  add constraint personnel_credential_has_a_date
    check (issue_date is not null or expiry_date is not null);
