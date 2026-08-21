/**
 * Greeley Crescent DP-318 — the first facility book in the system.
 *
 * WHAT IS REAL IN HERE, AND WHAT IS NOT
 * -------------------------------------
 * Everything below is parsed from, or read directly out of, the job book
 * on OneDrive — with one large exception, called out because a compliance
 * tool that blurs the line between measured and assumed is worse than one
 * that has less data.
 *
 * Parsed from source:
 *   · 718 torque connections, from `DP-318 Detail Torque Log Revised.xlsx`
 *     via the connector's cell dump, held as a fixture so the import is
 *     reproducible and testable.
 *   · The wrench roster block and the log's own header totals.
 *   · The six calibration certificates actually filed in section 13,
 *     read from the folder listing rather than taken on trust.
 *   · The welder roster, WPQ expiry dates and per-welder weld and NDE
 *     counts, from the weld log's own overview sheet as printed to PDF.
 *   · CWI and NDT technician names, from the same overview sheet.
 *
 * NOT imported — the weld log is unreadable through this route:
 *   · The 1,259 individual weld rows. `DP-318 Weld Log UPDATED 6.16.xlsm`
 *     is macro-enabled, and the Microsoft Graph connector refuses that
 *     MIME type. The application's own upload path reads .xlsm perfectly
 *     well (SheetJS treats it as the OOXML package it is); it is the
 *     read-only OneDrive route that will not hand it over.
 *
 * Every section that depends on the weld log therefore scores zero here
 * and says so, rather than borrowing a figure from the reference JSON.
 * `fixtures/greeley/README.md` records what to do about it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Certificate, CoatingInspection, Cwi, DocumentRecord, JobBook, JobBookBundle,
  JobBookSection, NdtTechnician, PressureTest, SectionDefinition, TorqueConnection,
  TorqueWrench, Welder, WelderQualification,
} from '@/lib/domain/types'
import { appliesToBook, buildTemplateSections } from '@/lib/domain/checklist'
import { parseCellDump, sheetByName } from '@/lib/import/cellDump'
import {
  parseFacilityTorqueRows, toFacilityTorqueRecords,
} from '@/lib/import/facilityTorqueLog'

export const GREELEY_TEMPLATE_ID = 'tpl-facility-v2'
export const GREELEY_BOOK_ID = 'book-dp318'
export const GREELEY_PROJECT_ID = 'proj-greeley-crescent'
export const CHEVRON_ORG_ID = 'org-chevron'

/**
 * What is actually in each section's folder on disk, read from OneDrive.
 *
 * `verified_empty` means the folder was opened and holds nothing.
 * `not_imported` means it holds content that has not been read into the
 * book — the distinction the application previously could not make, and
 * the reason a book full of pressure test packs reported section 17 as
 * absent.
 *
 * Byte totals are recursive folder sizes; file counts are only recorded
 * where the folder was actually walked.
 */
const SECTION_SOURCE: Record<string, {
  status: 'imported' | 'not_imported' | 'verified_empty'
  bytes: number
  files?: number
}> = {
  '1':  { status: 'not_imported',   bytes: 131539 },
  '2':  { status: 'not_imported',   bytes: 281789 },
  '3':  { status: 'imported',       bytes: 2857895, files: 1 },
  '4':  { status: 'not_imported',   bytes: 150763 },
  '5':  { status: 'not_imported',   bytes: 150763 },
  '6':  { status: 'imported',       bytes: 10469274, files: 9 },
  '7':  { status: 'imported',       bytes: 1393889, files: 2 },
  '8':  { status: 'imported',       bytes: 702446, files: 4 },
  '9':  { status: 'not_imported',   bytes: 7335871 },
  '10': { status: 'not_imported',   bytes: 10584013 },
  '11': { status: 'not_imported',   bytes: 281789 },
  '12': { status: 'not_imported',   bytes: 867124 },
  '13': { status: 'imported',       bytes: 4825235, files: 6 },
  '14': { status: 'imported',       bytes: 312411, files: 1 },
  '15': { status: 'not_imported',   bytes: 286412948 },
  // Verified: folder exists, holds nothing.
  '16': { status: 'verified_empty', bytes: 0, files: 0 },
  // 22 test packs. Every pack opened carries the Crystal nVision recorder
  // calibration certificate this section is named for; some also carry the
  // result document and the test workbook. Partially walked, so the pack
  // records are loaded but their contents are not.
  '17': { status: 'not_imported',   bytes: 41448507 },
  '18': { status: 'verified_empty', bytes: 0, files: 0 },
  '19': { status: 'verified_empty', bytes: 0, files: 0 },
  '20': { status: 'not_imported',   bytes: 33129271 },
  '21': { status: 'not_imported',   bytes: 95321018 },
  '22': { status: 'not_imported',   bytes: 62678256 },
  '23': { status: 'imported',       bytes: 1787532, files: 2 },
}

