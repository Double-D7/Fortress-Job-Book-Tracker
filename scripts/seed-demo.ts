#!/usr/bin/env tsx
/**
 * Five demo job books, at five stages of completion.
 *
 * WHY THIS IS A GENERATOR AND NOT A .sql FILE. The percentages have to be
 * REAL. A hand-written INSERT with `computed_pct = 58` asserts a number
 * nothing produced, and the first person to open the section breakdown
 * finds it disagrees with the evidence underneath — which teaches them
 * that the percentage on the dashboard is decorative. So the books are
 * built as domain objects, run through the same `scoreBook` the
 * application runs, and the scores it returns are what gets written.
 *
 * EVERY ROW IS DELETABLE. Each id is derived from a fixed namespace and
 * starts `d0d0d0d0-`, so `supabase/demo/delete-demo.sql` removes the lot
 * with one predicate per table and cannot touch a real book. The demo
 * client organisations are named "(DEMO)" so nobody has to remember.
 *
 *   npx tsx scripts/seed-demo.ts        # writes supabase/demo/*.sql
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { buildTemplateSections } from '../src/lib/domain/checklist'
import { scoreBook, applyComputedScores } from '../src/lib/domain/scoring'
import { evaluateFlags, aggregateFindings, countBySeverity } from '../src/lib/domain/flags'
import { byStandard, entryTimeliness } from '../src/lib/domain/timeliness'
import { evaluateGate, GATE_ORDER } from '../src/lib/domain/gates'
import { makeRng, intBetween, pick } from '../src/lib/data/seed/rng'
import { addDays } from '../src/lib/domain/dates'
import type {
  BookType, Certificate, Cwi, DocumentRecord, GateId, IsoDate, JobBookBundle,
  JobBookSection, MaterialHeat, NdeReport, NdtTechnician, PressureTest,
  TorqueConnection, TorqueWrench, Weld, WeldLine, Welder, WelderQualification,
} from '../src/lib/domain/types'

// ---------------------------------------------------------------------
// Identity: one namespace, so one predicate deletes everything
// ---------------------------------------------------------------------

const NS = 'd0d0d0d0'
const id = (kind: string, key: string): string => {
  const h = createHash('sha256').update(`${kind}/${key}`).digest('hex')
  return `${NS}-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 24)}`
}

// ---------------------------------------------------------------------
// The five books
// ---------------------------------------------------------------------

interface DemoSpec {
  key: string
  jobNumber: string
  facility: string
  operator: string
  bookType: BookType
  /** How far through construction, 0–1. Drives every population below. */
  progress: number
  /** Highest gate cleanly passed. */
  gate: GateId | null
  /** A gate decided but not cleanly passed, for the conditional-pass case. */
  conditional?: { gate: GateId; dueAt: IsoDate }
  status: string
  start: IsoDate
  end: IsoDate
  asOf: IsoDate
  expectedWelds: number
  expectedTorque: number
  areas: string[]
  /** Deliberate defects, so the flag queue is not empty on every book. */
  defects: { expiredWrench?: boolean; unstampedWelds?: number }
  /**
   * One record in this many is entered late, which is what the §8 rate
   * measures. Varied per book on purpose: a demo where every book files at
   * the same rate shows nothing about the metric.
   */
  lateOneIn: number
}

const SPECS: DemoSpec[] = [
  {
    key: 'cottonwood', lateOneIn: 99, jobNumber: 'DEMO-CW-14-2', facility: 'Cottonwood 14-2',
    operator: 'Redtail Resources (DEMO)', bookType: 'flowline',
    progress: 0.08, gate: 'G0', status: 'in_progress',
    start: '2026-08-17', end: '2027-02-26', asOf: '2026-09-21',
    expectedWelds: 8, expectedTorque: 6, areas: ['Pad CW-14'],
    defects: {},
  },
  {
    key: 'sagedraw', lateOneIn: 3, jobNumber: 'DEMO-SD-B', facility: 'Sage Draw Pad B',
    operator: 'Redtail Resources (DEMO)', bookType: 'flowline',
    progress: 0.34, gate: 'G0', conditional: { gate: 'G1', dueAt: '2026-09-28' },
    status: 'in_progress',
    start: '2026-04-06', end: '2027-01-29', asOf: '2026-09-21',
    expectedWelds: 10, expectedTorque: 7, areas: ['Pad SD-B'],
    defects: {},
  },
  {
    key: 'mesaridge', lateOneIn: 5, jobNumber: 'DEMO-MR-CTB', facility: 'Mesa Ridge Central Tank Battery',
    operator: 'Gannet Midstream (DEMO)', bookType: 'facility',
    progress: 0.60, gate: 'G2', status: 'in_progress',
    start: '2025-11-03', end: '2026-11-27', asOf: '2026-09-21',
    expectedWelds: 12, expectedTorque: 9,
    areas: ['Area 100 Inlet', 'Area 200 Separation', 'Area 300 Tanks'],
    defects: { expiredWrench: true },
  },
  {
    key: 'juniper', lateOneIn: 9, jobNumber: 'DEMO-JF-CPF', facility: 'Juniper Flats Central Processing',
    operator: 'Gannet Midstream (DEMO)', bookType: 'facility',
    progress: 0.88, gate: 'G3', status: 'in_progress',
    start: '2025-03-10', end: '2026-08-28', asOf: '2026-09-21',
    expectedWelds: 11, expectedTorque: 8,
    areas: ['Area 10 Inlet', 'Area 20 Compression', 'Area 30 Export'],
    defects: { unstampedWelds: 3 },
  },
  {
    key: 'antelope', lateOneIn: 99, jobNumber: 'DEMO-AP-9-1', facility: 'Antelope Point 9-1',
    operator: 'Bitterroot Energy (DEMO)', bookType: 'flowline',
    progress: 1, gate: 'G4', status: 'submitted',
    start: '2025-06-02', end: '2026-05-29', asOf: '2026-06-12',
    expectedWelds: 8,  expectedTorque: 5, areas: ['Pad AP-9'],
    defects: {},
  },
]

const CREW = [
  ['RV', 'Ray Vasquez'], ['DM', 'Dale Munro'], ['TB', 'Tomas Bergstrom'],
  ['KO', 'Kwame Osei'], ['JL', 'Jana Lindqvist'], ['SP', 'Sam Petrov'],
] as const
const CWIS = [['AEM', 'Alan Emmerich'], ['PRK', 'Priya Raghunathan']] as const
const TECHS = [['NDT-1', 'Marco Delgado'], ['NDT-2', 'Ruth Okonkwo']] as const

// ---------------------------------------------------------------------
// Building one book
// ---------------------------------------------------------------------

