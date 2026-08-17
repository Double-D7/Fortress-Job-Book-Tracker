/**
 * The DP452 reference book, as delivered.
 *
 * This is the seed dataset, the demo dataset, and the acceptance fixture.
 * It reproduces the real numbers from the turnover package Fortress
 * delivered to Chevron for the DP452 flowline — including its defects,
 * which are the point: every misfile, gap and impossible date below is a
 * thing the application must surface without a human opening a folder.
 *
 * Deliberately reproduced defects
 * -------------------------------
 *   · sections 16, 17 and 18 entirely absent (caps the score at 86%)
 *   · a PT report for job DP425 filed inside the DP452 book
 *   · torque wrench 1304 calibrated 2025-07-10 against December 2024 work
 *   · 278 torque connections dated after the book's as-of date
 *   · two wrench IDs on connections that appear on no roster (one a typo)
 *   · certificates for two wrenches that never touched this job
 *   · every one of 616 connections recording actual torque exactly equal
 *     to required
 *   · heat numbers referenced by welds with no MTR on file, and MTRs on
 *     file referenced by no weld
 *   · duplicate files by content hash, and three unexpanded ZIP bundles
 *   · four spellings of one welder's name, resolved to one managed welder
 *
 * Reconciling the stated totals
 * -----------------------------
 * The source brief states a welder-credit total of 2,476, a per-welder
 * breakdown, 955 joint rows in the Flow Lines workbook, and a credit
 * overstatement of ~5.7%. Those hold together only if the two workbooks
 * carry 2,342 joints between them, so the Gas Lift workbook is modelled at
 * 1,387 joints. If the real Gas Lift workbook turns out to be smaller, the
 * credit total and the 5.7% figure in the brief do not reconcile and the
 * joint split here should be revisited — the per-welder table, which is
 * the audited number, is unaffected either way.
 */
import type {
  Certificate, Cwi, CpTestPoint, DocumentRecord, JobBook, JobBookBundle,
  JobBookSection, MaterialHeat, NdeReport, NdeReportLine, NdtTechnician,
  SectionDefinition, TorqueConnection, TorqueWrench, Weld, WeldLine, Welder,
  WelderQualification,
} from '@/lib/domain/types'
import { buildTemplateSections, appliesToBook } from '@/lib/domain/checklist'
import { makeRng, intBetween, pick } from './rng'
import { allocateCredits, assignPasses, groupSizes, type CreditTarget } from './allocate'

export const DP452_TEMPLATE_ID = 'tpl-flowline-v1'
export const DP452_BOOK_ID = 'book-dp452'
export const DP452_PROJECT_ID = 'proj-chevron-dp'
export const CHEVRON_ORG_ID = 'org-chevron'

/**
 * The audited per-welder rollup. These are welder-credit counts from the
 * Noble template's own per-welder columns, and the acceptance tests assert
 * the engine reproduces them exactly.
 *
 * Names for KR, VL, GQ, JM and SV are placeholders: the source brief gives
 * only their initials. Replace them from the WPQ records before this book
 * is used for anything but demonstration.
 */
export const WELDER_TARGETS = [
  { initials: 'HS2', fullName: 'Henry Smith',    welds: 417, xrays: 126,
    aliases: ['Henery Smith'] },
  { initials: 'KR',  fullName: 'Kyle Ramirez',   welds: 460, xrays: 118, aliases: [] },
  { initials: 'CT',  fullName: 'Conor Tracy',    welds: 423, xrays: 120,
    aliases: ['Cannon Tracey', 'Canor Tracy', 'Coner Tracy'] },
  { initials: 'JD',  fullName: 'Jaime Dinkins',  welds: 707, xrays: 138,
    aliases: ['Jaimie Dinkins', 'Jamie Dinkins'] },
  { initials: 'VL',  fullName: 'Victor Lozano',  welds: 333, xrays: 75,  aliases: [] },
  { initials: 'GQ',  fullName: 'Gabriel Quinn',  welds: 92,  xrays: 30,  aliases: [] },
  { initials: 'JM',  fullName: 'Jesse Moreno',   welds: 42,  xrays: 22,  aliases: [] },
  { initials: 'SV',  fullName: 'Samuel Vega',    welds: 2,   xrays: 2,   aliases: [] },
] as const

/** Joint counts. See the reconciliation note above. */
const FLOW_LINE_JOINTS = 955
const GAS_LIFT_JOINTS = 1387
const FLOW_LINE_XRAY_JOINTS = 260
const TOTAL_JOINTS = FLOW_LINE_JOINTS + GAS_LIFT_JOINTS       // 2,342
const TOTAL_XRAY_JOINTS = 597
/** Sequence gaps: `NOT USED` weld numbers, excluded from every denominator. */
const NOT_USED_ROWS = 31

const FLOW_LINE_CODES = [
  ...Array.from({ length: 25 }, (_, i) => `FL${i + 1}`),
  'FWT', 'FWB', 'MMB', 'MMT', 'EMB', 'EMT',
  'A-1', 'B-1', 'C-1', 'D-1', 'E-1', 'F-1', 'G-1',
]                                                              // 38 line sheets
const GAS_LIFT_CODES = Array.from({ length: 30 }, (_, i) => `GL${i + 1}`)

/** Component vocabulary observed in the source MTR set, used as the
 *  controlled list rather than free text. */
export const COMPONENT_TYPES = [
  'PIPE', 'FLANGE (WN)', 'FLANGE (RF)', 'FLANGE (RTJ)', 'FLANGE (SWIVEL)',
  'FLANGE (BLIND)', 'ELBOW (90° LR)', 'ELBOW (45°)', 'ELBOW (3R)',
  'TEE (STD)', 'TEE (REDUCING)', 'TEE (CUSHION)', 'REDUCER (CONCENTRIC)',
  'SWAGE', 'SOCKOLET', 'FLEXOLET', 'NIPPLE', 'ADAPTER', 'ANODE',
] as const
export const PIPE_GRADES = ['X42', 'X52', 'A106 Gr.B'] as const
export const SCHEDULES = ['STD', 'XH', 'XS', 'XXH', '40', '80', '160'] as const
export const PRESSURE_CLASSES = ['300', '600', '1500'] as const

