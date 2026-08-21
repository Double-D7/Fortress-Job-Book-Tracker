/**
 * Record-level completeness (§5.2).
 *
 * Each function returns not just a verdict but the list of what is missing,
 * because §5.4 forbids showing a bare percentage: every score must expand
 * into the reasons behind it.
 */
import type {
  Certificate, MaterialHeat, PressureTest, TorqueConnection, Weld,
} from './types'
import { isWithin } from './dates'
import { isCountable, isXrayed } from './welders'

export interface CompletenessResult {
  complete: boolean
  missing: string[]
}

const result = (missing: string[]): CompletenessResult => ({
  complete: missing.length === 0,
  missing,
})

/**
 * A weld is complete when the joint is fully described, the CWI has signed
 * it, and — if it was selected for NDE — the examination is recorded and
 * linked to a report on file.
 */
export function weldCompleteness(w: Weld): CompletenessResult {
  if (!isCountable(w)) return { complete: true, missing: [] }
  const missing: string[] = []
  if (!w.weldDate) missing.push('weld date')

  // Two log shapes, and asking each for the other's fields invents
  // findings. A facility log records one welder stamp and carries no heat
  // number column at all, so requiring four pass assignments and a heat
  // would mark every facility weld incomplete for doing exactly what its
  // template asks.
  const isFacilityShape = !!w.welderStamp || !!w.welderId ||
    !!w.constructionArea || !!w.isometricNumber
  if (isFacilityShape) {
    if (!w.welderStamp?.trim() && !w.welderId) missing.push('welder stamp')
    if (!w.isometricNumber?.trim()) missing.push('isometric number')
    if (!w.pipeSizeSchedule?.trim()) missing.push('pipe size / schedule')
    if (!w.pipeGrade?.trim()) missing.push('pipe grade')
    if (w.designPressurePsi == null) missing.push('design pressure')
  } else {
    const passes = [w.rootWelderId, w.hotWelderId, w.fillWelderId, w.capWelderId]
    const passNames = ['root', 'hot', 'fill', 'cap']
    passes.forEach((p, i) => { if (!p) missing.push(`${passNames[i]} pass welder`) })
    if (!w.componentDescription?.trim()) missing.push('component description')
    if (!w.heatNumbers.length) missing.push('heat numbers')
  }

  if (!w.jointType) missing.push('joint type')
  if (!w.cwiInitials?.trim()) missing.push('CWI initials')
  if (!w.cwiVisualResult) missing.push('CWI visual result')

  // The NDE half of the requirement applies only to welds actually selected
  // for examination — an un-X-rayed joint is not incomplete for lacking a
  // film.
  // The NDE half applies only where an examination was actually recorded.
  // On a facility log the ticket number is the evidence, not a separate
  // report record.
  if (isXrayed(w) || w.ndtMethod) {
    if (!w.ndtMethod) missing.push('NDT method')
    if (!w.ndtResult) missing.push('NDT result')
    if (isFacilityShape) {
      if (!w.ndtTicketNumber?.trim()) missing.push('NDT ticket number')
    } else if (!w.ndtReportId) {
      missing.push('linked NDE report')
    }
  }
  return result(missing)
}

export function torqueCompleteness(c: TorqueConnection): CompletenessResult {
  const missing: string[] = []
  if (c.requiredTorqueFtLb == null) missing.push('required torque')
  if (c.actualTorqueFtLb == null) missing.push('actual torque')
  if (!c.wrenchId && !c.wrenchIdRaw) missing.push('wrench ID')
  if (!c.torqueDate) missing.push('torque date')
  if (!c.employeeInitials?.trim()) missing.push('employee initials')
  // Only connections selected for inspection need the inspection half.
  if (c.inspectionDate || c.inspectorInitials) {
    if (!c.inspectionDate) missing.push('inspection date')
    if (!c.inspectorInitials?.trim()) missing.push('inspector initials')
  }
  return result(missing)
}

export function heatCompleteness(h: MaterialHeat): CompletenessResult {
  const missing: string[] = []
  if (!h.mtrDocumentId) missing.push('MTR document')
  if (h.mtrStatus === 'illegible') missing.push('legible MTR')
  if (h.mtrStatus === 'unidentified') missing.push('identified heat number on MTR')
  return result(missing)
}

/**
 * A pressure test is complete only with all three of: the test record, the
 * chart or recorder output, and a recorder calibration certificate that was
 * valid on the test date.
 */
export function pressureTestCompleteness(
  t: PressureTest,
  certs: Certificate[],
): CompletenessResult {
  const missing: string[] = []
  if (!t.testDate) missing.push('test date')
  if (t.testPressurePsi == null) missing.push('test pressure')
  if (t.durationMinutes == null) missing.push('duration')
  if (!t.result) missing.push('result')
  if (!t.chartDocumentId) missing.push('recorder chart')

  const cert = certs.find((c) => c.id === t.recorderCertId)
  if (!cert) {
    missing.push('recorder calibration certificate')
  } else if (t.testDate && !isWithin(t.testDate, cert.issueDate, cert.expiryDate ?? null)) {
    missing.push('recorder calibration valid on the test date')
  }
  return result(missing)
}

export interface RecordCompletenessSummary {
  total: number
  complete: number
  pct: number
  /** How many records are missing each field, most common first — the
   *  decomposition a QA/QC manager acts on. */
  missingByField: { field: string; count: number }[]
}

export function summarize<T>(
  items: T[],
  fn: (item: T) => CompletenessResult,
): RecordCompletenessSummary {
  const counts = new Map<string, number>()
  let complete = 0
  for (const item of items) {
    const r = fn(item)
    if (r.complete) complete++
    for (const m of r.missing) counts.set(m, (counts.get(m) ?? 0) + 1)
  }
  return {
    total: items.length,
    complete,
    pct: items.length ? (complete / items.length) * 100 : 0,
    missingByField: [...counts.entries()]
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count),
  }
}
