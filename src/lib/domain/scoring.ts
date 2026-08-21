/**
 * Weighted hybrid completion scoring (§5).
 *
 * Two properties matter more than the arithmetic:
 *
 *   1. Every score decomposes. `SectionScore.inputs` carries the counted
 *      numerator, denominator and a plain-English explanation, because a
 *      QA/QC manager will not trust a number they cannot take apart and an
 *      auditor will demand the decomposition.
 *
 *   2. N/A sections leave both the numerator and the denominator. Marking a
 *      section N/A must never be able to raise or lower the score — only
 *      change what the score is *about*.
 */
import type {
  Certificate, DocumentRecord, JobBook, JobBookBundle, JobBookSection,
  SectionDefinition,
} from './types'
import {
  heatCompleteness, pressureTestCompleteness, summarize, torqueCompleteness,
  weldCompleteness,
} from './completeness'
import { certValidOn } from './certificates'
import { isCountable } from './welders'

export interface ScoreInput {
  label: string
  numerator: number
  denominator: number
  detail?: string
}

export interface SectionScore {
  sectionNumber: string
  title: string
  weight: number
  requirementType: SectionDefinition['requirementType']
  status: JobBookSection['status']
  /**
   * Whether this score is a verdict or a floor. A section whose contents
   * have not been read scores zero for lack of evidence, not for lack of
   * work, and the two must never render the same way.
   */
  ingestionStatus: 'imported' | 'not_imported' | 'verified_empty' | 'unknown'
  sourceFileCount?: number | null
  sourceBytes?: number | null
  /** 0–100. Zero for an N/A or supplemental section, which is why
   *  `countsTowardTotal` exists separately. */
  pct: number
  countsTowardTotal: boolean
  inputs: ScoreInput[]
  /** One line a manager can read without drilling in. */
  explanation: string
}

export interface BookScore {
  overallPct: number
  weightApplied: number
  weightAvailable: number
  /**
   * Share of the scoring weight whose contents have actually been read.
   * When this is below 100 the overall percentage is a lower bound, and
   * every surface that shows the percentage must say so.
   */
  evidenceCoveragePct: number
  /** Weight sitting in sections known to hold unread content. */
  weightNotImported: number
  /** True when the overall figure understates the book because content
   *  exists that has not been ingested. */
  isLowerBound: boolean
  sections: SectionScore[]
  /** Sections carrying weight that scored zero — the "what is missing"
   *  answer, in weight order. */
  missingSections: { sectionNumber: string; title: string; weight: number }[]
  computedAt: string
}

const pct = (n: number, d: number) => (d > 0 ? Math.min(1, n / d) * 100 : 0)
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The denominator for a section, given what has been entered and what was
 * declared at setup.
 *
 * `max` rather than the declared figure alone, for two reasons. A book that
 * turns out bigger than scoped must not score above 100%, and a scope that
 * was guessed low must not make a half-finished section look finished. The
 * declared number sets the floor; reality can only raise it.
 */
function scopedDenominator(entered: number, expected?: number | null): number {
  if (expected == null || expected <= 0) return entered
  return Math.max(expected, entered)
}

/**
 * How much of the declared scope has been entered at all, as distinct from
 * how complete those entries are. Two different questions, and a QA/QC
 * manager mid-job needs both: "we have typed 1,240 of 2,342 joints" and
 * "of those, 1,180 are complete".
 */
function entryProgressInput(
  label: string, entered: number, expected?: number | null,
): ScoreInput[] {
  if (expected == null || expected <= 0) return []
  return [{
    label: `${label} entered against a declared scope of ${expected.toLocaleString()}`,
    numerator: Math.min(entered, expected),
    denominator: expected,
    detail: entered > expected
      ? `${(entered - expected).toLocaleString()} more than scoped — the declared quantity looks low.`
      : entered < expected
        ? `${(expected - entered).toLocaleString()} still to be entered.`
        : 'Scope fully entered.',
  }]
}

/** Documents live in a section, are not soft-deleted, and are not
 *  superseded by a later revision. */