function build(spec: DemoSpec): JobBookBundle {
  const rng = makeRng(
    [...spec.key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7),
  )
  const bookId = id('book', spec.key)
  const templateId = id('template', spec.bookType)
  const p = spec.progress

  const defs = buildTemplateSections(spec.bookType, templateId)
    .filter((d) => d.appliesTo === 'both' || d.appliesTo === spec.bookType)

  const dayIn = (f: number) => addDays(spec.start, Math.floor(f * 300))
  /** Drawings the logs reference. §21 and §22 score against this as the
   *  denominator, so it has to be a number a real job would carry. */
  const ISO_COUNT = 3

  // -- people -----------------------------------------------------------
  const crewSize = Math.max(2, Math.round(CREW.length * Math.min(1, p + 0.35)))
  // `welder.initials`, `cwi.initials` and `torque_wrench.wrench_id` are
  // UNIQUE across the whole database, not per book, so five demo books
  // sharing a crew need distinct stamps. The suffix belongs in the model
  // rather than in the SQL: applied at emission time it would leave the
  // register saying RV-14-2 while every weld says RV, and the scores
  // computed here would describe data the database does not hold.
  const tag = spec.jobNumber.replace('DEMO-', '')
  const welders: Welder[] = CREW.slice(0, crewSize).map(([initials, fullName]) => ({
    id: id('welder', `${spec.key}:${initials}`),
    fullName, initials: `${initials}-${tag}`, active: true, nameAliases: [initials],
    enteredAt: `${spec.start}T14:00:00Z`, entrySource: 'field_entry',
  }))
  const welderQualifications: WelderQualification[] = welders.map((w, i) => ({
    id: id('wq', `${spec.key}:${w.initials}`),
    welderId: w.id, code: 'ASME_IX', process: 'GTAW/SMAW',
    qualificationDate: addDays(spec.start, -intBetween(rng, 60, 400)),
    expiryDate: addDays(spec.end, intBetween(rng, 20, 300) - (i === 0 ? 0 : 0)),
    enteredAt: `${spec.start}T14:00:00Z`, entrySource: 'field_entry',
  }))
  const cwis: Cwi[] = CWIS.map(([initials, fullName]) => ({
    id: id('cwi', `${spec.key}:${initials}`), fullName, initials: `${initials}-${tag}`, active: true,
    enteredAt: `${spec.start}T14:00:00Z`, entrySource: 'field_entry',
  }))
  const ndtTechnicians: NdtTechnician[] = TECHS.map(([initials, fullName]) => ({
    id: id('ndt', `${spec.key}:${initials}`), fullName, initials,
    classification: 'Formal', active: true,
    enteredAt: `${spec.start}T14:00:00Z`, entrySource: 'field_entry',
  }))

  // -- equipment --------------------------------------------------------
  const wrenchCount = Math.max(2, Math.round(4 * Math.min(1, p + 0.4)))
  const torqueWrenches: TorqueWrench[] = Array.from({ length: wrenchCount }, (_, i) => ({
    id: id('wrench', `${spec.key}:${i}`),
    wrenchId: `${1200 + i * 37}-${tag}`,
    capacityFtLb: pick(rng, [600, 1000, 1500]),
    lastCalibrationDate: addDays(spec.start, -intBetween(rng, 10, 90)),
    calibrationDueDate: addDays(spec.start, 300),
    certOnFile: true, certRead: true, onRoster: true,
  }))

  const certificates: Certificate[] = [
    ...cwis.map((c) => ({
      id: id('cert', `${spec.key}:cwi:${c.id}`), jobBookId: bookId,
      subjectType: 'cwi' as const, subjectId: c.id, certType: 'AWS CWI',
      issuingBody: 'AWS', issueDate: addDays(spec.start, -200),
      expiryDate: addDays(spec.end, 400),
    })),
    ...ndtTechnicians.map((t) => ({
      id: id('cert', `${spec.key}:ndt:${t.id}`), jobBookId: bookId,
      subjectType: 'ndt_technician' as const, subjectId: t.id, certType: 'ASNT Level II',
      issuingBody: 'ASNT', issueDate: addDays(spec.start, -180),
      expiryDate: addDays(spec.end, 300),
    })),
    ...welders.map((w) => ({
      id: id('cert', `${spec.key}:wpq:${w.id}`), jobBookId: bookId,
      subjectType: 'welder' as const, subjectId: w.id, certType: 'WPQ ASME IX',
      issueDate: welderQualifications.find((q) => q.welderId === w.id)!.qualificationDate,
      expiryDate: welderQualifications.find((q) => q.welderId === w.id)!.expiryDate,
    })),
    ...['gauge', 'recorder', 'psv'].map((kind) => ({
      id: id('cert', `${spec.key}:pt:${kind}`), jobBookId: bookId,
      // §11.1 requires all three certified on the test date. They are
      // separate instruments with separate certificates, and pointing all
      // three at one record would be the defect the rule exists to catch.
      subjectType: 'pressure_recorder' as const,
      subjectId: id('instrument', `${spec.key}:${kind}`),
      certType: kind === 'gauge' ? 'Gauge calibration'
        : kind === 'psv' ? 'PSV certification' : 'Chart recorder calibration',
      issuingBody: 'Rocky Mountain Calibration',
      issueDate: addDays(spec.start, -30),
      expiryDate: addDays(spec.end, 90),
    })),
    ...torqueWrenches.map((t, i) => ({
      id: id('cert', `${spec.key}:wr:${t.id}`), jobBookId: bookId,
      subjectType: 'torque_wrench' as const, subjectId: t.id, certType: 'Calibration',
      issuingBody: 'HYTORC', issueDate: t.lastCalibrationDate!,
      // One book carries a wrench whose calibration lapsed mid-job. It is
      // the single most common Critical in a real book and a demo with an
      // empty flag queue teaches nothing.
      expiryDate: spec.defects.expiredWrench && i === 0
        ? addDays(spec.start, 120)
        : addDays(spec.end, 120),
    })),
  ]

  // -- lines and welds --------------------------------------------------
  const weldLines: WeldLine[] = spec.areas.map((code, i) => ({
    id: id('line', `${spec.key}:${code}`), jobBookId: bookId, lineCode: code,
    lineDescription: null, sortOrder: i,
    groupingKind: spec.bookType === 'facility' ? 'construction_area' : 'line',
    expectedWeldCount: Math.round(spec.expectedWelds / spec.areas.length),
  }))

  // The heat register is built below; the welds have to reference the same
  // numbers or §15 scores zero against a register full of MTRs.
  const heatPool = Math.max(1, Math.round(5 * p))
  const weldCount = Math.round(spec.expectedWelds * p)
  const unstamped = spec.defects.unstampedWelds ?? 0
  // `i % n === 0` is true at i = 0 for every n, so the first record of
  // every book was late no matter what the book's rate was set to — which
  // on a two-weld book is a 33% timeliness rate produced entirely by the
  // modulo.
  const late = (i: number) => i > 0 && i % spec.lateOneIn === 0
  const welds: Weld[] = Array.from({ length: weldCount }, (_, i) => {
    const f = i / Math.max(1, weldCount)
    const date = dayIn(f * p)
    const welder = welders[i % welders.length]!
    const line = weldLines[i % weldLines.length]!
    const cwi = cwis[i % cwis.length]!
    // Every seventh ROUND of the rota, not every seventh weld. Selecting
    // on `i` means the NDE cycle and the welder cycle interfere: share a
    // factor and one man takes every examination, and even coprime the
    // coverage is only even in the limit — on a 65-weld job it still leaves
    // somebody under the 10% the job requires. Selecting on the round gives
    // every welder the same rate on any job of any size, which is what the
    // requirement actually asks for.
    const nde = Math.floor(i / welders.length) % 7 === 0
    const noStamp = i < unstamped
    // §8.1 gives the weld "end of next business day" and the CWI visual
    // "end of same business day", with different owners — so they are
    // entered on different days here, as they are in the field.
    const entered = addDays(date, late(i) ? 4 : 1)
    const visualEntered = late(i + 3) ? addDays(date, 2) : date
    return {
      id: id('weld', `${spec.key}:${i}`),
      weldLineId: line.id, jobBookId: bookId,
      weldNumber: `W-${String(i + 1).padStart(4, '0')}`,
      sortOrder: i, weldDate: date,
      welderPassAssignment: null,
      rootWelderId: null, hotWelderId: null, fillWelderId: null, capWelderId: null,
      welderStamp: noStamp ? null : welder.initials,
      welderId: noStamp ? null : welder.id,
      jointType: i % 8 === 0 ? 'O-let' : i % 97 === 0 ? 'Socket' : 'Butt',
      componentDescription: null, partLength: null,
      heatNumbers: [`H${70000 + (i % Math.max(1, heatPool)) * 13}`],
      cwiInitials: cwi.initials, cwiId: cwi.id,
      cwiVisualResult: 'Pass', visualInspectionDate: date,
      ndtCompany: nde ? 'Rocky Mountain NDT' : null,
      xrayNumber: nde ? `RT-${1000 + i}` : null,
      ndtTicketNumber: nde ? `RT-${1000 + i}` : null,
      ndtMethod: nde ? 'RT' : null,
      ndtResult: nde ? 'Pass' : null,
      ndtReportId: null,
      status: nde ? 'ndt_complete' : 'visual_complete',
      comments: null,
      constructionArea: line.lineCode,
      equipmentTag: null,
      isometricNumber: `ISO-${100 + (i % ISO_COUNT)}`,
      pressureTestRef: null,
      pipeSizeSchedule: '6" - SCH 40,STD',
      pipeGrade: 'Gr. B',
      designPressurePsi: 1440,
      enteredAt: `${entered}T16:30:00Z`,
      entrySource: 'field_entry',
      visualEnteredAt: `${visualEntered}T19:00:00Z`,
    } satisfies Weld
  })

  // -- the NDE reports have to exist before the welds can point at them,
  //    and the welds have to exist before the reports can be sized. Built
  //    in that order and linked back here.
  // -- torque -----------------------------------------------------------
  const torqueCount = Math.round(spec.expectedTorque * p)
  const torqueConnections: TorqueConnection[] = Array.from({ length: torqueCount }, (_, i) => {
    const f = i / Math.max(1, torqueCount)
    const date = dayIn(f * p)
    const wrench = torqueWrenches[i % torqueWrenches.length]!
    const inspected = i % 10 === 0
    const entered = addDays(date, late(i) ? 3 : 1)
    const inspectionEntered = late(i + 5) ? addDays(date, 2) : date
    return {
      id: id('torque', `${spec.key}:${i}`),
      jobBookId: bookId,
      isoFlangeNumber: `FL-${String(i + 1).padStart(4, '0')}`,
      isoNumber: `ISO-${100 + (i % ISO_COUNT)}`,
      flangePipeSize: '6"', boltDiameter: '3/4"', boltCount: 8,
      requiredTorqueFtLb: 260,
      requiredTorqueMinFtLb: 247, requiredTorqueMaxFtLb: 273,
      actualTorqueFtLb: 255 + (i % 9),
      wrenchId: wrench.id, wrenchIdRaw: wrench.wrenchId,
      cpTestOnFlange: false,
      torqueDate: date,
      employeeInitials: welders[i % welders.length]!.initials,
      inspectionDate: inspected ? date : null,
      inspectorInitials: inspected ? cwis[0]!.initials : null,
      enteredAt: `${entered}T16:30:00Z`,
      entrySource: 'field_entry',
      inspectionEnteredAt: inspected ? `${inspectionEntered}T19:00:00Z` : null,
    } as TorqueConnection
  })

  // -- heats, NDE, pressure --------------------------------------------
  const heatCount = heatPool
  const materialHeats: MaterialHeat[] = Array.from({ length: heatCount }, (_, i) => ({
    id: id('heat', `${spec.key}:${i}`), jobBookId: bookId,
    heatNumber: `H${70000 + i * 13}`,
    componentType: 'Pipe', nominalSize: '6"', scheduleOrClass: 'SCH 40', grade: 'Gr. B',
    description: null,
    mtrDocumentId: id('doc', `${spec.key}:mtr:${i}`),
    mtrStatus: 'on_file',
    receivedOn: dayIn((i / Math.max(1, heatCount)) * p),
    enteredAt: `${dayIn((i / Math.max(1, heatCount)) * p)}T10:00:00Z`,
    entrySource: 'field_entry',
  }))

  const ndeCount = Math.max(welds.some((w) => w.ndtMethod) ? 1 : 0,
                            Math.round(welds.filter((w) => w.ndtMethod).length / 8))
  const ndeReports: NdeReport[] = Array.from({ length: ndeCount }, (_, i) => {
    const date = dayIn((i / Math.max(1, ndeCount)) * p)
    return {
      id: id('nde', `${spec.key}:${i}`), jobBookId: bookId,
      reportNumber: `NDE-${2000 + i}`, reportDate: date,
      ndtCompany: 'Rocky Mountain NDT', method: 'RT',
      procedureReference: 'RT-PROC-01', revision: '3',
      acceptanceCriteria: 'API 1104',
      technicianId: ndtTechnicians[i % ndtTechnicians.length]!.id,
      workOrderNumber: null, clientPoAfe: null,
      equipmentModel: null, equipmentSerial: null, equipmentCalDueDate: null,
      isSuperseded: false, referencedFacility: null,
      documentId: id('doc', `${spec.key}:nde:${i}`),
      enteredAt: `${addDays(date, late(i) ? 5 : 2)}T11:00:00Z`, entrySource: 'field_entry',
    } as NdeReport
  })

  const ptCount = Math.round(3 * p)
  const pressureTests: PressureTest[] = Array.from({ length: ptCount }, (_, i) => {
    const date = dayIn((i / Math.max(1, ptCount)) * p)
    const certOf = (kind: string) =>
      certificates.find((c) => c.id === id('cert', `${spec.key}:pt:${kind}`))!
    return {
      id: id('pt', `${spec.key}:${i}`), jobBookId: bookId,
      testIdentifier: `PT-${String(i + 1).padStart(3, '0')}`,
      lineCodes: [spec.areas[0]!],
      testDate: date, testMedium: 'Water', testPressurePsi: 2160,
      durationMinutes: 240, result: 'Pass',
      gaugeSerial: 'PG-2210', gaugeCertId: certOf('gauge').id,
      recorderSerial: 'REC-4471', recorderCertId: certOf('recorder').id,
      psvSerial: 'PSV-118', psvCertId: certOf('psv').id,
      chartDocumentId: id('doc', `${spec.key}:chart:${i}`),
      witnessedBy: cwis[0]!.fullName,
      startPressurePsi: 2160, endPressurePsi: 2158, ambientTempF: 54,
      resultDocumentId: id('doc', `${spec.key}:ptresult:${i}`),
      enteredAt: `${addDays(date, 3)}T09:00:00Z`, entrySource: 'field_entry',
    } as PressureTest
  })

  // -- the sections that only exist on one template ---------------------
  //
  // Populating these matters more than it looks. §21 and §22 carry ten
  // points each on a facility book and §19 and §23 four apiece; leaving
  // them empty caps a facility book at 71% however complete it is, which
  // made the 60%-progress book score below the 34% one. A demo whose
  // percentages do not order themselves teaches the reader to distrust
  // the percentage.
  const cpCount = Math.round(4 * p)
  const cpTestPoints = Array.from({ length: cpCount }, (_, i) => ({
    id: id('cp', `${spec.key}:${i}`), jobBookId: bookId,
    testPointId: `CP-${String(i + 1).padStart(3, '0')}`,
    location: spec.areas[i % spec.areas.length]!,
    torqueConnectionId: null,
    baselinePotentialV: -0.92 + (i % 7) * 0.01,
    readingDate: dayIn((i / Math.max(1, cpCount)) * p),
    technician: TECHS[i % TECHS.length]![1],
    enteredAt: `${addDays(dayIn((i / Math.max(1, cpCount)) * p), 2)}T10:00:00Z`,
    entrySource: 'field_entry' as const,
  }))

  const utCount = spec.bookType === 'facility' ? Math.round(4 * p) : 0
  const utReadings = Array.from({ length: utCount }, (_, i) => ({
    id: id('ut', `${spec.key}:${i}`), jobBookId: bookId,
    locationId: `UT-${String(i + 1).padStart(3, '0')}`,
    description: 'Baseline wall thickness',
    nominalWall: 0.28, measuredWall: 0.271 + (i % 5) * 0.002,
    readingDate: dayIn((i / Math.max(1, utCount)) * p),
    technicianId: ndtTechnicians[i % ndtTechnicians.length]!.id,
    enteredAt: `${addDays(dayIn((i / Math.max(1, utCount)) * p), 2)}T10:00:00Z`,
    entrySource: 'field_entry' as const,
  }))

  const coatingAreas = spec.bookType === 'facility'
    ? spec.areas.slice(0, Math.max(1, Math.round(spec.areas.length * p)))
    : []
  const coatingInspections = coatingAreas.map((area, i) => ({
    id: id('coat', `${spec.key}:${i}`), jobBookId: bookId,
    constructionArea: area,
    inspectionDate: dayIn(p * 0.9),
    inspector: CWIS[0]![1],
    hasStructuredData: true, documentCount: 2, notes: null,
    enteredAt: `${addDays(dayIn(p * 0.9), 3)}T10:00:00Z`,
    entrySource: 'field_entry' as const,
  }))

  // §10 scores on two halves: the reports are on file, AND the examined
  // welds point at one. Linking here rather than at construction time
  // because the report count is derived from the welds.
  for (const [i, w] of welds.entries()) {
    if (!w.ndtMethod || ndeReports.length === 0) continue
    w.ndtReportId = ndeReports[i % ndeReports.length]!.id
  }

  // -- sections and documents -------------------------------------------
  const sections: JobBookSection[] = []
  const documents: DocumentRecord[] = []

  for (const def of defs) {
    const sectionId = id('section', `${spec.key}:${def.sectionNumber}`)
    const na = def.isOptional && spec.bookType === 'flowline' && def.sectionNumber === '23'
    const expected =
      def.linkedRecordType === 'weld' ? spec.expectedWelds
      : def.linkedRecordType === 'torque_connection' ? spec.expectedTorque
      : def.linkedRecordType === 'material_heat' ? 5
      : def.linkedRecordType === 'pressure_test' ? 3
      // Declared scope has to be what the job will actually hold, derived
      // the same way the reports are generated. A scope of 5 against 4
      // reports leaves a book that is finished sitting at 97.5%.
      : def.linkedRecordType === 'nde_report'
        ? Math.max(1, Math.round(Math.ceil(spec.expectedWelds / 7) / 8))
      : def.linkedRecordType === 'cp_test_point' ? 4
      : def.linkedRecordType === 'ut_reading' ? 4
      : def.linkedRecordType === 'isometric' ? ISO_COUNT
      : def.linkedRecordType === 'coating_inspection' ? spec.areas.length
      : def.requirementType === 'document' ? Math.max(1, def.minDocuments) : null

    // Procedures and specifications are loaded before first weld (Gate 0),
    // so they are complete on every book here. Everything else tracks
    // progress.
    const frontLoaded = ['2', '3', '4', '5', '9', '16'].includes(def.sectionNumber)
    // §21 and §22 are `records(isometric)` but score against the approved
    // DRAWINGS filed in them, against the isometrics the logs reference.
    // They need documents, not records.
    const isDrawingSection = def.linkedRecordType === 'isometric'
    // A register is not evidence. §6 holds the WPQ documents themselves,
    // §7 the CWI cards, §8 the NDT certifications, §13 the calibration
    // certificates — and `ruleEmptyRequiredSection` is right to call a
    // section with a populated register and no filed paper empty.
    const certDocs =
      def.linkedRecordType === 'welder' ? welders.length
      : def.linkedRecordType === 'cwi' ? cwis.length
      : def.linkedRecordType === 'ndt_technician' ? ndtTechnicians.length
      : def.requirementType === 'equipment_certs' ? torqueWrenches.length
      : 0
    if ((def.requirementType === 'document' || isDrawingSection || certDocs > 0)
        && (expected || isDrawingSection || certDocs > 0)) {
      const required = isDrawingSection ? ISO_COUNT : certDocs > 0 ? certDocs : expected!
      // Certificates are a Gate 0 precondition — nobody mobilises without
      // them — so they are filed in full from day one, like the procedures.
      const approvedCount = na ? 0
        : frontLoaded || certDocs > 0 ? required
        : Math.round(required * Math.min(1, p * 1.05))
      for (let i = 0; i < approvedCount; i += 1) {
        const sha = createHash('sha256')
          .update(`${spec.key}:${def.sectionNumber}:${i}`).digest('hex').slice(0, 64)
        documents.push({
          id: id('doc', `${spec.key}:${def.sectionNumber}:${i}`),
          jobBookId: bookId, sectionId,
          originalFilename: `${def.sectionNumber}-${i + 1}.pdf`,
          normalizedFilename:
            `${def.sectionNumber.padStart(2, '0')}-DOC-${spec.jobNumber}-${i + 1}-${spec.start.replace(/-/g, '')}-R0.pdf`,
          storagePath: `${bookId}/${def.sectionNumber}/${sha}`,  // rebuilt in SQL
          mimeType: 'application/pdf', byteSize: 180_000 + i * 2_113, sha256: sha,
          version: 1, isSuperseded: false, visibility: 'client',
          uploadedBy: null, uploadedAt: `${dayIn(0.05)}T12:00:00Z`,
          approvedAt: `${dayIn(0.06)}T12:00:00Z`,
        } as DocumentRecord)
      }
    }

    sections.push({
      id: sectionId, jobBookId: bookId, sectionDefinitionId: def.id,
      status: na ? 'na' : p >= 1 ? 'approved' : p > 0.02 ? 'in_progress' : 'not_started',
      naReason: na ? 'No coating scope on this flowline; buried carbon steel with field-applied wrap only.' : null,
      computedPct: 0,
      expectedCount: expected,
      expectedBy: addDays(spec.end, -intBetween(rng, 0, 60)),
      ingestionStatus: 'imported',
    })
  }

  return {
    book: {
      id: bookId,
      projectId: id('project', spec.key),
      bookTemplateId: templateId,
      bookType: spec.bookType,
      jobNumber: spec.jobNumber,
      facilityName: spec.facility,
      wellNames: [], cwiNames: cwis.map((c) => c.fullName),
      constructionCompany: 'Fortress Development Solutions',
      weldingCompany: 'Fortress Development Solutions',
      pipeSizeIn: '6', pipeSchedule: 'SCH 40,STD', pipeGrade: 'Gr. B',
      status: spec.status as JobBookBundle['book']['status'],
      targetTurnoverDate: addDays(spec.end, 30),
      constructionStart: spec.start, constructionEnd: spec.end, dataAsOfDate: spec.asOf,
      requiredXrayPct: 10, requiredTorqueInspectPct: 10, torqueTolerancePct: 5,
      certExpiryWarningDays: 60, xrayCreditRule: 'all_passes',
      constructionAreas: spec.areas,
      clientChecklistReference: 'Operator Turnover Checklist',
      clientChecklistRevision: 'C',
      pipingSpecReference: `${spec.operator.replace(' (DEMO)', '')} Piping Specification`,
      pipingSpecRevision: '4',
      governingDocsConfirmedAt: addDays(spec.start, -6),
      custodianId: id('user', 'custodian'),
      custodianAssignedAt: `${addDays(spec.start, -7)}T15:00:00Z`,
      plannedCurveAgreedAt: addDays(spec.start, -6),
      currentGate: spec.gate,
      currentGateAt: spec.gate ? `${addDays(spec.start, -1)}T17:00:00Z` : null,
      workWeek: 'mon_sat',
      defaultDesignPressurePsi: 1440,
      inspectionRule: { kind: 'flat', requiredVisualPct: 100, requiredNdePct: 10, statedAs: '100% visual & 10% NDE' },
    },
    project: {
      id: id('project', spec.key), clientOrgId: id('org', spec.operator),
      name: spec.facility, operatorPicName: 'Demo Operator Rep', afeNumber: null,
    },
    clientOrg: { id: id('org', spec.operator), name: spec.operator, logoUrl: null },
    sectionDefinitions: defs, sections, documents,
    weldLines, welds, welders, welderQualifications, cwis, ndtTechnicians,
    torqueWrenches, torqueConnections, certificates, ndeReports, materialHeats,
    pressureTests,
    cpTestPoints: cpTestPoints as JobBookBundle['cpTestPoints'],
    utReadings: utReadings as JobBookBundle['utReadings'],
    coatingInspections: coatingInspections as JobBookBundle['coatingInspections'],
    complianceFlags: [],
  }
}