const COMPONENT_DESCRIPTIONS = [
  '3" 1500 RTJ FLANGE', '3" S80 PIPE', '3" SWEEP', '4" S80 PIPE',
  '4" 600 RF FLANGE', '2" S160 PIPE', '6" STD PIPE', '3" 90 LR ELL',
  '3" TEE', '2" SOCKOLET', '4" CONC REDUCER', '3" SWAGE', '2" NIPPLE',
]

/** Torque wrench roster as printed in the log's header block (9 IDs). */
const WRENCH_ROSTER = ['0215', '0245', '0289', '0543', '1108', '1304', '1700', '6697', '6704']
/** IDs appearing on connection rows but not on the roster. */
const WRENCH_OFF_ROSTER = ['0534', '0284']
/** Certificates on file for equipment that never touched this job. */
const WRENCH_CERT_ONLY = ['0934', '4206']

// ---------------------------------------------------------------------

function iso(d: Date): string { return d.toISOString().slice(0, 10) }
function dateBetween(rng: () => number, start: string, end: string): string {
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  return iso(new Date(a + Math.floor(rng() * (b - a))))
}

/**
 * Filenames are normalized on upload to one convention, with the original
 * preserved. This is what kills the `TQW-`/`TWQ-` and `MTR's`/`MTRs`/
 * `MTRS`/`HEAT ` inconsistency at the source rather than downstream.
 */
