/**
 * Torque log engine.
 *
 * The highest-value automated check in the application lives here: every
 * wrench used on a connection must hold a calibration certificate that was
 * valid *on that connection's torque date*. The reference book contains a
 * wrench whose calibration is dated seven months after the work it
 * certifies — an error no human catches by paging through a folder of PDFs.
 */
import type { JobBook, TorqueConnection, TorqueWrench } from './types'
import { isWithin } from './dates'

export interface TorqueTotals {
  totalConnections: number
  inspectedConnections: number
  inspectionPct: number
  meetsRequirement: boolean
  cpFlaggedConnections: number
}

/** A connection is inspected once an inspector has signed it: a date and
 *  initials together, never a date alone. */
export function isInspected(c: TorqueConnection): boolean {
  return !!c.inspectionDate && !!c.inspectorInitials?.trim()
}

export function torqueTotals(
  connections: TorqueConnection[],
  book: Pick<JobBook, 'requiredTorqueInspectPct'>,
): TorqueTotals {
  const total = connections.length
  const inspected = connections.filter(isInspected).length
  const pct = total ? (inspected / total) * 100 : 0
  return {
    totalConnections: total,
    inspectedConnections: inspected,
    inspectionPct: pct,
    meetsRequirement: pct >= book.requiredTorqueInspectPct,
    cpFlaggedConnections: connections.filter((c) => c.cpTestOnFlange).length,
  }
}

export type WrenchCalibrationVerdict =
  | 'valid'
  | 'no_wrench_recorded'
  | 'unknown_wrench'      // id on the row matches no managed wrench
  | 'no_certificate'      // wrench exists, no calibration cert on file
  | 'certificate_unread'  // cert is on file; this app has not read its dates
  | 'expired'             // cert lapsed before the work
  | 'not_yet_issued'      // cert dated after the work it certifies
  | 'no_torque_date'      // cannot evaluate

export interface WrenchCheck {
  connectionId: string
  wrenchIdRaw: string | null
  verdict: WrenchCalibrationVerdict
  torqueDate: string | null
  calibrationFrom: string | null
  calibrationTo: string | null
}

/**
 * Validate one connection's wrench against the managed roster.
 *
 * `not_yet_issued` is called out separately from `expired` because it is a
 * different failure: an expired certificate means someone let paperwork
 * lapse, while a certificate postdating the work means the record is wrong.
 */
export function checkWrenchCalibration(
  c: TorqueConnection,
  wrenches: TorqueWrench[],
): WrenchCheck {
  const raw = c.wrenchIdRaw ?? null
  const base = {
    connectionId: c.id, wrenchIdRaw: raw, torqueDate: c.torqueDate ?? null,
    calibrationFrom: null as string | null, calibrationTo: null as string | null,
  }
  if (!c.wrenchId && !raw) return { ...base, verdict: 'no_wrench_recorded' }

  const wrench =
    wrenches.find((w) => w.id === c.wrenchId) ??
    wrenches.find((w) => w.wrenchId === raw)
  if (!wrench) return { ...base, verdict: 'unknown_wrench' }

  const from = wrench.lastCalibrationDate ?? null
  const to = wrench.calibrationDueDate ?? null
  const withDates = { ...base, calibrationFrom: from, calibrationTo: to }

  // A missing certificate is a compliance failure. A certificate on file
  // that this application has not managed to read is not: the certificate
  // *is* the calibration record, and it is in the book. Section 13 counts
  // it, the turnover package ships it, and the only thing missing is our
  // own parse of the page — which is our problem, not the crew's.
  if (!wrench.certOnFile) return { ...withDates, verdict: 'no_certificate' }
  if (!from) return { ...withDates, verdict: 'certificate_unread' }
  if (!c.torqueDate) return { ...withDates, verdict: 'no_torque_date' }
  if (c.torqueDate < from) return { ...withDates, verdict: 'not_yet_issued' }
  if (to && c.torqueDate > to) return { ...withDates, verdict: 'expired' }
  return { ...withDates, verdict: 'valid' }
}