// ---------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------

/** Wraps a SQL expression so `q` emits it as code rather than a string. */
class SqlRaw { constructor(readonly sql: string) {} }
const RAW = (sql: string) => new SqlRaw(sql)

const q = (v: unknown): string => {
  if (v instanceof SqlRaw) return v.sql
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) {
    return v.length === 0
      ? `'{}'`
      : `array[${v.map((x) => q(x)).join(',')}]::text[]`
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

function insert(table: string, cols: string[], rows: unknown[][]): string {
  if (rows.length === 0) return ''
  const out: string[] = []
  const CHUNK = 250
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    out.push(
      `insert into ${table} (${cols.join(', ')}) values\n` +
      slice.map((r) => `  (${r.map(q).join(', ')})`).join(',\n') +
      `\non conflict (id) do nothing;`,
    )
  }
  return out.join('\n')
}

/** The two dates every seeded document shares: uploaded, then approved. */
const dayIn05 = (spec: DemoSpec) => addDays(spec.start, Math.floor(0.05 * 300))
const dayIn06 = (spec: DemoSpec) => addDays(spec.start, Math.floor(0.06 * 300))

const bundles = SPECS.map(build).map(applyComputedScores)

const sql: string[] = [
  `-- Five demo job books. Generated by scripts/seed-demo.ts — do not hand-edit.`,
  `--`,
  `-- Every id begins ${NS}- so supabase/demo/delete-demo.sql removes the`,
  `-- lot and cannot touch a real book. The percentages are produced by the`,
  `-- application's own scoring engine, not written by hand.`,
  `begin;`,
  ``,
  `-- The people these books are assigned to. Marked (DEMO) in their names`,
  `-- and given example.invalid addresses, which cannot receive mail, so a`,
  `-- demo account can never be signed into.`,
  insert('app_user',
    ['id', 'email', 'full_name', 'role', 'competency_level', 'is_active'],
    [
      [id('user', 'custodian'), 'demo.custodian@example.invalid', 'Dana Cortez (DEMO)', 'qaqc_tech', 'JB-2', true],
      [id('user', 'manager'), 'demo.manager@example.invalid', 'Marcus Hale (DEMO)', 'qaqc_manager', 'JB-4', true],
      [id('user', 'auditor'), 'demo.auditor@example.invalid', 'Ines Farrow (DEMO)', 'qaqc_tech', 'JB-3', true],
    ]),
  ``,
]