function liveDocuments(docs: DocumentRecord[], sectionId: string): DocumentRecord[] {
  return docs.filter((d) => d.sectionId === sectionId && !d.deletedAt && !d.isSuperseded)
}

function approvedDocuments(docs: DocumentRecord[], sectionId: string): DocumentRecord[] {
  return liveDocuments(docs, sectionId).filter((d) => d.approvedAt)
}

/**
 * Score one section. Split out from `scoreBook` so a section detail screen
 * can recompute a single section cheaply, and so each requirement type's
 * formula reads on its own.
 */
export function scoreSection(
  def: SectionDefinition,
  section: JobBookSection,
  bundle: JobBookBundle,
): SectionScore {
  const { book } = bundle
  const base = {
    sectionNumber: def.sectionNumber,
    title: def.title,
    weight: def.weight,
    requirementType: def.requirementType,
    status: section.status,
    ingestionStatus: section.ingestionStatus ?? 'unknown',
    sourceFileCount: section.sourceFileCount ?? null,
    sourceBytes: section.sourceBytes ?? null,
  }

  // A section known to hold files that have not been read is reported as
  // exactly that. Scoring it and calling the result "absent" would be a
  // false statement about the job, not a conservative one.
  if (section.ingestionStatus === 'not_imported') {
    const files = section.sourceFileCount
    const mb = section.sourceBytes ? section.sourceBytes / 1_048_576 : null
    return {
      ...base, pct: 0, countsTowardTotal: true, inputs: [],
      explanation:
        `Not yet imported — ` +
        (files != null
          ? `${files.toLocaleString()} file${files === 1 ? '' : 's'}`
          : 'content') +
        (mb != null ? ` (${mb.toFixed(1)} MB)` : '') +
        ` ${files === 1 ? 'is' : files != null ? 'are' : 'is'} present in the source folder but ` +
        `has not been read into the book. This section scores zero for lack of evidence, not for ` +
        `lack of work.`,
    }
  }

  // N/A and supplemental sections leave the calculation entirely.
  if (section.status === 'na') {
    return {
      ...base, pct: 0, countsTowardTotal: false, inputs: [],
      explanation: section.naReason
        ? `Marked N/A — ${section.naReason}`
        : 'Marked N/A; excluded from the score.',
    }
  }
  if (def.isSupplemental || def.requirementType === 'supplemental') {
    const docs = liveDocuments(bundle.documents, section.id)
    return {
      ...base, pct: docs.length ? 100 : 0, countsTowardTotal: false,
      inputs: [{ label: 'Documents', numerator: docs.length, denominator: docs.length || 1 }],
      explanation: `Supplemental section — ${docs.length} document(s), not scored.`,
    }
  }

  switch (def.requirementType) {
    case 'document': {
      const approved = approvedDocuments(bundle.documents, section.id)
      const present = liveDocuments(bundle.documents, section.id)
      // A declared scope beats the template's generic minimum: the template
      // says "at least one drawing", the job says "eleven".
      const required = Math.max(
        1, section.expectedCount ?? 0, section.expectedCount != null ? 0 : def.minDocuments,
      )
      const inputs: ScoreInput[] = [
        { label: 'Approved documents', numerator: approved.length, denominator: required },
      ]
      if (present.length > approved.length) {
        inputs.push({
          label: 'Uploaded, awaiting approval',
          numerator: present.length - approved.length,
          denominator: present.length,
        })
      }
      return {
        ...base, pct: pct(approved.length, required), countsTowardTotal: true, inputs,
        explanation: approved.length === 0 && present.length === 0
          ? `No documents uploaded; ${required} required.`
          : `${approved.length} of ${required} required document(s) approved` +
            (present.length > approved.length
              ? `, ${present.length - approved.length} awaiting approval.` : '.'),
      }
    }

    // Certificates score against people who actually worked this job, not
    // against the whole roster: a lapsed cert on a welder who never touched
    // this book is not this book's problem.
    case 'personnel_certs':
      return scorePersonnelCerts(base, def, section, bundle)

    case 'equipment_certs':
      return scoreEquipmentCerts(base, section, bundle)

    case 'records':
      return scoreRecords(base, def, section, bundle)

    // Derived sections roll up another section and are never scored
    // independently, or the underlying data would be counted twice.
    case 'derived': {
      const welds = bundle.welds.filter(isCountable)
      return {
        ...base, pct: 0, countsTowardTotal: false,
        inputs: [{ label: 'Rolled up from section 12', numerator: welds.length, denominator: welds.length || 1 }],
        explanation: `Derived from the detailed weld log (${welds.length} joints); carries no independent weight.`,
      }
    }

    default:
      return { ...base, pct: 0, countsTowardTotal: true, inputs: [], explanation: 'Not scored.' }
  }
}