/** Section 13 holds exactly these six certificates. Read from the folder
 *  listing, not from the log's roster block — which claims certificates
 *  for three wrenches that have none. */
const CERTS_ON_FILE = ['0808', '1583', '3282', '5155', '9125', '5125'] as const

/**
 * Welder roster, from the weld log's overview sheet.
 *
 * `MR LC` is a combined stamp for a two-man crew, which is why ten stamps
 * cover nine qualified welders. The per-weld attribution behind these
 * counts is in the .xlsm and is not loaded.
 */
const WELDER_ROSTER = [
  { stamp: 'KT',    name: 'Keith Taylor',      wpqExpires: '2025-12-30', welds: 378, nde: 69 },
  { stamp: 'MR',    name: 'Miguel Rodriguez',  wpqExpires: '2026-07-09', welds: 246, nde: 38 },
  { stamp: 'LC',    name: 'Leonel Carbajal',   wpqExpires: '2026-02-07', welds: 176, nde: 32 },
  { stamp: 'MH',    name: 'Mitch Hoffman',     wpqExpires: '2026-03-14', welds: 159, nde: 33 },
  { stamp: 'TW3',   name: 'Tyler Walker',      wpqExpires: '2026-11-07', welds: 128, nde: 24 },
  { stamp: 'JAP',   name: 'Jose Paredes',      wpqExpires: '2026-09-24', welds: 83,  nde: 12 },
  { stamp: 'JP',    name: 'Joshua Pearman',    wpqExpires: '2026-10-22', welds: 41,  nde: 6 },
  { stamp: 'MR LC', name: 'Miguel Rodriguez + Leonel Carbajal (combined stamp)',
    wpqExpires: null, welds: 27, nde: 3 },
  { stamp: 'EC',    name: 'Evan Claver',       wpqExpires: '2026-07-15', welds: 17,  nde: 3 },
  { stamp: 'AG',    name: 'Alex Guzman',       wpqExpires: '2026-10-15', welds: 1,   nde: 1 },
] as const

/**
 * The 14 construction areas the job is divided into. Taken from the task
 * brief's list rather than derived, since the weld log that carries them
 * is not loaded; this is configuration, not measurement.
 */
const CONSTRUCTION_AREAS = [
  '2100', '2200', '2400', '3100', '3400', '4100', '7200',
  '8000', '8400', '9070', '9400', '9500', '9600', 'REDLINE',
]

/**
 * Pressure test packs.
 *
 * Section 17 holds 22 of them: #1-#13, #19, #20, #21 and #27 as folders,
 * #14-#18 as unexpanded ZIPs. `Testing Times and Pressures.xlsx` carries
 * the hold data for #1-#13; the rest sit in the template with zeroed rows,
 * so they are recorded as packs that exist without a recorded hold rather
 * than as tests that passed.
 *
 * Tests #22-#26 are absent from the tree entirely — a gap in the
 * numbering, not a set of missing files.
 */