const orgs = new Map<string, string>()
for (const b of bundles) orgs.set(b.clientOrg.id, b.clientOrg.name)
sql.push(insert('client_org', ['id', 'name'], [...orgs].map(([oid, name]) => [oid, name])))
sql.push(insert('project', ['id', 'client_org_id', 'name', 'operator_pic_name'],
  bundles.map((b) => [b.project.id, b.project.clientOrgId, b.project.name, b.project.operatorPicName])))

for (const b of bundles) {
  const bk = b.book
  const score = scoreBook(b)
  sql.push(``, `-- ${bk.jobNumber} — ${bk.facilityName} — ${score.overallPct.toFixed(2)}%`)
  // The template id is looked up, not guessed: the templates were created
  // by the migrations and their ids belong to the database.
  const jbCols = [
    'id', 'project_id', 'book_template_id', 'book_type', 'job_number', 'facility_name',
    'construction_company', 'welding_company', 'cwi_names', 'pipe_size_in', 'pipe_schedule',
    'pipe_grade', 'status', 'target_turnover_date', 'construction_start', 'construction_end',
    'data_as_of_date', 'construction_areas', 'default_design_pressure_psi',
    'client_checklist_reference', 'client_checklist_revision', 'piping_spec_reference',
    'piping_spec_revision', 'governing_docs_confirmed_at', 'custodian_id',
    'custodian_assigned_at', 'planned_curve_agreed_at', 'current_gate', 'current_gate_at',
    'work_week',
  ]
  const jbValues = [
    q(bk.id), q(bk.projectId), 'bt.id', q(bk.bookType), q(bk.jobNumber), q(bk.facilityName),
    q(bk.constructionCompany), q(bk.weldingCompany), q(bk.cwiNames), q(bk.pipeSizeIn),
    q(bk.pipeSchedule), q(bk.pipeGrade), q(bk.status), q(bk.targetTurnoverDate),
    q(bk.constructionStart), q(bk.constructionEnd), q(bk.dataAsOfDate), q(bk.constructionAreas),
    q(bk.defaultDesignPressurePsi), q(bk.clientChecklistReference), q(bk.clientChecklistRevision),
    q(bk.pipingSpecReference), q(bk.pipingSpecRevision), q(bk.governingDocsConfirmedAt),
    q(bk.custodianId), q(bk.custodianAssignedAt), q(bk.plannedCurveAgreedAt), q(bk.currentGate),
    q(bk.currentGateAt), q(bk.workWeek),
  ]
  sql.push(
    `insert into job_book (${jbCols.join(', ')})\n` +
    `select ${jbValues.join(', ')}\n` +
    `  from book_template bt where bt.book_type = ${q(bk.bookType)} limit 1\n` +
    `on conflict (id) do nothing;`,
  )

  // job_assignment is keyed on (job_book_id, user_id) and has no id of its
  // own, so it is inserted and deleted by the book rather than by the
  // namespace prefix.
  sql.push(
    `insert into job_assignment (job_book_id, user_id, assigned_role) values\n` +
    `  (${q(bk.id)}, ${q(id('user', 'custodian'))}, 'custodian')\n` +
    `on conflict do nothing;`,
  )

  // Sections resolve their definition by number against the real template,
  // in one statement per book rather than one per section: the ids belong
  // to the database, and twenty-four round trips to say so is twenty-three
  // too many.
  const bookSpec = SPECS.find((x) => x.jobNumber === bk.jobNumber)!
  const sectionRows = b.sections.map((sec) => {
    const def = b.sectionDefinitions.find((d) => d.id === sec.sectionDefinitionId)!
    // An approved section carries who marked it ready and who approved it,
    // and they are different people — `approval_is_attributed` and
    // `approver_is_not_submitter` both refuse anything less, which is the
    // two-person control holding even against a seed script.
    const approved = sec.status === 'approved'
    return `(${q(sec.id)}, ${q(def.sectionNumber)}, ${q(sec.status)}, ${q(sec.naReason)}, ` +
      `${q(sec.computedPct)}, ${q(sec.collectedPct ?? sec.computedPct)}, ` +
      `${q(sec.expectedCount)}, ${q(sec.expectedBy)}, ` +
      `${approved ? q(id('user', 'custodian')) : 'null'}, ` +
      `${approved ? q(`${bookSpec.asOf}T09:00:00Z`) : 'null'}, ` +
      `${approved ? q(id('user', 'manager')) : 'null'}, ` +
      `${approved ? q(`${bookSpec.asOf}T15:00:00Z`) : 'null'})`
  })
  sql.push(
    // No ingestion_status column: the domain models "imported vs not yet
    // read" but the schema has never carried it, so a section read back
    // from the database reports `unknown`. Noted rather than invented.
    `insert into job_book_section (id, job_book_id, section_definition_id, status, na_reason,\n` +
    `  computed_pct, collected_pct, computed_at, expected_count, expected_by,\n` +
    `  ready_for_review_by, ready_for_review_at, approved_by, approved_at)\n` +
    `select v.id::uuid, ${q(bk.id)}, sd.id, v.status::section_status, v.na_reason,\n` +
    // Cast in the SELECT, once, rather than on every value in the VALUES
    // list — a hundred and eleven rows do not each need to say ::uuid.
    `       v.pct::numeric, v.collected::numeric, now(), v.expected::int,\n` +
    `       v.expected_by::date, v.ready_by::uuid, v.ready_at::timestamptz,\n` +
    `       v.approved_by::uuid, v.approved_at::timestamptz\n` +
    `  from (values\n    ${sectionRows.join(',\n    ')}\n` +
    `  ) as v(id, section_number, status, na_reason, pct, collected, expected, expected_by,\n` +
    `        ready_by, ready_at, approved_by, approved_at)\n` +
    `  join section_definition sd on sd.section_number = v.section_number\n` +
    `  join book_template bt on bt.id = sd.book_template_id and bt.book_type = ${q(bk.bookType)}\n` +
    `on conflict (id) do nothing;`,
  )

  sql.push(insert('welder', ['id', 'full_name', 'initials', 'active', 'entered_at', 'entry_source'],
    b.welders.map((w) => [w.id, w.fullName, w.initials, w.active, w.enteredAt, w.entrySource])))
  sql.push(insert('welder_qualification',
    ['id', 'welder_id', 'code', 'process', 'qualification_date', 'expiry_date', 'source', 'entered_at', 'entry_source'],
    b.welderQualifications.map((x) => [x.id, x.welderId, x.code, x.process, x.qualificationDate, x.expiryDate, 'wpq_document', x.enteredAt, x.entrySource])))
  sql.push(insert('cwi', ['id', 'full_name', 'initials', 'active', 'entered_at', 'entry_source'],
    b.cwis.map((c) => [c.id, c.fullName, c.initials, c.active, c.enteredAt, c.entrySource])))
  sql.push(insert('ndt_technician',
    ['id', 'full_name', 'initials', 'classification', 'active', 'entered_at', 'entry_source'],
    b.ndtTechnicians.map((t) => [t.id, t.fullName, t.initials, t.classification, t.active, t.enteredAt, t.entrySource])))
  sql.push(insert('torque_wrench',
    ['id', 'wrench_id', 'capacity_ft_lb', 'last_calibration_date', 'calibration_due_date', 'cert_on_file', 'cert_read'],
    b.torqueWrenches.map((w) => [w.id, w.wrenchId, w.capacityFtLb, w.lastCalibrationDate, w.calibrationDueDate, w.certOnFile, w.certRead])))
  sql.push(insert('certificate',
    ['id', 'job_book_id', 'subject_type', 'subject_id', 'cert_type', 'issuing_body', 'issue_date', 'expiry_date'],
    b.certificates.map((c) => [c.id, c.jobBookId, c.subjectType, c.subjectId, c.certType, c.issuingBody, c.issueDate, c.expiryDate])))
  sql.push(insert('weld_line',
    ['id', 'job_book_id', 'line_code', 'sort_order', 'grouping_kind', 'expected_weld_count'],
    b.weldLines.map((l) => [l.id, l.jobBookId, l.lineCode, l.sortOrder, l.groupingKind, l.expectedWeldCount])))
  // Emitted as a SELECT over a VALUES list so the constants that are the
  // same on every row — the book, the mime type, the timestamps — are
  // written once instead of a hundred and twenty-eight times, and the
  // storage path is built from the sha rather than repeating it.
  const docRows = b.documents.map((d) => {
    const section = d.storagePath.split('/')[1]!
    return `(${q(d.id)}, ${q(d.sectionId)}, ${q(section)}, ${q(d.originalFilename)}, ` +
      `${q(d.normalizedFilename)}, ${q(d.sha256)}, ${q(d.byteSize)})`
  })
  if (docRows.length > 0) {
    sql.push(
      `insert into document (id, job_book_id, section_id, original_filename,\n` +
      `  normalized_filename, storage_path, mime_type, byte_size, sha256, version,\n` +
      `  is_superseded, visibility, uploaded_at, approved_at)\n` +
      `select v.id::uuid, ${q(bk.id)}, v.section_id::uuid, v.fn, v.nfn,\n` +
      `       ${q(bk.id)} || '/' || v.sect || '/' || v.sha, 'application/pdf', v.bytes::bigint,\n` +
      `       v.sha, 1, false, 'client', ${q(`${dayIn05(bookSpec)}T12:00:00Z`)},\n` +
      `       ${q(`${dayIn06(bookSpec)}T12:00:00Z`)}\n` +
      `  from (values\n    ${docRows.join(',\n    ')}\n` +
      `  ) as v(id, section_id, sect, fn, nfn, sha, bytes)\n` +
      `on conflict (id) do nothing;`,
    )
  }
  const UNUSED_DOC_INSERT = insert('document',
    ['id', 'job_book_id', 'section_id', 'original_filename', 'normalized_filename', 'storage_path',
     'mime_type', 'byte_size', 'sha256', 'version', 'is_superseded', 'visibility', 'uploaded_at', 'approved_at'],
    b.documents.map((d) => [d.id, d.jobBookId, d.sectionId, d.originalFilename, d.normalizedFilename,
      d.storagePath, d.mimeType, d.byteSize, d.sha256, d.version, d.isSuperseded, d.visibility,
      d.uploadedAt, d.approvedAt]))
  void UNUSED_DOC_INSERT
  sql.push(insert('weld',
    ['id', 'weld_line_id', 'job_book_id', 'weld_number', 'sort_order', 'weld_date', 'welder_stamp',
     'welder_id', 'joint_type', 'cwi_initials', 'cwi_id', 'cwi_visual_result', 'visual_inspection_date',
     'ndt_company', 'xray_number', 'ndt_ticket_number', 'ndt_method', 'ndt_result', 'status',
     'construction_area', 'isometric_number', 'pipe_size_schedule', 'pipe_grade',
     'design_pressure_psi', 'entered_at', 'entry_source', 'visual_entered_at'],
    b.welds.map((w) => [w.id, w.weldLineId, w.jobBookId, w.weldNumber, w.sortOrder, w.weldDate,
      w.welderStamp, w.welderId, w.jointType, w.cwiInitials, w.cwiId, w.cwiVisualResult,
      w.visualInspectionDate, w.ndtCompany, w.xrayNumber, w.ndtTicketNumber, w.ndtMethod,
      w.ndtResult, w.status, w.constructionArea, w.isometricNumber, w.pipeSizeSchedule,
      w.pipeGrade, w.designPressurePsi, w.enteredAt, w.entrySource, w.visualEnteredAt])))
  sql.push(insert('torque_connection',
    ['id', 'job_book_id', 'iso_flange_number', 'iso_number', 'flange_pipe_size', 'bolt_diameter',
     'bolt_count', 'required_torque_ft_lb', 'required_torque_min_ft_lb', 'required_torque_max_ft_lb',
     'actual_torque_ft_lb', 'wrench_id', 'wrench_id_raw', 'cp_test_on_flange', 'torque_date',
     'employee_initials', 'inspection_date', 'inspector_initials', 'entered_at', 'entry_source',
     'inspection_entered_at'],
    b.torqueConnections.map((c) => [c.id, c.jobBookId, c.isoFlangeNumber, c.isoNumber,
      c.flangePipeSize, c.boltDiameter, c.boltCount, c.requiredTorqueFtLb, c.requiredTorqueMinFtLb,
      c.requiredTorqueMaxFtLb, c.actualTorqueFtLb, c.wrenchId, c.wrenchIdRaw, c.cpTestOnFlange,
      c.torqueDate, c.employeeInitials, c.inspectionDate, c.inspectorInitials, c.enteredAt,
      c.entrySource, c.inspectionEnteredAt])))
  sql.push(insert('material_heat',
    ['id', 'job_book_id', 'heat_number', 'component_type', 'nominal_size', 'schedule_or_class',
     'grade', 'mtr_status', 'received_on', 'entered_at', 'entry_source'],
    b.materialHeats.map((h) => [h.id, h.jobBookId, h.heatNumber, h.componentType, h.nominalSize,
      h.scheduleOrClass, h.grade, h.mtrStatus, h.receivedOn, h.enteredAt, h.entrySource])))
  sql.push(insert('nde_report',
    ['id', 'job_book_id', 'report_number', 'report_date', 'ndt_company', 'method',
     'procedure_reference', 'revision', 'acceptance_criteria', 'technician_id', 'entered_at', 'entry_source'],
    b.ndeReports.map((r) => [r.id, r.jobBookId, r.reportNumber, r.reportDate, r.ndtCompany,
      r.method, r.procedureReference, r.revision, r.acceptanceCriteria, r.technicianId,
      r.enteredAt, r.entrySource])))
  sql.push(insert('pressure_test',
    ['id', 'job_book_id', 'test_identifier', 'line_codes', 'test_date', 'test_medium',
     'test_pressure_psi', 'duration_minutes', 'result', 'recorder_serial', 'recorder_cert_id',
     'gauge_cert_id', 'psv_cert_id', 'witnessed_by', 'start_pressure_psi', 'end_pressure_psi',
     'ambient_temp_f', 'entered_at', 'entry_source'],
    b.pressureTests.map((t) => [t.id, t.jobBookId, t.testIdentifier, t.lineCodes, t.testDate,
      t.testMedium, t.testPressurePsi, t.durationMinutes, t.result, t.recorderSerial,
      t.recorderCertId, t.gaugeCertId, t.psvCertId, t.witnessedBy, t.startPressurePsi,
      t.endPressurePsi, t.ambientTempF, t.enteredAt, t.entrySource])))

  sql.push(insert('cp_test_point',
    ['id', 'job_book_id', 'test_point_id', 'location', 'baseline_potential_v', 'reading_date',
     'technician', 'entered_at', 'entry_source'],
    b.cpTestPoints.map((c) => [c.id, c.jobBookId, c.testPointId, c.location,
      c.baselinePotentialV, c.readingDate, c.technician, c.enteredAt, c.entrySource])))
  sql.push(insert('ut_reading',
    ['id', 'job_book_id', 'location_id', 'description', 'nominal_wall', 'measured_wall',
     'reading_date', 'technician_id', 'entered_at', 'entry_source'],
    b.utReadings.map((u) => [u.id, u.jobBookId, u.locationId, u.description, u.nominalWall,
      u.measuredWall, u.readingDate, u.technicianId, u.enteredAt, u.entrySource])))
  sql.push(insert('coating_inspection',
    ['id', 'job_book_id', 'construction_area', 'inspection_date', 'inspector',
     'has_structured_data', 'document_count', 'entered_at', 'entry_source'],
    (b.coatingInspections ?? []).map((c) => [c.id, c.jobBookId, c.constructionArea,
      c.inspectionDate, c.inspector, c.hasStructuredData, c.documentCount, c.enteredAt,
      c.entrySource])))

  // -- gate reviews -----------------------------------------------------
  const spec = SPECS.find((s) => s.jobNumber === bk.jobNumber)!
  const gateRows: unknown[][] = []
  const upTo = spec.gate ? GATE_ORDER.indexOf(spec.gate) : -1
  for (let g = 0; g <= upTo; g += 1) {
    const gate = GATE_ORDER[g]!
    const ev = evaluateGate(gate, b, {
      asOf: spec.asOf, custodianCompetency: 'JB-2', custodianName: 'Dana Cortez (DEMO)',
    })
    const unresolved = ev.criteria.filter((c) => c.state !== 'met' && c.state !== 'not_applicable')
    gateRows.push([
      id('gate', `${spec.key}:${gate}`), bk.id, gate, 1, 'pass', id('user', 'manager'),
      id('user', 'custodian'), null, `${addDays(spec.start, g * 60 - 1)}T17:00:00Z`,
      // The snapshot keeps the verdict and the program's sentence; the
      // evidence arrays are dropped because they are re-derivable and are
      // most of the bytes.
      // The program's sentence and the verdict are what a chair signed
      // against and what an auditor reads. The `detail` is this
      // application's working, re-derivable on demand, and it is most of
      // the bytes.
      JSON.stringify(ev.criteria.map((c) => ({
        id: c.id, gate: c.gate, text: c.text, source: c.source, state: c.state,
      }))), ev.completionPct,
      unresolved.length > 0
        ? `Demo book. ${unresolved.length} criteri${unresolved.length === 1 ? 'on' : 'a'} unmet or ` +
          `unevaluable at the time of review; passed on the strength of the Tier 2 audit and the ` +
          `Custodian's action list.`
        : null,
      null,
    ])
  }
  if (spec.conditional) {
    const ev = evaluateGate(spec.conditional.gate, b, {
      asOf: spec.asOf, custodianCompetency: 'JB-2', custodianName: 'Dana Cortez (DEMO)',
    })
    gateRows.push([
      id('gate', `${spec.key}:${spec.conditional.gate}`), bk.id, spec.conditional.gate, 1,
      'conditional_pass', id('user', 'manager'), id('user', 'custodian'), null,
      `${addDays(spec.conditional.dueAt, -10)}T17:00:00Z`,
      // The snapshot keeps the verdict and the program's sentence; the
      // evidence arrays are dropped because they are re-derivable and are
      // most of the bytes.
      // The program's sentence and the verdict are what a chair signed
      // against and what an auditor reads. The `detail` is this
      // application's working, re-derivable on demand, and it is most of
      // the bytes.
      JSON.stringify(ev.criteria.map((c) => ({
        id: c.id, gate: c.gate, text: c.text, source: c.source, state: c.state,
      }))), ev.completionPct,
      'Demo book. Entry timeliness below target for the period and two registers still ' +
      'incomplete; ten calendar days to clear, per §7.',
      spec.conditional.dueAt,
    ])
  }
  sql.push(insert('gate_review',
    ['id', 'job_book_id', 'gate', 'attempt', 'outcome', 'chaired_by', 'custodian_id',
     'project_manager_id', 'decided_at', 'criteria_snapshot', 'completion_pct', 'override_note',
     // Not patched in afterwards: `conditional_has_due_date` refuses the
     // row without it, which is §7's ten-day rule defending itself.
     'conditional_due_at'],
    gateRows))

  // No compliance_flag rows. The application derives findings live with
  // `evaluateFlags` on every request; the table exists only to persist a
  // resolution. Seeding it would put a second, immediately-stale copy of
  // the findings beside the real ones.
}