type Base = Pick<
  SectionScore,
  'sectionNumber' | 'title' | 'weight' | 'requirementType' | 'status'
  | 'ingestionStatus' | 'sourceFileCount' | 'sourceBytes'
>

function scorePersonnelCerts(
  base: Base, def: SectionDefinition, section: JobBookSection, bundle: JobBookBundle,
): SectionScore {
  const { certificates } = bundle
  let subjects: { id: string; label: string; workDates: string[] }[] = []

  if (def.linkedRecordType === 'welder') {
    const dates = new Map<string, string[]>()
    for (const w of bundle.welds) {
      if (!isCountable(w) || !w.weldDate) continue
      for (const id of [w.rootWelderId, w.hotWelderId, w.fillWelderId, w.capWelderId]) {
        if (!id) continue
        const list = dates.get(id) ?? []
        list.push(w.weldDate)
        dates.set(id, list)
      }
    }
    subjects = [...dates.entries()].map(([id, workDates]) => ({
      id, label: bundle.welders.find((w) => w.id === id)?.initials ?? id, workDates,
    }))
  } else if (def.linkedRecordType === 'cwi') {
    const dates = new Map<string, string[]>()
    for (const w of bundle.welds) {
      if (!w.cwiId || !w.visualInspectionDate) continue
      const list = dates.get(w.cwiId) ?? []
      list.push(w.visualInspectionDate)
      dates.set(w.cwiId, list)
    }
    subjects = [...dates.entries()].map(([id, workDates]) => ({
      id, label: bundle.cwis.find((c) => c.id === id)?.initials ?? id, workDates,
    }))
  } else {
    const dates = new Map<string, string[]>()
    for (const r of bundle.ndeReports) {
      if (!r.technicianId || r.isSuperseded) continue
      const list = dates.get(r.technicianId) ?? []
      list.push(r.reportDate)
      dates.set(r.technicianId, list)
    }
    subjects = [...dates.entries()].map(([id, workDates]) => ({
      id, label: bundle.ndtTechnicians.find((t) => t.id === id)?.fullName ?? id, workDates,
    }))
  }

  const subjectType = (def.linkedRecordType ?? 'welder') as Certificate['subjectType']

  // Personnel are normally discovered from the records they appear on. When
  // those records are not loaded — a book whose weld log has yet to be
  // imported — the roster registered against the book is the honest
  // denominator, and the check degrades from "valid on every work date" to
  // "on file at all". Scoring zero instead would report a book with nine
  // filed WPQs as having none.
  const rosterFallback = subjects.length === 0
  if (rosterFallback) {
    const roster: { id: string; label: string }[] =
      def.linkedRecordType === 'cwi'
        ? bundle.cwis.map((c) => ({ id: c.id, label: c.initials }))
        : def.linkedRecordType === 'ndt_technician'
          ? bundle.ndtTechnicians.map((t) => ({ id: t.id, label: t.fullName }))
          // A combined crew stamp is not a person and holds no qualification
        // of its own; the welders behind it hold theirs.
        : bundle.welders.filter((w) => !w.combinedOf?.length)
            .map((w) => ({ id: w.id, label: w.initials }))
    subjects = roster.map((r) => ({ ...r, workDates: [] }))
  }
  // Covered means: a certificate valid on *every* date this person worked,
  // not merely a certificate on file.
  const covered = subjects.filter((s) =>
    rosterFallback
      // No work dates to check against, so the question is only whether a
      // certificate exists for this person on this book.
      ? certificates.some((c) => c.subjectType === subjectType && c.subjectId === s.id)
      : s.workDates.every((d) => certValidOn(certificates, subjectType, s.id, d) !== null),
  )
  const uncovered = subjects.filter((s) => !covered.includes(s))
  // Personnel are discovered from the records they appear on, so before the
  // logs are entered this set is empty and would score a vacuous 100%. The
  // crew size declared at setup holds the denominator up.
  const denom = scopedDenominator(subjects.length, section.expectedCount)

  return {
    ...base,
    pct: pct(covered.length, denom),
    countsTowardTotal: true,
    inputs: [
      ...entryProgressInput('Personnel', subjects.length, section.expectedCount),
      { label: 'Personnel with a certificate valid on every work date',
        numerator: covered.length, denominator: denom },
      ...(uncovered.length
        ? [{ label: 'Not covered', numerator: uncovered.length, denominator: subjects.length,
             detail: uncovered.map((s) => s.label).join(', ') }]
        : []),
    ],
    explanation: subjects.length === 0
      ? (section.expectedCount
          ? `None of the ${section.expectedCount} expected personnel have appeared on a record yet.`
          : 'No personnel of this type are registered against this job.')
      : rosterFallback
        ? `${covered.length} of ${denom} registered personnel have a certificate on file. No work ` +
          `dates are loaded, so validity on the day of work has not been checked` +
          (uncovered.length ? `; missing: ${uncovered.map((s) => s.label).join(', ')}.` : '.')
      : `${covered.length} of ${denom} performed work with a valid-on-the-day certificate` +
        (uncovered.length ? `; gaps: ${uncovered.map((s) => s.label).join(', ')}.` : '.'),
  }
}