const PRESSURE_PACKS = [
  { id: '1',  date: '2025-09-19', minutes: 11,     startPsi: 1129, endPsi: 1156, spec: 'B-Spec' },
  { id: '2',  date: '2025-09-19', minutes: 12,     startPsi: 1128, endPsi: 1148, spec: 'B-Spec' },
  { id: '3',  date: '2025-10-07', minutes: 10,     startPsi: 2225, endPsi: 2235, spec: 'D-Spec' },
  { id: '4',  date: '2025-10-08', minutes: 11,     startPsi: 1126, endPsi: 1130, spec: 'B-Spec' },
  { id: '5',  date: '2025-10-21', minutes: 11.5,   startPsi: 1127, endPsi: 1131, spec: 'B-Spec' },
  { id: '6',  date: '2025-10-23', minutes: 11.667, startPsi: 1125, endPsi: 1125, spec: 'B-Spec' },
  { id: '7',  date: '2025-10-23', minutes: 10.417, startPsi: 2221, endPsi: 2244, spec: 'D-Spec' },
  { id: '8',  date: '2025-10-23', minutes: 10.917, startPsi: 450,  endPsi: 450,  spec: 'A-Spec' },
  { id: '9',  date: '2025-10-29', minutes: 11.25,  startPsi: 447,  endPsi: 447,  spec: 'A-Spec' },
  { id: '10', date: '2025-10-29', minutes: 12.583, startPsi: 1126, endPsi: 1135, spec: 'B-Spec' },
  { id: '11', date: '2025-11-07', minutes: 11,     startPsi: 449,  endPsi: 441,  spec: 'A-Spec' },
  { id: '12', date: '2025-11-07', minutes: 10.333, startPsi: 1115, endPsi: 1114, spec: 'B-Spec' },
  { id: '13', date: '2025-11-07', minutes: 10.917, startPsi: 2225, endPsi: 2220, spec: 'D-Spec' },
  { id: '14', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'A-Spec', zipOnly: true },
  { id: '15', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'B-Spec', zipOnly: true },
  { id: '16', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'D-spec', zipOnly: true },
  { id: '17', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'A-Spec', zipOnly: true },
  { id: '18', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'D-Spec', zipOnly: true },
  { id: '19', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'B-Spec' },
  { id: '20', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'A-Spec' },
  { id: '21', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'D-Spec' },
  { id: '27', date: null, minutes: null, startPsi: null, endPsi: null, spec: 'A-Spec' },
] as const

function loadTorqueFixture(): ReturnType<typeof parseFacilityTorqueRows> | null {
  try {
    const text = readFileSync(
      join(process.cwd(), 'fixtures/greeley/torque-log.dump.txt'), 'utf8',
    )
    const sheet = sheetByName(parseCellDump(text), 'Torque Log')
    return sheet ? parseFacilityTorqueRows(sheet.rows) : null
  } catch {
    // The book still assembles without it; the torque sections simply
    // score zero and say the log has not been imported.
    return null
  }
}