sql.push(``, `commit;`)
writeFileSync('supabase/demo/seed-demo.sql', sql.filter(Boolean).join('\n') + '\n')

// ---------------------------------------------------------------------
// The undo
// ---------------------------------------------------------------------

const TABLES_IN_DELETE_ORDER = [
  'compliance_flag', 'gate_condition', 'gate_review', 'weld', 'torque_connection',
  'nde_report_line', 'nde_report', 'material_heat', 'pressure_test', 'cp_test_point',
  'ut_reading', 'coating_inspection', 'document', 'weld_line', 'certificate',
  'welder_qualification', 'welder', 'cwi', 'ndt_technician', 'torque_wrench',
  'timeliness_period', 'job_book_section', 'inspector_grant',
  'job_book', 'project', 'client_org', 'app_user',
]

writeFileSync('supabase/demo/delete-demo.sql',
  `-- Remove every demo row. Generated by scripts/seed-demo.ts.
--
-- Safe by construction: every demo id begins '${NS}-', which no row
-- created through the application can have — application ids come from
-- gen_random_uuid(), and the odds of it producing this prefix are 1 in
-- 4 billion per row. Nothing here can touch a real book.
--
-- Deleted child-first so no foreign key is left dangling. The audit trail
-- is NOT deleted: it is append-only by design, and the record that these
-- books existed and were removed is exactly what an append-only trail is
-- for.
begin;
-- job_assignment is keyed on (job_book_id, user_id) and carries no id of
-- its own, so it is removed by the books it points at.
delete from job_assignment where job_book_id::text like '${NS}-%' or user_id::text like '${NS}-%';
${TABLES_IN_DELETE_ORDER.map((t) => `delete from ${t} where id::text like '${NS}-%';`).join('\n')}
commit;
`)