function scoreEquipmentCerts(
  base: Base, section: JobBookSection, bundle: JobBookBundle,
): SectionScore {
  // Only wrenches actually recorded against a connection are in scope.
  const usedIds = new Set(
    bundle.torqueConnections
      .map((c) => c.wrenchIdRaw ?? bundle.torqueWrenches.find((w) => w.id === c.wrenchId)?.wrenchId)
      .filter((x): x is string => !!x),
  )
  const used = [...usedIds]
  // Section 13 asks one question: is the calibration certificate filed?
  // Whether it is valid on the day of the work is a different question,
  // answered by `checkWrenchCalibration` and raised as a critical flag —
  // conflating them scored a wrench as uncertified merely because nobody
  // had transcribed a date off the scanned certificate.
  const certified = used.filter((id) =>
    !!bundle.torqueWrenches.find((x) => x.wrenchId === id)?.certOnFile)
  const missing = used.filter((id) => !certified.includes(id))
  const undated = certified.filter((id) =>
    !bundle.torqueWrenches.find((x) => x.wrenchId === id)?.lastCalibrationDate)
  const denom = scopedDenominator(used.length, section.expectedCount)

  return {
    ...base,
    pct: pct(certified.length, denom),
    countsTowardTotal: true,
    inputs: [
      ...entryProgressInput('Equipment', used.length, section.expectedCount),
      { label: 'Wrenches used on this job with a calibration certificate',
        numerator: certified.length, denominator: denom },
      ...(missing.length
        ? [{ label: 'Used without a certificate', numerator: missing.length,
             denominator: used.length, detail: missing.join(', ') }]
        : []),
      ...(undated.length
        ? [{ label: 'Certificate on file but no calibration date recorded',
             numerator: undated.length, denominator: certified.length,
             detail: `${undated.join(', ')} — validity on the day of work cannot be checked ` +
               `until the date is entered.` }]
        : []),
    ],
    explanation: used.length === 0
      ? (section.expectedCount
          ? `None of the ${section.expectedCount} expected wrenches have appeared on a connection yet.`
          : 'No torque wrenches recorded against any connection.')
      : `${certified.length} of ${denom} wrenches used on this job hold a calibration certificate` +
        (missing.length ? `; uncertified: ${missing.join(', ')}.` : '.'),
  }
}