export function isWrenchValidOn(w: TorqueWrench, date: string): boolean {
  if (!w.certOnFile || !w.lastCalibrationDate) return false
  return isWithin(date, w.lastCalibrationDate, w.calibrationDueDate ?? null)
}

/** Actual torque within tolerance of required. */
export function torqueWithinTolerance(
  c: TorqueConnection,
  tolerancePct: number,
): boolean | null {
  if (c.actualTorqueFtLb == null) return null

  // A facility log specifies a range (130-260 ft-lb), and anything inside
  // it is in spec. Measuring a range against a percentage tolerance from
  // its own minimum flagged almost every connection in the Greeley book —
  // 710 of 718 — which is the signature of a wrong question, not of a
  // catastrophically mis-torqued facility.
  const min = c.requiredTorqueMinFtLb ?? c.requiredTorqueFtLb
  const max = c.requiredTorqueMaxFtLb ?? c.requiredTorqueFtLb
  if (min == null || max == null) return null
  if (max > min) return c.actualTorqueFtLb >= min && c.actualTorqueFtLb <= max

  // A point value keeps the percentage tolerance.
  if (min === 0) return c.actualTorqueFtLb === 0
  return (Math.abs(c.actualTorqueFtLb - min) / min) * 100 <= tolerancePct
}

export interface WrenchReconciliation {
  /** In the log's roster header block. */
  onRoster: string[]
  /** Actually recorded against at least one connection. */
  inUse: string[]
  /** Holding a calibration certificate. */
  certified: string[]
  /** Used on connections but absent from the roster header. */
  usedNotOnRoster: string[]
  /** Used on connections with no calibration certificate on file. */
  usedWithoutCertificate: string[]
  /** Certified but never used and never rostered — paperwork for equipment
   *  that did not touch this job. */
  certifiedNeverUsed: string[]
  /** On the roster but never recorded against a connection. */
  rosteredNeverUsed: string[]
  usageCounts: Record<string, number>
}

/**
 * Three-way reconciliation of roster, usage and certificates. In DP452 all
 * three sets differ: 9 rostered, 11 used, 12 certified — including one id
 * that is almost certainly a mistyped neighbour.
 */
export function reconcileWrenches(
  connections: TorqueConnection[],
  wrenches: TorqueWrench[],
): WrenchReconciliation {
  const usageCounts: Record<string, number> = {}
  for (const c of connections) {
    const id = c.wrenchIdRaw ?? wrenches.find((w) => w.id === c.wrenchId)?.wrenchId
    if (!id) continue
    usageCounts[id] = (usageCounts[id] ?? 0) + 1
  }
  const inUse = Object.keys(usageCounts).sort()
  const onRoster = wrenches.filter((w) => w.onRoster).map((w) => w.wrenchId).sort()
  const certified = wrenches.filter((w) => w.certOnFile).map((w) => w.wrenchId).sort()

  const certifiedSet = new Set(certified)
  const rosterSet = new Set(onRoster)
  const useSet = new Set(inUse)

  return {
    onRoster, inUse, certified,
    usedNotOnRoster: inUse.filter((id) => !rosterSet.has(id)),
    usedWithoutCertificate: inUse.filter((id) => !certifiedSet.has(id)),
    certifiedNeverUsed: certified.filter((id) => !useSet.has(id) && !rosterSet.has(id)),
    rosteredNeverUsed: onRoster.filter((id) => !useSet.has(id)),
    usageCounts,
  }
}

/**
 * A wrench id that differs from a rostered id by a single transposition or
 * substitution is probably a typo, not a second wrench. Surfaced as a
 * suggestion for a human to confirm — never auto-corrected, because
 * silently rewriting a compliance record is worse than the typo.
 */
export function suggestWrenchTypo(unknownId: string, knownIds: string[]): string | null {
  const candidates = knownIds.filter((k) => k.length === unknownId.length && k !== unknownId)
  for (const k of candidates) {
    let diffs = 0
    for (let i = 0; i < k.length; i++) if (k[i] !== unknownId[i]) diffs++
    if (diffs === 1) return k
  }
  for (const k of candidates) {
    const a = [...k].sort().join('')
    const b = [...unknownId].sort().join('')
    if (a === b) return k
  }
  return null
}