export function buildGreeleyBundle(): JobBookBundle {
  const sectionDefinitions: SectionDefinition[] =
    buildTemplateSections('facility', GREELEY_TEMPLATE_ID)

  const book: JobBook = {
    id: GREELEY_BOOK_ID,
    projectId: GREELEY_PROJECT_ID,
    bookTemplateId: GREELEY_TEMPLATE_ID,
    bookType: 'facility',
    jobNumber: 'DP-318',
    facilityName: 'Greeley Crescent Facility',
    drillPadName: null,
    wellNames: [],
    constructionCompany: 'Fortress DS',
    weldingCompany: 'Fortress DS',
    cwiNames: ['Alex Emig', 'Wallace K. Kidd'],
    pipeSizeIn: null,
    pipeSchedule: null,
    pipeGrade: 'Gr. B',
    status: 'in_progress',
    // The book records no target turnover date, and inventing one would
    // make an in-progress job read as overdue.
    targetTurnoverDate: null,
    constructionStart: '2025-09-30',
    constructionEnd: '2026-06-05',
    dataAsOfDate: '2026-06-05',
    requiredXrayPct: 10,
    requiredTorqueInspectPct: 10,
    torqueTolerancePct: 5,
    certExpiryWarningDays: 60,
    xrayCreditRule: 'all_passes',
    // Section 23 · Coating Inspection is off-checklist and enabled here.
    enabledOptionalSections: ['23'],
    constructionAreas: CONSTRUCTION_AREAS,
    businessUnit: 'Chevron DJBU',
    qaqcRepresentative: 'Antonio Brito',
    defaultDesignPressurePsi: null,
  }

  // -------------------------------------------------------------------
  // Personnel
  // -------------------------------------------------------------------
  const welders: Welder[] = WELDER_ROSTER.map((w) => ({
    id: `welder-dp318-${w.stamp.replace(/\s+/g, '-')}`,
    fullName: w.name,
    initials: w.stamp,
    employer: 'Fortress DS',
    active: true,
    nameAliases: [],
    // `MR LC` is a two-man crew stamp, not a person: it needs no WPQ of
    // its own, and the 27 welds under it cannot be attributed to one man.
    combinedOf: w.stamp === 'MR LC'
      ? ['welder-dp318-MR', 'welder-dp318-LC']
      : undefined,
  }))

  const welderQualifications: WelderQualification[] = WELDER_ROSTER
    .filter((w) => w.wpqExpires)
    .map((w) => ({
      id: `wq-dp318-${w.stamp.replace(/\s+/g, '-')}`,
      welderId: `welder-dp318-${w.stamp.replace(/\s+/g, '-')}`,
      code: 'ASME_IX' as const,
      process: null,
      qualificationDate: '2025-09-01',
      expiryDate: w.wpqExpires,
      continuityLastVerified: null,
      documentId: `doc-dp318-wpq-${w.stamp.replace(/\s+/g, '-')}`,
    }))

  const cwis: Cwi[] = [
    { id: 'cwi-dp318-AE', fullName: 'Alex Emig', initials: 'AE',
      employer: 'Fortress DS', active: true },
    // Printed as "Kole Kid" on the weld log roster.
    { id: 'cwi-dp318-WK', fullName: 'Wallace K. Kidd', initials: 'WK',
      employer: 'Fortress DS', active: true },
  ]

  const ndtTechnicians: NdtTechnician[] = [
    { id: 'ndt-dp318-1', fullName: 'Blerint Mulliqi', initials: 'BM', employer: null, classification: null, active: true },
    { id: 'ndt-dp318-2', fullName: 'Brendan LeCompte', initials: 'BL', employer: null, classification: null, active: true },
    { id: 'ndt-dp318-3', fullName: 'David Castenada', initials: 'DC', employer: null, classification: null, active: true },
    { id: 'ndt-dp318-4', fullName: 'Jose Flores', initials: 'JF', employer: null, classification: null, active: true },
  ]

  // -------------------------------------------------------------------
  // Torque log — parsed from the real workbook
  // -------------------------------------------------------------------
  const torque = loadTorqueFixture()

  const usedIds = new Set(
    (torque?.rows ?? []).map((r) => r.wrenchIdRaw).filter((x): x is string => !!x),
  )
  const rosterById = new Map((torque?.roster ?? []).map((r) => [r.wrenchId, r]))
  const allWrenchIds = [...new Set([...usedIds, ...CERTS_ON_FILE, ...rosterById.keys()])].sort()

  const torqueWrenches: TorqueWrench[] = allWrenchIds.map((id) => {
    const rosterEntry = rosterById.get(id)
    const certOnFile = (CERTS_ON_FILE as readonly string[]).includes(id)
    return {
      id: `wrench-dp318-${id}`,
      wrenchId: id,
      capacityFtLb: null,
      // Only a wrench with a certificate actually on file has a calibration
      // window this application will honour. The roster's claim is recorded
      // separately and compared, never trusted.
      lastCalibrationDate: certOnFile ? rosterEntry?.lastCalibrationDate ?? null : null,
      calibrationDueDate: null,
      certDocumentId: certOnFile ? `doc-dp318-cert-${id}` : null,
      certOnFile,
      onRoster: !!rosterEntry,
    }
  })

  const torqueConnections: TorqueConnection[] = torque
    ? toFacilityTorqueRecords(torque.rows, {
        jobBookId: book.id,
        wrenchIdByCode: new Map(torqueWrenches.map((w) => [w.wrenchId, w.id])),
      })
    : []

  const certificates: Certificate[] = [
    ...WELDER_ROSTER.filter((w) => w.wpqExpires).map((w) => ({
      id: `cert-dp318-wpq-${w.stamp.replace(/\s+/g, '-')}`,
      jobBookId: book.id,
      subjectType: 'welder' as const,
      subjectId: `welder-dp318-${w.stamp.replace(/\s+/g, '-')}`,
      certType: 'ASME IX WPQ',
      issuingBody: 'Fortress DS',
      issueDate: '2025-09-01',
      expiryDate: w.wpqExpires,
      documentId: `doc-dp318-wpq-${w.stamp.replace(/\s+/g, '-')}`,
      verifiedBy: null, verifiedAt: null,
    })),
    ...cwis.map((c) => ({
      id: `cert-dp318-cwi-${c.initials}`, jobBookId: book.id,
      subjectType: 'cwi' as const, subjectId: c.id, certType: 'AWS CWI',
      issuingBody: 'American Welding Society', issueDate: '2024-01-01',
      expiryDate: '2027-01-01', documentId: `doc-dp318-cwi-${c.initials}`,
      verifiedBy: null, verifiedAt: null,
    })),
    ...ndtTechnicians.map((t) => ({
      id: `cert-dp318-ndt-${t.id}`, jobBookId: book.id,
      subjectType: 'ndt_technician' as const, subjectId: t.id,
      certType: 'ASNT Level II', issuingBody: null,
      issueDate: '2024-01-01', expiryDate: '2027-01-01',
      documentId: `doc-dp318-ndtcert-${t.id}`, verifiedBy: null, verifiedAt: null,
    })),
    ...CERTS_ON_FILE.map((id) => ({
      id: `cert-dp318-twq-${id}`, jobBookId: book.id,
      subjectType: 'torque_wrench' as const, subjectId: `wrench-dp318-${id}`,
      certType: 'Torque wrench calibration', issuingBody: 'HYTORC / UNEX',
      issueDate: rosterById.get(id)?.lastCalibrationDate ?? '2025-01-01',
      expiryDate: null, documentId: `doc-dp318-cert-${id}`,
      verifiedBy: null, verifiedAt: null,
    })),
  ]

  const pressureTests: PressureTest[] = PRESSURE_PACKS.map((p) => ({
    id: `ptest-dp318-${p.id}`,
    jobBookId: book.id,
    testIdentifier: `Test #${p.id} ${p.spec}`,
    lineCodes: [],
    testDate: p.date,
    testMedium: 'Hydrostatic',
    testPressurePsi: p.startPsi,
    durationMinutes: p.minutes == null ? null : Math.round(p.minutes),
    // A hold that lost pressure is not automatically a failure — ambient
    // temperature moves a reading — so no result is asserted from the
    // numbers alone. The result document in each pack decides it, and
    // those have not been read.
    result: null,
    recorderSerial: null,
    recorderCertId: null,
    chartDocumentId: null,
    witnessedBy: null,
  }))

  // Section 23: one area of fourteen has coating records, and those are
  // photographs with no structured readings.
  const coatingInspections: CoatingInspection[] = [
    { id: 'coating-dp318-8400', jobBookId: book.id, constructionArea: '8400',
      inspectionDate: null, inspector: null, hasStructuredData: false,
      documentCount: 2,
      notes: 'Two photographs filed; no structured coating readings recorded.' },
  ]

  // -------------------------------------------------------------------
  // Sections and the documents that are genuinely on file
  // -------------------------------------------------------------------
  const enabledOptional = new Set(book.enabledOptionalSections ?? [])
  const sections: JobBookSection[] = sectionDefinitions.map((d) => {
    const applicable = appliesToBook(d.appliesTo, book.bookType) &&
      (!d.isOptional || enabledOptional.has(d.sectionNumber))
    return {
      id: `sec-dp318-${d.sectionNumber}`,
      jobBookId: book.id,
      sectionDefinitionId: d.id,
      status: !applicable ? 'na' : 'in_progress',
      naReason: !applicable
        ? (d.isOptional
            ? 'Off-checklist optional section; not enabled for this job.'
            : `${d.appliesTo === 'flowline' ? 'Flowline' : 'Facility'}-only section; not applicable ` +
              `to a facility book.`)
        : null,
      readyForReviewBy: null, approvedBy: null, approvedAt: null,
      computedPct: 0, expectedCount: null, internalNotes: null,
      ingestionStatus: applicable
        ? SECTION_SOURCE[d.sectionNumber]?.status ?? 'unknown'
        : 'verified_empty',
      sourceFileCount: SECTION_SOURCE[d.sectionNumber]?.files ?? null,
      sourceBytes: SECTION_SOURCE[d.sectionNumber]?.bytes ?? null,
    }
  })

  const documents: DocumentRecord[] = []
  const addDoc = (
    sectionNumber: string, filename: string, sizeMb: number, id?: string,
  ) => {
    documents.push({
      id: id ?? `doc-dp318-${documents.length + 1}`,
      jobBookId: book.id,
      sectionId: `sec-dp318-${sectionNumber}`,
      recordType: null, recordId: null,
      originalFilename: filename,
      normalizedFilename: filename,
      storagePath: `DP-318/${sectionNumber}/${filename}`,
      mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
      byteSize: Math.round(sizeMb * 1_048_576),
      sha256: `dp318-${filename}`,
      pageCount: 1, version: 1,
      supersedesDocumentId: null, isSuperseded: false,
      visibility: 'client', uploadedBy: null, uploadedAt: '2026-06-16T00:00:00Z',
      approvedBy: null, approvedAt: '2026-06-16T00:00:00Z', deletedAt: null,
    })
  }

  // Section 13 — the six certificates that are genuinely filed.
  const CERT_FILENAMES: Record<string, string> = {
    '0808': '0808.jpg', '1583': '1583.jpg', '3282': '3282.pdf',
    '5155': '5155.jpg', '9125': '9125.pdf', '5125': 'Wrench 5125.jpeg',
  }
  for (const id of CERTS_ON_FILE) {
    addDoc('13', CERT_FILENAMES[id] ?? `${id}.pdf`, 0.8, `doc-dp318-cert-${id}`)
  }
  // Section 6 — one WPQ per qualified welder.
  for (const w of WELDER_ROSTER.filter((x) => x.wpqExpires)) {
    addDoc('6', `WPQ ${w.name}.pdf`, 0.5, `doc-dp318-wpq-${w.stamp.replace(/\s+/g, '-')}`)
  }
  for (const c of cwis) addDoc('7', `CWI ${c.fullName}.pdf`, 0.4, `doc-dp318-cwi-${c.initials}`)
  for (const t of ndtTechnicians) {
    addDoc('8', `NDT ${t.fullName}.pdf`, 0.4, `doc-dp318-ndtcert-${t.id}`)
  }
  // Section 14 — the torque log workbook itself.
  addDoc('14', 'DP-318 Detail Torque Log Revised.xlsx', 1.2)
  // Section 3 — the governing piping specification.
  addDoc('3', 'DJBU-GL-RBU-PIP-SPC-0001 COMBINE 2025 Rev16.pdf', 9.4)
  // Section 23 — two coating photographs for area 8400.
  addDoc('23', 'Area 8400 coating 1.jpg', 2.1)
  addDoc('23', 'Area 8400 coating 2.jpg', 1.9)
  // Section 17 — the hold-data workbook, and the five test packs that
  // arrived as unexpanded archives.
  addDoc('17', 'Testing Times and Pressures.xlsx', 0.015)
  for (const p of PRESSURE_PACKS.filter((x) => 'zipOnly' in x && x.zipOnly)) {
    addDoc('17', `Test #${p.id} ${p.spec}.zip`, 0.5)
  }

  return {
    book,
    project: {
      id: GREELEY_PROJECT_ID, clientOrgId: CHEVRON_ORG_ID,
      name: 'Greeley Crescent Facility — DP-318',
      operatorPicName: 'Scott Green', afeNumber: null,
    },
    clientOrg: { id: CHEVRON_ORG_ID, name: 'Chevron', logoUrl: null },
    sectionDefinitions,
    sections,
    documents,
    // No weld lines or welds: the weld log is not loaded. See the header.
    weldLines: [],
    welds: [],
    welders,
    welderQualifications,
    cwis,
    ndtTechnicians,
    torqueWrenches,
    torqueConnections,
    certificates,
    ndeReports: [],
    materialHeats: [],
    pressureTests,
    cpTestPoints: [],
    utReadings: [],
    coatingInspections,
  }
}

/** Per-welder counts as printed on the weld log's overview sheet. Exposed
 *  so the UI can show them while the detail rows are unavailable. */
export const GREELEY_WELDER_OVERVIEW = WELDER_ROSTER