function scoreRecords(
  base: Base, def: SectionDefinition, section: JobBookSection, bundle: JobBookBundle,
): SectionScore {
  switch (def.linkedRecordType) {
    case 'weld': {
      // NOT USED weld numbers are sequence gaps by design and leave the
      // denominator entirely.
      const welds = bundle.welds.filter(isCountable)
      const s = summarize(welds, weldCompleteness)
      // Two sources of scope, and the larger wins. The per-line sum comes
      // off the isometrics and is exact, but only for the lines entered so
      // far — a tech who has scaffolded two of thirty lines must not
      // thereby shrink the book's denominator to those two. The section
      // figure is an estimate but covers the whole job. Taking the larger
      // can only ever be pessimistic, which is the safe direction for a
      // number an operator relies on.
      const lineExpected = bundle.weldLines.reduce((t, l) => t + (l.expectedWeldCount ?? 0), 0)
      const expected = Math.max(lineExpected, section.expectedCount ?? 0) || null
      const denom = scopedDenominator(s.total, expected)
      return {
        ...base, pct: pct(s.complete, denom), countsTowardTotal: true,
        inputs: [
          ...entryProgressInput('Joints', s.total, expected),
          { label: 'Complete weld records', numerator: s.complete, denominator: denom },
          ...s.missingByField.slice(0, 4).map((m) => ({
            label: `Missing ${m.field}`, numerator: m.count, denominator: s.total,
          })),
        ],
        explanation:
          (expected && s.total < expected
            ? `${s.total.toLocaleString()} of ${expected.toLocaleString()} expected joints entered · `
            : `${s.total.toLocaleString()} joints · `) +
          `${s.complete.toLocaleString()} complete (${round2(pct(s.complete, denom))}%)` +
          (s.missingByField[0]
            ? ` · ${s.missingByField[0].count.toLocaleString()} missing ${s.missingByField[0].field}`
            : ''),
      }
    }
    case 'torque_connection': {
      const s = summarize(bundle.torqueConnections, torqueCompleteness)
      const denom = scopedDenominator(s.total, section.expectedCount)
      return {
        ...base, pct: pct(s.complete, denom), countsTowardTotal: true,
        inputs: [
          ...entryProgressInput('Connections', s.total, section.expectedCount),
          { label: 'Complete torque connections', numerator: s.complete, denominator: denom },
          ...s.missingByField.slice(0, 4).map((m) => ({
            label: `Missing ${m.field}`, numerator: m.count, denominator: s.total,
          })),
        ],
        explanation:
          (section.expectedCount && s.total < section.expectedCount
            ? `${s.total.toLocaleString()} of ${section.expectedCount.toLocaleString()} expected connections entered · `
            : `${s.total.toLocaleString()} connections · `) +
          `${s.complete.toLocaleString()} complete (${round2(pct(s.complete, denom))}%).`,
      }
    }
    case 'material_heat': {
      // Scored against heats the welds actually reference, so an MTR folder
      // padded with unused certificates cannot inflate coverage.
      const referenced = new Set(
        bundle.welds.filter(isCountable).flatMap((w) => w.heatNumbers.map((h) => h.trim())).filter(Boolean),
      )
      const inScope = bundle.materialHeats.filter((h) => referenced.has(h.heatNumber.trim()))
      const missingRecord = [...referenced].filter(
        (h) => !bundle.materialHeats.some((x) => x.heatNumber.trim() === h),
      )
      const s = summarize(inScope, heatCompleteness)
      // Heats are discovered from the welds, so early in a job the referenced
      // set is small and would flatter the score. The declared scope holds
      // the denominator up until the weld log catches up.
      const denominator = scopedDenominator(referenced.size, section.expectedCount)
      const complete = s.complete
      return {
        ...base, pct: pct(complete, denominator), countsTowardTotal: true,
        inputs: [
          ...entryProgressInput('Heats', referenced.size, section.expectedCount),
          { label: 'Referenced heats with an MTR on file', numerator: complete, denominator },
          ...(missingRecord.length
            ? [{ label: 'Heats with no material record at all', numerator: missingRecord.length,
                 denominator, detail: missingRecord.slice(0, 10).join(', ') }]
            : []),
        ],
        explanation: referenced.size === 0
          ? (section.expectedCount
              ? `No welds reference a heat yet; scoped to ${section.expectedCount} heat numbers.`
              : 'No welds reference a heat number yet.')
          : `${referenced.size} heat numbers referenced by welds` +
            (denominator > referenced.size ? ` (scoped to ${denominator})` : '') +
            `, ${complete} with an MTR on file (${round2(pct(complete, denominator))}%).`,
      }
    }
    case 'nde_report': {
      const live = bundle.ndeReports.filter((r) => !r.isSuperseded)
      const withDoc = live.filter((r) => r.documentId)
      const xrayedWelds = bundle.welds.filter((w) => isCountable(w) && w.ndtMethod)
      const linked = xrayedWelds.filter((w) => w.ndtReportId)
      // Both halves must hold: the reports are on file, and the examined
      // welds actually point at them.
      const numerator = withDoc.length + linked.length
      const reportDenom = scopedDenominator(live.length, section.expectedCount)
      const denominator = reportDenom + xrayedWelds.length
      return {
        ...base, pct: pct(numerator, denominator), countsTowardTotal: true,
        inputs: [
          ...entryProgressInput('Reports', live.length, section.expectedCount),
          { label: 'Reports with the document on file', numerator: withDoc.length, denominator: reportDenom },
          { label: 'Examined welds linked to a report', numerator: linked.length, denominator: xrayedWelds.length },
        ],
        explanation: `${live.length} live reports (${withDoc.length} with files) · ` +
          `${linked.length} of ${xrayedWelds.length} examined welds linked to a report.`,
      }
    }
    case 'pressure_test': {
      const s = summarize(bundle.pressureTests, (t) => pressureTestCompleteness(t, bundle.certificates))
      const docs = liveDocuments(bundle.documents, section.id)
      const denom = scopedDenominator(s.total, section.expectedCount)
      if (s.total === 0 && docs.length === 0) {
        return {
          ...base, pct: 0, countsTowardTotal: true,
          inputs: [{ label: 'Pressure test records', numerator: 0, denominator: 1 }],
          explanation: 'No pressure test records and no documents — section absent.',
        }
      }
      return {
        ...base, pct: pct(s.complete, denom), countsTowardTotal: true,
        inputs: [
          ...entryProgressInput('Tests', s.total, section.expectedCount),
          { label: 'Complete pressure tests', numerator: s.complete, denominator: denom },
          ...s.missingByField.slice(0, 3).map((m) => ({
            label: `Missing ${m.field}`, numerator: m.count, denominator: s.total,
          })),
        ],
        explanation: `${s.total} of ${denom} pressure tests recorded, ${s.complete} with chart and ` +
          `valid recorder calibration.`,
      }
    }
    case 'cp_test_point': {
      const points = bundle.cpTestPoints
      const flagged = bundle.torqueConnections.filter((c) => c.cpTestOnFlange)
      const withReading = points.filter((p) => p.baselinePotentialV != null && p.readingDate)
      // Where the torque log marks flanges for CP testing, that count is the
      // denominator; otherwise fall back to the points on file.
      // The torque log's CP TEST = Y count is the best denominator when it
      // exists, because it is derived rather than declared; the setup
      // figure covers the window before the torque log is entered.
      const denominator = scopedDenominator(
        flagged.length || points.length, section.expectedCount,
      )
      if (denominator === 0) {
        return {
          ...base, pct: 0, countsTowardTotal: true,
          inputs: [{ label: 'CP test points', numerator: 0, denominator: 1 }],
          explanation: 'No cathodic protection test points recorded — section absent.',
        }
      }
      return {
        ...base, pct: pct(withReading.length, denominator), countsTowardTotal: true,
        inputs: [
          { label: 'Test points with a baseline reading', numerator: withReading.length, denominator },
          ...(flagged.length
            ? [{ label: 'Flanges marked CP TEST = Y in the torque log',
                 numerator: flagged.length, denominator: flagged.length }]
            : []),
        ],
        explanation: `${withReading.length} of ${denominator} required CP test points have a baseline reading.`,
      }
    }
    case 'coating_inspection': {
      // Scored per construction area: the job is divided into areas and
      // each needs its own coating record. Photographs with no structured
      // readings count as started, not as done.
      const areas = bundle.book.constructionAreas ?? []
      const records = bundle.coatingInspections ?? []
      const withData = records.filter((r) => r.hasStructuredData)
      const withAnything = records.filter((r) => r.documentCount > 0 || r.hasStructuredData)
      const denominator = scopedDenominator(
        areas.length || records.length, section.expectedCount,
      )
      if (denominator === 0) {
        return {
          ...base, pct: 0, countsTowardTotal: true,
          inputs: [{ label: 'Construction areas', numerator: 0, denominator: 1 }],
          explanation: 'No construction areas defined, so coating coverage cannot be measured.',
        }
      }
      return {
        ...base, pct: pct(withAnything.length, denominator), countsTowardTotal: true,
        inputs: [
          { label: 'Construction areas with a coating record',
            numerator: withAnything.length, denominator },
          { label: 'Areas with structured readings rather than photographs only',
            numerator: withData.length, denominator },
        ],
        explanation: `${withAnything.length} of ${denominator} construction areas have a coating ` +
          `record` +
          (withAnything.length > withData.length
            ? `; ${withAnything.length - withData.length} hold photographs with no structured data.`
            : '.'),
      }
    }
    case 'isometric': {
      // Sections 21 and 22 are scored against the isometrics the logs
      // actually reference — the union of both, since a drawing is needed
      // wherever work happened, not only where welds happened.
      const fromWelds = new Set(
        bundle.welds.filter(isCountable)
          .map((w) => w.isometricNumber?.trim().toUpperCase()).filter(Boolean) as string[],
      )
      const fromTorque = new Set(
        bundle.torqueConnections
          .map((c) => c.isoNumber?.trim().toUpperCase()).filter(Boolean) as string[],
      )
      const union = new Set([...fromWelds, ...fromTorque])
      const drawings = approvedDocuments(bundle.documents, section.id)
      const denominator = scopedDenominator(union.size, section.expectedCount)
      if (denominator === 0) {
        return {
          ...base, pct: 0, countsTowardTotal: true,
          inputs: [{ label: 'Isometrics referenced by the logs', numerator: 0, denominator: 1 }],
          explanation: 'No isometrics referenced by either log yet.',
        }
      }
      return {
        ...base, pct: pct(drawings.length, denominator), countsTowardTotal: true,
        inputs: [
          { label: 'Drawings on file', numerator: drawings.length, denominator },
          { label: 'Isometrics referenced by the weld log', numerator: fromWelds.size, denominator: union.size },
          { label: 'Isometrics referenced by the torque log', numerator: fromTorque.size, denominator: union.size },
        ],
        explanation: `${drawings.length} drawings against ${denominator} isometrics referenced ` +
          `across both logs (${fromWelds.size} from the weld log, ${fromTorque.size} from the ` +
          `torque log).`,
      }
    }
    case 'ut_reading': {
      const readings = bundle.utReadings.filter((r) => r.measuredWall != null && r.readingDate)
      const denominator = Math.max(1, scopedDenominator(bundle.utReadings.length, section.expectedCount))
      return {
        ...base, pct: pct(readings.length, denominator), countsTowardTotal: true,
        inputs: [
          ...entryProgressInput('UT locations', bundle.utReadings.length, section.expectedCount),
          { label: 'UT locations with a baseline reading', numerator: readings.length, denominator },
        ],
        explanation: `${readings.length} of ${bundle.utReadings.length} UT locations have a baseline reading.`,
      }
    }
    default: {
      const docs = approvedDocuments(bundle.documents, section.id)
      return {
        ...base, pct: pct(docs.length, Math.max(1, def.minDocuments)), countsTowardTotal: true,
        inputs: [{ label: 'Approved documents', numerator: docs.length, denominator: Math.max(1, def.minDocuments) }],
        explanation: `${docs.length} approved document(s).`,
      }
    }
  }
}