export function normalizeFilename(original: string, section: string, jobNumber: string): string {
  const ext = (original.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '').toLowerCase()
  const stem = original.slice(0, original.length - ext.length)
  const cleaned = stem
    .replace(/[’']/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
  return `${jobNumber}-S${section}-${cleaned}${ext}`
}

/** Stand-in content hash. Real uploads hash their bytes; the seed needs
 *  stable, collidable values so duplicate detection is demonstrable. */
function fakeSha(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 + input.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4)
}

// ---------------------------------------------------------------------

export function buildDp452Bundle(): JobBookBundle {
  const rng = makeRng(0x44503435)  // "DP45"

  const sectionDefinitions: SectionDefinition[] = buildTemplateSections('flowline', DP452_TEMPLATE_ID)
  const defByNumber = new Map(sectionDefinitions.map((d) => [d.sectionNumber, d]))

  const book: JobBook = {
    id: DP452_BOOK_ID,
    projectId: DP452_PROJECT_ID,
    bookTemplateId: DP452_TEMPLATE_ID,
    bookType: 'flowline',
    jobNumber: 'DP452',
    facilityName: 'DP452 Flowline',
    drillPadName: 'CC19-03',
    wellNames: ['CC19-03', 'CC16-24', 'CC20-18'],
    constructionCompany: 'Flowline Construction Services',
    weldingCompany: 'Flowline Construction Services',
    cwiNames: ['R. Alvarez', 'D. Whitfield'],
    pipeSizeIn: '3',
    pipeSchedule: '80',
    pipeGrade: 'X42',
    status: 'ready_for_review',
    targetTurnoverDate: '2025-03-31',
    constructionStart: '2024-05-01',
    constructionEnd: '2025-02-28',
    // The field logs were closed against this date. Records dated after it
    // are future-dated relative to the log that reports them.
    dataAsOfDate: '2025-02-28',
    requiredXrayPct: 10,
    requiredTorqueInspectPct: 10,
    torqueTolerancePct: 5,
    certExpiryWarningDays: 60,
    xrayCreditRule: 'all_passes',
  }

  // -------------------------------------------------------------------
  // Personnel
  // -------------------------------------------------------------------
  const welders: Welder[] = WELDER_TARGETS.map((t) => ({
    id: `welder-${t.initials}`,
    fullName: t.fullName,
    initials: t.initials,
    employer: 'Flowline Construction Services',
    active: true,
    nameAliases: [...t.aliases],
  }))

  // Ten qualification records across eight welders: two men hold an
  // original plus a requalification, which is why cert history is modelled
  // rather than a single current card.
  const welderQualifications: WelderQualification[] = [
    ...welders.map((w, i) => ({
      id: `wq-${w.initials}`,
      welderId: w.id,
      code: 'ASME_IX' as const,
      process: 'GTAW/SMAW',
      // Samuel Vega's qualification postdates his two welds. This is a
      // deliberately seeded example of the highest-severity finding the
      // application exists to catch.
      qualificationDate: w.initials === 'SV' ? '2025-01-15' : `2024-0${(i % 4) + 1}-05`,
      expiryDate: null,
      continuityLastVerified: '2025-02-01',
      documentId: `doc-wpq-${w.initials}`,
    })),
    { id: 'wq-HS2-requal', welderId: 'welder-HS2', code: 'ASME_IX', process: 'GTAW/SMAW',
      qualificationDate: '2024-11-01', expiryDate: null, continuityLastVerified: '2025-02-01',
      documentId: 'doc-wpq-HS2-requal' },
    { id: 'wq-JD-requal', welderId: 'welder-JD', code: 'ASME_IX', process: 'GTAW/SMAW',
      qualificationDate: '2024-10-12', expiryDate: null, continuityLastVerified: '2025-02-01',
      documentId: 'doc-wpq-JD-requal' },
  ]

  const cwis: Cwi[] = [
    { id: 'cwi-RA', fullName: 'Ruben Alvarez', initials: 'RA', employer: 'Fortress Data Solutions', active: true },
    { id: 'cwi-DW', fullName: 'Dean Whitfield', initials: 'DW', employer: 'Fortress Data Solutions', active: true },
  ]

  const ndtTechnicians: NdtTechnician[] = [
    { id: 'ndt-1', fullName: 'Marcus Bell',   initials: 'MB', employer: 'TEAM',   classification: 'Formal', active: true },
    { id: 'ndt-2', fullName: 'Elena Ortiz',   initials: 'EO', employer: 'TEAM',   classification: 'PQC',    active: true },
    { id: 'ndt-3', fullName: 'Travis Nguyen', initials: 'TN', employer: 'Desert', classification: 'VAR',    active: true },
    // Certification lapsed mid-job; reports written after it are findings.
    { id: 'ndt-4', fullName: 'Owen Castillo', initials: 'OC', employer: 'Desert', classification: 'Formal', active: true },
  ]

  // -------------------------------------------------------------------
  // Weld lines and welds
  // -------------------------------------------------------------------
  const weldLines: WeldLine[] = []
  let lineOrder = 0
  for (const code of FLOW_LINE_CODES) {
    weldLines.push({
      id: `line-${code}`, jobBookId: book.id, lineCode: code,
      lineDescription: `${code} production flow line`, workbook: 'Flow Lines',
      wellName: pick(rng, book.wellNames), drillPadName: pick(rng, book.wellNames),
      facilityName: book.facilityName, operatorPic: 'B. Hargrove',
      weldingCompany: book.weldingCompany, pipeSize: '3', pipeSchedule: '80',
      pipeGrade: 'X42', serviceType: 'Production', sortOrder: lineOrder++,
    })
  }
  for (const code of GAS_LIFT_CODES) {
    weldLines.push({
      id: `line-${code}`, jobBookId: book.id, lineCode: code,
      lineDescription: `${code} gas lift line`, workbook: 'Gas Lift',
      wellName: pick(rng, book.wellNames), drillPadName: pick(rng, book.wellNames),
      facilityName: book.facilityName, operatorPic: 'B. Hargrove',
      weldingCompany: book.weldingCompany, pipeSize: '2', pipeSchedule: '160',
      pipeGrade: 'X52', serviceType: 'Gas Lift', sortOrder: lineOrder++,
    })
  }

  // Allocate welder credits so the per-welder columns sum to the audited
  // totals by construction. X-rayed joints are allocated first from the
  // X-ray credit pool; the rest draw on what remains.
  const xrayTargets: CreditTarget[] = WELDER_TARGETS.map((t) => ({ key: t.initials, credits: t.xrays }))
  const restTargets: CreditTarget[] = WELDER_TARGETS.map((t) => ({ key: t.initials, credits: t.welds - t.xrays }))

  const xrayCredits = xrayTargets.reduce((s, t) => s + t.credits, 0)      // 631
  const restCredits = restTargets.reduce((s, t) => s + t.credits, 0)      // 1,845
  const restJoints = TOTAL_JOINTS - TOTAL_XRAY_JOINTS                     // 1,745

  const xrayGroups = allocateCredits(xrayTargets, groupSizes(xrayCredits, TOTAL_XRAY_JOINTS))
  const restGroups = allocateCredits(restTargets, groupSizes(restCredits, restJoints))

  // Deal joints to the two workbooks, keeping the Flow Lines workbook's
  // 260 X-ray rows.
  const flowXray = xrayGroups.slice(0, FLOW_LINE_XRAY_JOINTS)
  const gasXray = xrayGroups.slice(FLOW_LINE_XRAY_JOINTS)
  const flowRestCount = FLOW_LINE_JOINTS - FLOW_LINE_XRAY_JOINTS
  const flowRest = restGroups.slice(0, flowRestCount)
  const gasRest = restGroups.slice(flowRestCount)

  interface PlannedJoint { welders: string[]; xrayed: boolean }
  const interleave = (xr: string[][], rest: string[][]): PlannedJoint[] => {
    const out: PlannedJoint[] = []
    const total = xr.length + rest.length
    let xi = 0
    let ri = 0
    for (let i = 0; i < total; i++) {
      // Spread X-rays evenly through the sequence rather than clustering
      // them, so per-line percentages look like real inspection coverage.
      const wantXray = xi < xr.length && (ri >= rest.length || (i * xr.length) / total >= xi)
      if (wantXray) out.push({ welders: xr[xi++]!, xrayed: true })
      else out.push({ welders: rest[ri++]!, xrayed: false })
    }
    return out
  }

  const flowJoints = interleave(flowXray, flowRest)
  const gasJoints = interleave(gasXray, gasRest)

  const heatPool = Array.from({ length: 198 }, (_, i) => heatNumberFor(i))
  const welds: Weld[] = []
  const ndeAssignments: { weldId: string; weldNumber: string; date: string }[] = []

  // Welds missing a CWI signature — the largest single completeness gap in
  // the delivered book.
  const MISSING_CWI_TARGET = 152
  let missingCwiUsed = 0
  // Examined welds whose report never made it into the book.
  const NDE_UNLINKED_TARGET = 37
  let ndeUnlinkedUsed = 0

  const buildWorkbookWelds = (
    codes: string[], joints: PlannedJoint[], notUsedRows: number,
  ) => {
    // Spread joints evenly and exactly across the line sheets. Filling
    // greedily to a ceiling leaves the last sheet empty, which no real
    // workbook does.
    const base = Math.floor(joints.length / codes.length)
    const extra = joints.length - base * codes.length
    let ji = 0
    let notUsedRemaining = notUsedRows
    codes.forEach((code, ci) => {
      const perLine = base + (ci < extra ? 1 : 0)
      const line = weldLines.find((l) => l.lineCode === code)!
      let weldNo = 1
      for (let k = 0; k < perLine && ji < joints.length; k++, ji++) {
        const joint = joints[ji]!
        const [root, hot, fill, cap] = assignPasses(joint.welders)
        const weldDate = dateBetween(rng, '2024-05-06', '2025-02-20')

        // Sequence gaps, scattered rather than clumped at the end.
        if (notUsedRemaining > 0 && rng() < 0.013) {
          welds.push(blankWeld(book.id, line.id, String(weldNo++), welds.length, 'not_used'))
          notUsedRemaining--
        }
        // A nipple repair welded out of sequence, exactly as the source log
        // records it.
        const weldNumber = joint.xrayed && rng() < 0.004 ? `NP-${weldNo}` : String(weldNo++)

        const withholdCwi = missingCwiUsed < MISSING_CWI_TARGET && rng() < 0.068
        if (withholdCwi) missingCwiUsed++
        const cwi = pick(rng, cwis)
        const heats = rng() < 0.72
          ? [pick(rng, heatPool), pick(rng, heatPool)]
          : [pick(rng, heatPool)]

        const id = `weld-${line.lineCode}-${weldNumber}`
        const linkReport = joint.xrayed && !(ndeUnlinkedUsed < NDE_UNLINKED_TARGET && rng() < 0.07)
        if (joint.xrayed && !linkReport) ndeUnlinkedUsed++

        welds.push({
          id,
          weldLineId: line.id,
          jobBookId: book.id,
          weldNumber,
          sortOrder: welds.length,
          weldDate,
          welderPassAssignment: `${root}/${hot}/${fill}/${cap}`,
          rootWelderId: `welder-${root}`,
          hotWelderId: `welder-${hot}`,
          fillWelderId: `welder-${fill}`,
          capWelderId: `welder-${cap}`,
          jointType: rng() < 0.86 ? 'Butt' : 'O-let',
          componentDescription: pick(rng, COMPONENT_DESCRIPTIONS),
          partLength: `${intBetween(rng, 8, 40)}'`,
          heatNumbers: [...new Set(heats)],
          cwiInitials: withholdCwi ? null : cwi.initials,
          cwiId: withholdCwi ? null : cwi.id,
          cwiVisualResult: withholdCwi ? null : (rng() < 0.995 ? 'Pass' : 'Fail'),
          visualInspectionDate: withholdCwi ? null : weldDate,
          ndtCompany: joint.xrayed ? (rng() < 0.7 ? 'TEAM' : 'Desert') : null,
          xrayNumber: joint.xrayed ? `X-${String(1000 + welds.length).slice(-4)}` : null,
          ndtTicketNumber: joint.xrayed ? `T-${intBetween(rng, 10000, 99999)}` : null,
          ndtMethod: joint.xrayed ? 'RT' : null,
          ndtResult: joint.xrayed ? (rng() < 0.982 ? 'Pass' : 'Fail') : null,
          ndtReportId: null,   // linked below, once reports exist
          status: joint.xrayed ? 'ndt_complete' : withholdCwi ? 'welded' : 'visual_complete',
          comments: null,
        })
        if (joint.xrayed && linkReport) ndeAssignments.push({ weldId: id, weldNumber, date: weldDate })
      }
    })
  }

  buildWorkbookWelds(FLOW_LINE_CODES, flowJoints, NOT_USED_ROWS)
  buildWorkbookWelds(GAS_LIFT_CODES, gasJoints, 0)

  // -------------------------------------------------------------------
  // NDE reports — 40 files, 39 PDF plus one XLSX job log.
  // -------------------------------------------------------------------
  const ndeReports: NdeReport[] = []
  const reportDates = [
    '2024-06-14', '2024-07-02', '2024-07-19', '2024-08-08', '2024-08-27',
    '2024-09-05', '2024-09-23', '2024-10-04', '2024-10-11',
    // Three files share 10.17.24 and three more share 10-23-24, with
    // nothing marking which of each set governs.
    '2024-10-17', '2024-10-17', '2024-10-17',
    '2024-10-23', '2024-10-23', '2024-10-23',
    '2024-11-01', '2024-11-12', '2024-11-20', '2024-12-03', '2024-12-11',
    '2024-12-18', '2025-01-08', '2025-01-15', '2025-01-22', '2025-01-29',
    // Two files share 2.1.2025.
    '2025-02-01', '2025-02-01',
    '2025-02-07', '2025-02-14', '2025-02-19', '2025-02-24',
    '2024-06-28', '2024-07-30', '2024-09-13', '2024-11-26', '2025-01-03',
    '2024-08-15',
  ]
  reportDates.forEach((date, i) => {
    // Owen Castillo's certification lapses 2024-12-31; reports he signs in
    // 2025 are findings.
    const technician = i % 7 === 3 ? 'ndt-4' : ndtTechnicians[i % 3]!.id
    ndeReports.push({
      id: `nde-${i + 1}`,
      jobBookId: book.id,
      reportNumber: `RT-${String(i + 1).padStart(3, '0')}`,
      reportDate: date,
      ndtCompany: i % 3 === 2 ? 'Desert' : 'TEAM',
      method: 'RT',
      procedureReference: 'FDS-RT-001',
      revision: '3',
      acceptanceCriteria: 'API 1104, 21st Edition',
      technicianId: technician,
      workOrderNumber: `WO-${45200 + i}`,
      clientPoAfe: 'AFE 24-DP452',
      equipmentModel: 'SPEC 150',
      equipmentSerial: `SN-${3300 + i}`,
      equipmentCalDueDate: '2025-06-30',
      referencedFacility: 'DP452',
      referencedPad: 'CC19-03',
      documentId: `doc-nde-${i + 1}`,
      supersedesReportId: null,
      isSuperseded: false,
      lines: [],
    })
  })

  // A PT report for job DP425, filed inside the DP452 book. Its date also
  // sits over a year before this job's construction began.
  ndeReports.push({
    id: 'nde-dp425',
    jobBookId: book.id,
    reportNumber: 'PT-DP425-01',
    reportDate: '2023-02-28',
    ndtCompany: 'TEAM',
    method: 'PT',
    procedureReference: 'FDS-PT-001',
    revision: '2',
    acceptanceCriteria: 'API 1104, 21st Edition',
    technicianId: 'ndt-1',
    workOrderNumber: 'WO-41102',
    clientPoAfe: 'AFE 23-DP425',
    equipmentModel: 'N/A',
    equipmentSerial: 'N/A',
    equipmentCalDueDate: '2023-06-30',
    referencedFacility: 'DP425',
    referencedPad: 'CC11-07',
    documentId: 'doc-nde-dp425',
    supersedesReportId: null,
    isSuperseded: false,
    lines: [],
  })

  // A report dated 10.8.2025, filed among 2024 work.
  ndeReports.push({
    id: 'nde-2025-10-08',
    jobBookId: book.id,
    reportNumber: 'RT-040',
    reportDate: '2025-10-08',
    ndtCompany: 'TEAM',
    method: 'RT',
    procedureReference: 'FDS-RT-001',
    revision: '3',
    acceptanceCriteria: 'API 1104, 21st Edition',
    technicianId: 'ndt-2',
    workOrderNumber: 'WO-45240',
    clientPoAfe: 'AFE 24-DP452',
    equipmentModel: 'SPEC 150',
    equipmentSerial: 'SN-3340',
    equipmentCalDueDate: '2025-06-30',
    referencedFacility: 'DP452',
    referencedPad: 'CC19-03',
    documentId: 'doc-nde-40',
    supersedesReportId: null,
    isSuperseded: false,
    lines: [],
  })

  // Link examined welds to reports, nearest report date first, and give
  // each report the line items that name its welds.
  const linkableReports = ndeReports.filter((r) => r.method === 'RT' && r.reportDate <= '2025-03-01')
  const weldById = new Map(welds.map((w) => [w.id, w]))
  ndeAssignments.forEach((a, i) => {
    const report = linkableReports[i % linkableReports.length]!
    const weld = weldById.get(a.weldId)
    if (!weld) return
    weld.ndtReportId = report.id
    const line: NdeReportLine = {
      id: `ndl-${report.id}-${i}`,
      ndeReportId: report.id,
      weldId: weld.id,
      partNumber: weld.componentDescription,
      weldNumber: weld.weldNumber,
      result: weld.ndtResult ?? 'Pass',
      location: weldLines.find((l) => l.id === weld.weldLineId)?.lineCode ?? null,
      welderCode: weld.welderPassAssignment?.split('/')[0] ?? null,
      weldJoint: weld.jointType,
      weldSize: '3"',
      weldSchedule: '80',
      indications: weld.ndtResult === 'Fail' ? 'Linear indication, repaired and re-shot' : 'None',
    }
    report.lines.push(line)
  })

  // -------------------------------------------------------------------
  // Torque log — 616 connections, 118 inspected (19.16%).
  // -------------------------------------------------------------------
  const torqueWrenches: TorqueWrench[] = [
    ...WRENCH_ROSTER.map((id) => ({
      id: `wrench-${id}`, wrenchId: id,
      capacityFtLb: id.startsWith('6') ? 600 : 250,
      // Wrench 1304's certificate is dated seven months after the December
      // 2024 work it is supposed to cover.
      lastCalibrationDate: id === '1304' ? '2025-07-10' : '2024-04-18',
      calibrationDueDate: id === '1304' ? '2026-07-10' : '2025-04-18',
      certDocumentId: `doc-twq-${id}`, certOnFile: true, onRoster: true,
    })),
    // Used on connections, certified, but absent from the roster header.
    { id: 'wrench-0534', wrenchId: '0534', capacityFtLb: 250,
      lastCalibrationDate: '2024-05-02', calibrationDueDate: '2025-05-02',
      certDocumentId: 'doc-twq-0534', certOnFile: true, onRoster: false },
    // Used on two connections; on no roster and holding no certificate.
    // Differs from rostered wrench 0289 by a single character.
    { id: 'wrench-0284', wrenchId: '0284', capacityFtLb: null,
      lastCalibrationDate: null, calibrationDueDate: null,
      certDocumentId: null, certOnFile: false, onRoster: false },
    // Certificates on file for equipment that never touched this job.
    ...WRENCH_CERT_ONLY.map((id) => ({
      id: `wrench-${id}`, wrenchId: id, capacityFtLb: 250,
      lastCalibrationDate: '2024-03-11', calibrationDueDate: '2025-03-11',
      certDocumentId: `doc-twq-${id}`, certOnFile: true, onRoster: false,
    })),
  ]

  const TORQUE_TOTAL = 616
  const TORQUE_INSPECTED = 118
  /** Connections dated after the book's as-of date — the single largest
   *  cluster of transcription errors in the delivered book. */
  const TORQUE_FUTURE_DATED = 278
  const torqueConnections: TorqueConnection[] = []

  // Wrench assignment: 0534 on exactly 6 rows, 0284 on exactly 2, the
  // roster nine spread across the rest.
  const wrenchPlan: string[] = [
    ...Array<string>(6).fill('0534'),
    ...Array<string>(2).fill('0284'),
  ]
  for (let i = wrenchPlan.length; i < TORQUE_TOTAL; i++) {
    wrenchPlan.push(WRENCH_ROSTER[i % WRENCH_ROSTER.length]!)
  }
  // Deterministic shuffle so the off-roster ids are scattered through the
  // log rather than sitting in the first eight rows.
  for (let i = wrenchPlan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[wrenchPlan[i], wrenchPlan[j]] = [wrenchPlan[j]!, wrenchPlan[i]!]
  }

  for (let i = 0; i < TORQUE_TOTAL; i++) {
    const size = pick(rng, ['2"', '3"', '4"', '6"'])
    const required = size === '6"' ? 420 : size === '4"' ? 310 : size === '3"' ? 225 : 150
    const wrenchIdRaw = wrenchPlan[i]!
    const futureDated = i < TORQUE_FUTURE_DATED
    const torqueDate = futureDated
      ? dateBetween(rng, '2025-03-01', '2025-12-27')
      : dateBetween(rng, '2024-11-04', '2024-12-30')
    const inspected = i % 5 === 2 && torqueConnections.filter((c) => c.inspectionDate).length < TORQUE_INSPECTED

    torqueConnections.push({
      id: `tq-${i + 1}`,
      jobBookId: book.id,
      isoFlangeNumber: `F-${String(i + 1).padStart(4, '0')}`,
      isoNumber: `ISO-${Math.floor(i / 20) + 1}`,
      flangePipeSize: size,
      boltDiameter: size === '6"' ? '7/8"' : '3/4"',
      boltCount: size === '2"' ? 4 : size === '6"' ? 12 : 8,
      requiredTorqueFtLb: required,
      // Every connection in the delivered log records actual exactly equal
      // to required. Left as-is: the pattern is the finding.
      actualTorqueFtLb: required,
      wrenchId: `wrench-${wrenchIdRaw}`,
      wrenchIdRaw,
      cpTestOnFlange: i % 11 === 0,
      torqueDate,
      employeeInitials: pick(rng, ['JD', 'KR', 'CT', 'VL']),
      inspectionDate: inspected ? torqueDate : null,
      inspectorInitials: inspected ? pick(rng, ['RA', 'DW']) : null,
      status: 'recorded',
    })
  }
  // Top up inspections to exactly 118 so the rate reads 19.16%.
  for (const c of torqueConnections) {
    if (torqueConnections.filter((x) => x.inspectionDate).length >= TORQUE_INSPECTED) break
    if (c.inspectionDate) continue
    c.inspectionDate = c.torqueDate
    c.inspectorInitials = 'RA'
  }

  // -------------------------------------------------------------------
  // Materials. The heat number is the record; the MTR is its attachment.
  // -------------------------------------------------------------------
  const materialHeats: MaterialHeat[] = []
  const referencedHeats = new Set(welds.flatMap((w) => w.heatNumbers))
  const referencedList = [...referencedHeats].sort()
  referencedList.forEach((heat, i) => {
    // 21 referenced heats have no MTR: 12 carry a material record marked
    // missing, and 9 have no record in the book at all.
    const noRecord = i % 22 === 7 && i % 44 !== 7
    if (noRecord) return
    const missingMtr = i % 16 === 3
    materialHeats.push({
      id: `heat-${heat}`,
      jobBookId: book.id,
      heatNumber: heat,
      componentType: pick(rng, COMPONENT_TYPES),
      nominalSize: pick(rng, ['1"', '2"', '3"', '4"', '6"']),
      scheduleOrClass: rng() < 0.5 ? pick(rng, SCHEDULES) : pick(rng, PRESSURE_CLASSES),
      grade: pick(rng, PIPE_GRADES),
      description: pick(rng, COMPONENT_DESCRIPTIONS),
      mtrDocumentId: missingMtr ? null : `doc-mtr-${heat}`,
      mtrStatus: missingMtr ? 'missing' : 'on_file',
    })
  })
  // MTRs on file that no weld references — the second half of the
  // reconciliation report an auditor spot-checks.
  for (let i = 0; i < 12; i++) {
    const heat = `ORPH${String(i + 1).padStart(3, '0')}`
    materialHeats.push({
      id: `heat-${heat}`, jobBookId: book.id, heatNumber: heat,
      componentType: 'PIPE', nominalSize: '3"', scheduleOrClass: '80', grade: 'X42',
      description: 'Unreferenced material certificate',
      mtrDocumentId: `doc-mtr-${heat}`, mtrStatus: 'on_file',
    })
  }
  // Eight MTRs named only by a cryptic heat number, with no identifiable
  // heat on the face of the document.
  const CRYPTIC = ['foh', 'a2350', 'MX80', 't996', '19a760v', '2306975', '7a21bb', '7S14LG']
  CRYPTIC.forEach((name) => {
    materialHeats.push({
      id: `heat-cryptic-${name}`, jobBookId: book.id, heatNumber: name.toUpperCase(),
      componentType: null, nominalSize: null, scheduleOrClass: null, grade: null,
      description: 'Filed under a bare heat number; component and grade not identified',
      mtrDocumentId: `doc-mtr-cryptic-${name}`, mtrStatus: 'unidentified',
    })
  })

  // -------------------------------------------------------------------
  // Certificates
  // -------------------------------------------------------------------
  const certificates: Certificate[] = [
    ...welders.map((w) => ({
      id: `cert-wpq-${w.initials}`, jobBookId: book.id,
      subjectType: 'welder' as const, subjectId: w.id, certType: 'ASME IX WPQ',
      issuingBody: 'Flowline Construction Services',
      issueDate: w.initials === 'SV' ? '2025-01-15' : '2024-04-05',
      expiryDate: null, documentId: `doc-wpq-${w.initials}`,
      verifiedBy: null, verifiedAt: null,
    })),
    ...cwis.map((c) => ({
      id: `cert-cwi-${c.initials}`, jobBookId: book.id,
      subjectType: 'cwi' as const, subjectId: c.id, certType: 'AWS CWI',
      issuingBody: 'American Welding Society', issueDate: '2023-01-10',
      expiryDate: '2026-01-10', documentId: `doc-cwi-${c.initials}`,
      verifiedBy: null, verifiedAt: null,
    })),
    ...ndtTechnicians.map((t) => ({
      id: `cert-ndt-${t.id}`, jobBookId: book.id,
      subjectType: 'ndt_technician' as const, subjectId: t.id,
      certType: `ASNT Level II — ${t.classification}`, issuingBody: t.employer ?? null,
      issueDate: '2022-03-01',
      // Owen Castillo's card lapses at the end of 2024, mid-job.
      expiryDate: t.id === 'ndt-4' ? '2024-12-31' : '2026-03-01',
      documentId: `doc-ndtcert-${t.id}`, verifiedBy: null, verifiedAt: null,
    })),
    ...torqueWrenches.filter((w) => w.certOnFile).map((w) => ({
      id: `cert-twq-${w.wrenchId}`, jobBookId: book.id,
      subjectType: 'torque_wrench' as const, subjectId: w.id,
      certType: 'Torque wrench calibration', issuingBody: 'Precision Calibration Co.',
      issueDate: w.lastCalibrationDate!, expiryDate: w.calibrationDueDate,
      documentId: w.certDocumentId, verifiedBy: null, verifiedAt: null,
    })),
  ]

  // -------------------------------------------------------------------
  // Sections and documents
  // -------------------------------------------------------------------
  const { sections, documents } = buildSectionsAndDocuments(
    book, sectionDefinitions, defByNumber, materialHeats, ndeReports, torqueWrenches, welders, rng,
  )

  return {
    book,
    project: {
      id: DP452_PROJECT_ID, clientOrgId: CHEVRON_ORG_ID,
      name: 'DP452 Flowline — CC19-03 / CC16-24 / CC20-18',
      operatorPicName: 'B. Hargrove', afeNumber: 'AFE 24-DP452',
    },
    clientOrg: { id: CHEVRON_ORG_ID, name: 'Chevron', logoUrl: null },
    sectionDefinitions,
    sections,
    documents,
    weldLines,
    welds,
    welders,
    welderQualifications,
    cwis,
    ndtTechnicians,
    torqueWrenches,
    torqueConnections,
    certificates,
    ndeReports,
    materialHeats,
    // Sections 17 and 18 are absent from the delivered book, so there are
    // no records to seed. That absence is the finding.
    pressureTests: [],
    cpTestPoints: [],
    utReadings: [],
  }
}

function heatNumberFor(i: number): string {
  const prefixes = ['A', 'B', 'D', 'E', 'H', 'K', 'M', 'N', 'P', 'R', 'T', 'V']
  const p = prefixes[i % prefixes.length]!
  return `${p}${String(100000 + i * 137).slice(-6)}`
}

function blankWeld(
  jobBookId: string, weldLineId: string, weldNumber: string, sortOrder: number,
  status: Weld['status'],
): Weld {
  return {
    id: `weld-${weldLineId}-${weldNumber}-nu`, weldLineId, jobBookId, weldNumber, sortOrder,
    weldDate: null, welderPassAssignment: null,
    rootWelderId: null, hotWelderId: null, fillWelderId: null, capWelderId: null,
    jointType: null, componentDescription: 'NOT USED', partLength: null, heatNumbers: [],
    cwiInitials: null, cwiId: null, cwiVisualResult: null, visualInspectionDate: null,
    ndtCompany: null, xrayNumber: null, ndtTicketNumber: null, ndtMethod: null,
    ndtResult: null, ndtReportId: null, status, comments: null,
  }
}

// ---------------------------------------------------------------------
// Documents: 315 files, ~402 MB, mirroring the delivered folder tree.
// ---------------------------------------------------------------------
function buildSectionsAndDocuments(
  book: JobBook,
  defs: SectionDefinition[],
  defByNumber: Map<string, SectionDefinition>,
  heats: MaterialHeat[],
  reports: NdeReport[],
  wrenches: TorqueWrench[],
  welders: Welder[],
  rng: () => number,
): { sections: JobBookSection[]; documents: DocumentRecord[] } {
  const sections: JobBookSection[] = defs.map((d) => {
    const applicable = appliesToBook(d.appliesTo, book.bookType)
    return {
      id: `sec-${d.sectionNumber}`,
      jobBookId: book.id,
      sectionDefinitionId: d.id,
      // Facility-only sections are scaffolded and marked N/A rather than
      // omitted, with the reason recorded.
      status: !applicable ? 'na' : 'in_progress',
      naReason: !applicable
        ? 'Facility-only section; this flowline book delivers the combined weld, X-ray, heat number and torque map under section 19-22.'
        : null,
      readyForReviewBy: null,
      approvedBy: null,
      approvedAt: null,
      computedPct: 0,
      internalNotes: null,
    }
  })
  const sectionIdFor = (n: string) => `sec-${n}`

  const documents: DocumentRecord[] = []
  let bytesTotal = 0
  const add = (
    sectionNumber: string, originalFilename: string, sizeMb: number,
    opts: Partial<DocumentRecord> = {},
  ) => {
    const def = defByNumber.get(sectionNumber)
    if (!def) throw new Error(`no section ${sectionNumber}`)
    const byteSize = Math.round(sizeMb * 1_048_576)
    bytesTotal += byteSize
    const id = opts.id ?? `doc-${documents.length + 1}`
    documents.push({
      id,
      jobBookId: book.id,
      sectionId: sectionIdFor(sectionNumber),
      recordType: opts.recordType ?? null,
      recordId: opts.recordId ?? null,
      originalFilename,
      normalizedFilename: normalizeFilename(originalFilename, sectionNumber, book.jobNumber),
      storagePath: `${book.jobNumber}/${sectionNumber}/${id}`,
      mimeType: mimeFor(originalFilename),
      byteSize,
      sha256: opts.sha256 ?? fakeSha(`${id}:${originalFilename}`),
      pageCount: opts.pageCount ?? Math.max(1, Math.round(sizeMb * 4)),
      version: 1,
      supersedesDocumentId: opts.supersedesDocumentId ?? null,
      isSuperseded: opts.isSuperseded ?? false,
      visibility: opts.visibility ?? 'client',
      uploadedBy: 'user-tech-1',
      uploadedAt: '2025-03-04T15:20:00Z',
      // Everything filed has been approved except where noted; the score
      // counts approved documents, not merely present ones.
      approvedBy: opts.approvedBy === undefined ? 'user-mgr-1' : opts.approvedBy,
      approvedAt: opts.approvedAt === undefined ? '2025-03-06T18:00:00Z' : opts.approvedAt,
      deletedAt: null,
    })
  }

  // 1 · Job Book Checklist — the one DOCX in the package.
  add('1', 'DP452 Job Book Checklist.docx', 0.4)
  // 2 · Overview drawings, original plus redline.
  add('2', 'DP452 Flowline Overview.pdf', 8.2)
  add('2', 'DP452 Flowline Overview REDLINE.pdf', 9.1)
  add('2', 'CC19-03 Layout.pdf', 4.4)
  add('2', 'CC16-24 Layout.pdf', 4.1)
  // 3 · Piping specification.
  add('3', 'Noble Energy Piping Specification Rev 7.pdf', 6.3)
  // 4 · WPS.
  add('4', 'WPS-1 GTAW-SMAW.pdf', 1.1)
  add('4', 'WPS-2 SMAW.pdf', 1.0)
  // 5 · PQR, including one misfiled into the wrong section in the delivered
  // book — kept here so the section-vs-content mismatch is visible.
  add('5', 'PQR-1.pdf', 1.4)
  add('5', 'PQR-2 (filed under WPS in delivered book).pdf', 1.3)
  // 6 · WPQ — ten records across eight welders.
  welders.forEach((w) => add('6', `WPQ ${w.fullName}.pdf`, 0.6, { id: `doc-wpq-${w.initials}` }))
  add('6', 'WPQ Henry Smith REQUAL.pdf', 0.6, { id: 'doc-wpq-HS2-requal' })
  add('6', 'WPQ Jaime Dinkins REQUAL.pdf', 0.6, { id: 'doc-wpq-JD-requal' })
  // 7 · CWI credentials, two of them phone photographs of the card.
  add('7', 'CWI Card Ruben Alvarez.jpeg', 2.2, { id: 'doc-cwi-RA' })
  add('7', 'CWI Card Dean Whitfield.jpg', 1.9, { id: 'doc-cwi-DW' })
  add('7', 'CWI Continuity Alvarez.pdf', 0.4)
  add('7', 'CWI Continuity Whitfield.pdf', 0.4)
  // 8 · NDT technician credentials.
  for (let i = 1; i <= 4; i++) add('8', `NDT Tech Cert ${i}.pdf`, 0.5, { id: `doc-ndtcert-ndt-${i}` })
  add('8', 'TEAM NDT Personnel Roster.pdf', 0.7)
  add('8', 'Desert NDT Personnel Roster.pdf', 0.6)
  // 9 · NDT procedures, one per method.
  for (const m of ['MT', 'PT', 'RT', 'UT']) add('9', `FDS-${m}-001 Procedure Rev 3.pdf`, 1.2)

  // 10 · NDE reports — 39 PDF plus one XLSX job log. Three "- Corrected"
  // revisions sit alongside their originals with nothing marking which
  // governs, exactly as delivered.
  reports.forEach((r, i) => {
    const corrected = i === 9 || i === 13 || i === 25
    const name = r.id === 'nde-dp425'
      ? 'PT REPORT DP425 TEAM 2-28-2023.pdf'
      : `RT REPORT ${r.ndtCompany} ${r.reportDate.replace(/-/g, '.')}` +
        (corrected ? ' - Corrected' : '') + '.pdf'
    // The second and third 10.17 files are byte-identical to the first —
    // the same report saved three times under near-identical names.
    const dupOf = i === 10 || i === 11 ? 'doc-nde-10' : null
    add('10', name, 1.0 + rng(), {
      id: r.documentId ?? undefined, recordType: 'nde_report', recordId: r.id,
      sha256: dupOf ? documents.find((d) => d.id === dupOf)?.sha256 : undefined,
    })
  })
  add('10', 'DP452 NDT Job Log.xlsx', 0.9)

  // 11 · Overview sheet, generated from the weld log.
  add('11', 'DP452 Weld Log Overview with Inspection Percentages.pdf', 1.1)
  // 12 · The two Noble weld log workbooks.
  add('12', 'DP452 Weld Log Flow Lines.xlsx', 3.4)
  add('12', 'DP452 Weld Log Gas Lift.xlsx', 2.1)
  // 13 · Calibration certificates — 25 files for 12 distinct wrenches, with
  // the filename prefix alternating between TQW- and TWQ- for the same
  // equipment. Wrench identity comes from the managed record, never here.
  wrenches.filter((w) => w.certOnFile).forEach((w, i) => {
    add('13', `${i % 2 === 0 ? 'TQW' : 'TWQ'}-${w.wrenchId} Calibration.pdf`, 0.3,
        { id: w.certDocumentId ?? undefined, recordType: 'torque_wrench', recordId: w.id })
  })
  for (let i = 0; i < 13; i++) {
    const w = wrenches.filter((x) => x.certOnFile)[i % 12]!
    add('13', `${i % 2 === 0 ? 'TWQ' : 'TQW'}-${w.wrenchId} Calibration ${2024 + (i % 2)}.pdf`, 0.3)
  }
  // 14 · The torque log workbook.
  add('14', 'Torque Log DP452.xlsx', 1.7)

  // 15 · Material test reports. 189 PDFs across six naming conventions,
  // plus three unexpanded ZIP bundles totalling 100 MB.
  const mtrHeats = heats.filter((h) => h.mtrDocumentId)
  const prefixes = ['MTR ', '', "MTR's ", 'MTRs ', 'MTRS ', 'HEAT ']
  mtrHeats.slice(0, 178).forEach((h, i) => {
    const prefix = i < 161 ? 'MTR ' : prefixes[(i - 161) % prefixes.length]!
    add('15', `${prefix}${h.heatNumber}.pdf`, 0.42 + rng() * 0.34,
        { id: h.mtrDocumentId!, recordType: 'material_heat', recordId: h.id })
  })
  // Eight files named only by a cryptic heat number.
  const cryptic = [
    'foh.pdf', 'a2350.pdf', 'MX80.pdf', 't996.pdf', '19a760v.pdf',
    '2306975.pdf', '7a21bb.pdf', '2024-12-04_13-4-37_7S14LG.pdf',
  ]
  cryptic.forEach((name, i) => {
    const h = heats.find((x) => x.id === `heat-cryptic-${['foh','a2350','MX80','t996','19a760v','2306975','7a21bb','7S14LG'][i]}`)
    add('15', name, 0.6, { id: h?.mtrDocumentId ?? undefined, recordType: 'material_heat', recordId: h?.id ?? null })
  })
  // Three duplicate MTRs by content hash.
  for (let i = 0; i < 3; i++) {
    const source = documents.find((d) => d.id === mtrHeats[i * 10]!.mtrDocumentId)
    add('15', `MTR ${mtrHeats[i * 10]!.heatNumber} (1).pdf`, 0.45, { sha256: source?.sha256 })
  }
  // Three unexpanded ZIP bundles. Their contents are invisible to
  // indexing, hashing and every reconciliation report in this application.
  add('15', 'MTRs Batch 1.zip', 41.0)
  add('15', 'MTRs Batch 2.zip', 33.5)
  add('15', 'MTRs Batch 3.zip', 25.5)

  // 16, 17, 18 — nothing. These three sections are entirely absent from the
  // delivered book, which is what caps its score at 86%.

  // 19-22 · The combined flowline map.
  add('19-22', 'DP452 Weld Map with X-ray Heat Number and Torque Map.pdf', 12.4)
  add('19-22', 'CC19-03 Weld Map.pdf', 7.7)
  add('19-22', 'CC16-24 Weld Map.pdf', 7.2)
  add('19-22', 'CC20-18 Weld Map.pdf', 6.9)
  add('19-22', 'DP452 Torque Map.pdf', 5.5)
  add('19-22', 'DP452 Heat Number Map.pdf', 5.9)

  // Supplemental · 14 sequential Flexpipe daily field reports, which appear
  // on no revision of the checklist and score nothing.
  for (let i = 1; i <= 14; i++) add('S1', `Flexpipe DFR ${String(i).padStart(2, '0')}.pdf`, 0.7)

  return { sections, documents }
}

function mimeFor(filename: string): string {
  if (/\.pdf$/i.test(filename)) return 'application/pdf'
  if (/\.xlsx$/i.test(filename)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (/\.docx$/i.test(filename)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (/\.zip$/i.test(filename)) return 'application/zip'
  if (/\.jpe?g$/i.test(filename)) return 'image/jpeg'
  return 'application/octet-stream'
}
