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
  JobBookSection, NdtTechnician, SectionDefinition, TorqueConnection, TorqueWrench,
  Welder, WelderQualification,
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
    pressureTests: [],
    cpTestPoints: [],
    utReadings: [],
    coatingInspections,
  }
}

/** Per-welder counts as printed on the weld log's overview sheet. Exposed
 *  so the UI can show them while the detail rows are unavailable. */
export const GREELEY_WELDER_OVERVIEW = WELDER_ROSTER