/**
 * Overall book score: the weighted mean across applicable, non-N/A
 * sections. Sections that do not count toward the total (N/A, derived,
 * supplemental) are absent from both sides of the division, so their
 * presence cannot move the number.
 */
export function scoreBook(bundle: JobBookBundle): BookScore {
  const defsById = new Map(bundle.sectionDefinitions.map((d) => [d.id, d]))
  const scores: SectionScore[] = []

  for (const section of bundle.sections) {
    const def = defsById.get(section.sectionDefinitionId)
    if (!def) continue
    scores.push(scoreSection(def, section, bundle))
  }
  // A section we looked at and found empty says so, rather than leaving
  // the reader to guess whether anyone checked.
  for (const sc of scores) {
    if (sc.ingestionStatus !== 'verified_empty' || sc.weight <= 0 || sc.pct > 0) continue
    sc.explanation = `Verified empty — the source folder exists and holds nothing. ${sc.explanation}`
  }
  scores.sort((a, b) => collateSectionNumber(a.sectionNumber) - collateSectionNumber(b.sectionNumber))

  const counted = scores.filter((s) => s.countsTowardTotal && s.weight > 0)
  const weightAvailable = counted.reduce((s, x) => s + x.weight, 0)
  const weightApplied = counted.reduce((s, x) => s + (x.pct / 100) * x.weight, 0)

  const notImported = counted
    .filter((s) => s.ingestionStatus === 'not_imported')
    .reduce((a, s) => a + s.weight, 0)

  return {
    overallPct: weightAvailable > 0 ? round2((weightApplied / weightAvailable) * 100) : 0,
    weightApplied: round2(weightApplied),
    weightAvailable: round2(weightAvailable),
    evidenceCoveragePct: weightAvailable > 0
      ? round2(((weightAvailable - notImported) / weightAvailable) * 100)
      : 100,
    weightNotImported: round2(notImported),
    isLowerBound: notImported > 0,
    sections: scores,
    // "Missing" means we looked and it is not there. A section nobody has
    // read yet is not missing; it is unread, and it is reported separately.
    missingSections: counted
      .filter((s) => s.pct === 0 && s.ingestionStatus !== 'not_imported')
      .map((s) => ({ sectionNumber: s.sectionNumber, title: s.title, weight: s.weight }))
      .sort((a, b) => b.weight - a.weight),
    computedAt: new Date().toISOString(),
  }
}

/** Sort `1, 2, … 10, … 19-22, S1` the way the checklist prints them. */
export function collateSectionNumber(n: string): number {
  const m = n.match(/^(\d+)/)
  if (m) return Number(m[1])
  return 1000 + n.charCodeAt(0)
}

/** The per-section weight loss, for "what would move the number most". */
export function weightLoss(score: BookScore): { sectionNumber: string; title: string; lost: number }[] {
  return score.sections
    .filter((s) => s.countsTowardTotal && s.weight > 0)
    .map((s) => ({ sectionNumber: s.sectionNumber, title: s.title, lost: round2((1 - s.pct / 100) * s.weight) }))
    .filter((s) => s.lost > 0)
    .sort((a, b) => b.lost - a.lost)
}

export function scoreBand(pct: number): 'critical' | 'warning' | 'good' {
  if (pct < 50) return 'critical'
  if (pct < 90) return 'warning'
  return 'good'
}

export type { JobBook }