// ---------------------------------------------------------------------
// What was built
// ---------------------------------------------------------------------

console.log('\n  job number       facility                              type      complete   gate  flags  timeliness')
console.log('  ' + '-'.repeat(104))
for (const b of bundles) {
  const spec = SPECS.find((s) => s.jobNumber === b.book.jobNumber)!
  const score = scoreBook(b)
  const counts = countBySeverity(aggregateFindings(evaluateFlags(b, { asOf: spec.asOf })))
  const t = entryTimeliness(b)
  console.log(
    `  ${b.book.jobNumber.padEnd(16)} ${(b.book.facilityName ?? '').padEnd(37)} ` +
    `${b.book.bookType.padEnd(9)} ${score.overallPct.toFixed(2).padStart(7)}%  ` +
    `${(spec.conditional ? `${spec.conditional.gate}~` : spec.gate ?? '—').padEnd(5)} ` +
    `${String(counts.critical).padStart(2)}C ${String(counts.warning).padStart(2)}W  ` +
    `${t.ratePct == null ? '—' : `${t.ratePct}%`}`,
  )
}
if (process.env.DEMO_DEBUG) {
  for (const b of bundles) {
    const spec = SPECS.find((x) => x.jobNumber === b.book.jobNumber)!
    const score = scoreBook(b)
    console.log(`\n  ${b.book.jobNumber} — losses`)
    for (const s2 of score.sections.filter((x) => x.countsTowardTotal && x.weight > 0 && x.pct < 100)) {
      console.log(`    §${s2.sectionNumber.padEnd(6)} w${String(s2.weight).padStart(5)}  ${s2.pct.toFixed(1).padStart(6)}%  lost ${(s2.weight * (100 - s2.pct) / 100).toFixed(2).padStart(6)}  ${s2.explanation.slice(0, 90)}`)
    }
    for (const f of aggregateFindings(evaluateFlags(b, { asOf: spec.asOf }))) {
      console.log(`    [${f.severity}] ${f.ruleId} — ${f.title.slice(0, 100)}`)
    }
    const t = entryTimeliness(b)
    for (const r of byStandard(t)) {
      console.log(`    ${r.standard.id.padEnd(18)} ontime ${String(r.onTime).padStart(4)} late ${String(r.late).padStart(4)} ${r.ratePct}%`)
    }
    void spec
  }
}
console.log('')
console.log(`  welds ${bundles.reduce((a, b) => a + b.welds.length, 0)}, ` +
  `torque ${bundles.reduce((a, b) => a + b.torqueConnections.length, 0)}, ` +
  `documents ${bundles.reduce((a, b) => a + b.documents.length, 0)}`)
console.log('  wrote supabase/demo/seed-demo.sql and supabase/demo/delete-demo.sql\n')
