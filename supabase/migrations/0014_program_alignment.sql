-- ---------------------------------------------------------------------
-- Alignment with FDS-JBMP-001, first pass.
--
-- Three defects against Fortress's own program, found by reading the app
-- against it section by section.
--
-- 1. GOVERNING DOCUMENTS WERE A SECTION TITLE, NOT A FIELD.
--
--    Four section titles carried "Noble Energy" and "(Noble Template)"
--    while the specification actually on file had moved to Chevron at a
--    later revision. §3 of the program names that exact condition "a
--    finding waiting to happen", and Appendix A gives the titles
--    operator-neutral.
--
--    Retitling alone would lose information, because the Noble document IS
--    the one in force until the client says otherwise. So which document
--    governs becomes a recorded field, confirmed with the client at Gate 0
--    and re-confirmed on any revision — which is what §3 asks for and what
--    form F01 section 2 collects.
--
-- 2. A PRESSURE TEST CARRIED ONE CERTIFICATE WHERE THE PROGRAM REQUIRES
--    THREE.
--
--    §11.1 makes it a Critical finding to accept a test "without gauge,
--    recorder and pressure safety valve certificates valid on the test
--    date", and Appendix A §17 says the same. The table held only
--    `recorder_cert_id`, so two thirds of that check could not be made —
--    and the baseline review found 13 of 21 facility test packages holding
--    certificates but no result document, which is the neighbouring
--    failure.
-- ---------------------------------------------------------------------

alter table job_book
  -- The client checklist and piping specification actually in force, by
  -- name and revision. Free text because they are the client's documents,
  -- named as the client names them.
  add column client_checklist_reference   text,
  add column client_checklist_revision    text,
  add column piping_spec_reference        text,
  add column piping_spec_revision         text,
  -- Gate 0 requires these confirmed CURRENT with the client, not merely
  -- recorded. A date nobody set means nobody asked.
  add column governing_docs_confirmed_at  date,
  add column governing_docs_confirmed_by  uuid references app_user(id);

comment on column job_book.piping_spec_reference is
  'The piping specification in force for this job, as the client names it '
  '(e.g. "Noble Energy Piping Specification" or '
  '"DJBU-GL-RBU-PIP-SPC-0001"). Recorded here rather than in a section '
  'title so it can be changed when the client changes it.';

comment on column job_book.governing_docs_confirmed_at is
  'When the checklist and specification revisions were last confirmed '
  'current with the client. FDS-JBMP-001 §3 and Gate 0.';

-- ---------------------------------------------------------------------
-- A pressure test needs three instruments certified on the test date.
-- ---------------------------------------------------------------------
alter table pressure_test
  add column gauge_serial     text,
  add column gauge_cert_id    uuid references certificate(id),
  add column psv_serial       text,
  add column psv_cert_id      uuid references certificate(id),
  -- §17 acceptance criteria: hold data, not just a pass/fail.
  add column start_pressure_psi  numeric(10,2),
  add column end_pressure_psi    numeric(10,2),
  add column ambient_temp_f      numeric(6,2),
  -- "No test present as certificates only" — Appendix A §17. A package
  -- holding instrument certificates and no result document is the single
  -- most common defect the baseline review found in section 17.
  add column result_document_id uuid references document(id);

comment on column pressure_test.gauge_cert_id is
  'Gauge calibration. FDS-JBMP-001 §11.1 makes a test accepted without '
  'gauge, recorder AND PSV certificates valid on the test date a Critical '
  'finding; the table previously held only the recorder.';

comment on column pressure_test.result_document_id is
  'The result document. Appendix A §17: "No test present as certificates '
  'only." The baseline review found 13 of 21 facility packages in exactly '
  'that state.';

-- 'pressure_recorder' already exists in cert_subject_type and covers all
-- three instruments; the subject_id points at the test and the cert_type
-- names which instrument it certifies.
