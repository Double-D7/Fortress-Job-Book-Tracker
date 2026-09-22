/**
 * Entry Timeliness — FDS-JBMP-001 §8.
 *
 * The program's first root cause is that job books were assembled at
 * closeout from memory rather than built as the work happened. §6.1 calls
 * progressive documentation "the single change that makes every other
 * control in this program work". §8 is the instrument that tells you
 * whether it is actually happening, and the whole of it comes down to one
 * comparison: the work date a record carries against the moment it was
 * entered.
 *
 * THREE THINGS THIS MODULE REFUSES TO DO.
 *
 * 1. Count an unmeasurable record as on time. A record with no entry stamp,
 *    or one loaded in bulk out of a legacy book, is reported as
 *    unmeasurable and kept out of the numerator AND the denominator. The
 *    count travels alongside the rate so nobody reads 100% over three
 *    records as 100% over three hundred.
 *
 * 2. Assume a five-day week. §8 defines a business day as "a scheduled
 *    working day for the crew performing the work", and these crews do not
 *    all work Monday to Friday. The book says which; every deadline here
 *    is computed against that.
 *
 * 3. Round a late entry away. §8.3: "A record entered late is entered
 *    accurately and flagged late; it is never back dated."
 */

import type { IsoDate, JobBookBundle } from './types'
import { addDays, today } from './dates'

// ---------------------------------------------------------------------
// The standards, from §8.1
// ---------------------------------------------------------------------

/**
 * What a standard demands.
 *
 *   same_day       — "end of same business day"
 *   business_days  — "end of next business day" (1), "3 business days", …
 *   precondition   — not a deadline at all. §8.2: "Four of the standards
 *                    above are not deadlines. They are preconditions, and
 *                    work does not start without them." Measured by the
 *                    gate criteria and the flag rules, not by a clock.
 */
export type StandardKind =
  | { kind: 'same_day' }
  | { kind: 'business_days'; days: number }
  | { kind: 'precondition' }

export interface EntryStandard {
  /** Stable id, used as the flag fingerprint and the UI key. */
  id: string
  /** The work event, in §8.1's words. */
  event: string
  standard: StandardKind
  /** §8.1's wording of the deadline, shown rather than reworded. */
  statedAs: string
  responsible: string
  sectionNumber: string
}

export const ENTRY_STANDARDS: EntryStandard[] = [
  { id: 'weld', event: 'Weld completed', standard: { kind: 'business_days', days: 1 },
    statedAs: 'End of next business day', responsible: 'Field Supervisor to Custodian', sectionNumber: '12' },
  { id: 'weld_visual', event: 'CWI visual inspection performed', standard: { kind: 'same_day' },
    statedAs: 'End of same business day', responsible: 'Certified Welding Inspector', sectionNumber: '12' },
  { id: 'torque', event: 'Torque connection made', standard: { kind: 'business_days', days: 1 },
    statedAs: 'End of next business day', responsible: 'Field Supervisor to Custodian', sectionNumber: '14' },
  { id: 'torque_inspection', event: 'Torque inspection performed', standard: { kind: 'same_day' },
    statedAs: 'End of same business day', responsible: 'Inspector', sectionNumber: '14' },
  { id: 'material', event: 'Material received on site', standard: { kind: 'precondition' },
    statedAs: 'At receipt, before release to install', responsible: 'Materials Coordinator', sectionNumber: '15' },
  { id: 'nde_report', event: 'NDE report received from vendor', standard: { kind: 'business_days', days: 3 },
    statedAs: '3 business days', responsible: 'Custodian', sectionNumber: '10' },
  { id: 'pressure_test', event: 'Pressure or hydro test performed', standard: { kind: 'business_days', days: 5 },
    statedAs: '5 business days', responsible: 'Custodian', sectionNumber: '17' },
  { id: 'cp_reading', event: 'Cathodic protection reading taken', standard: { kind: 'business_days', days: 5 },
    statedAs: '5 business days', responsible: 'Custodian', sectionNumber: '18' },
  { id: 'ut_reading', event: 'Ultrasonic baseline reading taken', standard: { kind: 'business_days', days: 5 },
    statedAs: '5 business days', responsible: 'Custodian', sectionNumber: '19' },
  { id: 'coating', event: 'Coating inspection performed', standard: { kind: 'business_days', days: 5 },
    statedAs: '5 business days', responsible: 'Coating Inspector to Custodian', sectionNumber: '23' },
]

const STANDARD_BY_ID = new Map(ENTRY_STANDARDS.map((s) => [s.id, s]))

/** §8.3 targets. */
export const TIMELINESS_TARGET_PCT = 95
export const TIMELINESS_ESCALATION_PCT = 90

// ---------------------------------------------------------------------
// Business days
// ---------------------------------------------------------------------

export type WorkWeek = 'mon_fri' | 'mon_sat' | 'all_days'

/** Day-of-week numbers a crew works, JS convention (0 = Sunday). */
const WORKING_DAYS: Record<WorkWeek, ReadonlySet<number>> = {
  mon_fri: new Set([1, 2, 3, 4, 5]),
  mon_sat: new Set([1, 2, 3, 4, 5, 6]),
  all_days: new Set([0, 1, 2, 3, 4, 5, 6]),
}

const dayOfWeek = (d: IsoDate): number => new Date(`${d}T00:00:00Z`).getUTCDay()

export function isWorkingDay(d: IsoDate, week: WorkWeek): boolean {
  return WORKING_DAYS[week].has(dayOfWeek(d))
}

/**
 * The date `n` business days after `from`.
 *
 * `n = 0` means the same business day: if the work happened on a day the
 * crew was working — which it did, or it would not have happened — the
 * deadline is that day. Where a work date falls outside the declared work
 * week anyway (a weekend callout on a Mon–Fri book), the deadline rolls to
 * the next working day rather than expiring in the past.
 */
export function addBusinessDays(from: IsoDate, n: number, week: WorkWeek): IsoDate {
  let d = from
  if (n === 0) {
    while (!isWorkingDay(d, week)) d = addDays(d, 1)
    return d
  }
  let remaining = n
  while (remaining > 0) {
    d = addDays(d, 1)
    if (isWorkingDay(d, week)) remaining -= 1
  }
  return d
}

/** Business days from `from` to `to`, counting neither endpoint twice.
 *  Negative where `to` precedes `from`. */
export function businessDaysBetween(from: IsoDate, to: IsoDate, week: WorkWeek): number {
  if (to === from) return 0
  const forward = to > from
  let d = forward ? from : to
  const end = forward ? to : from
  let n = 0
  while (d < end) {
    d = addDays(d, 1)
    if (isWorkingDay(d, week)) n += 1
  }
  return forward ? n : -n
}

// ---------------------------------------------------------------------
// One record, one verdict
// ---------------------------------------------------------------------

export type EntryVerdict =
  | 'on_time'
  | 'late'
  /** Entered before the work date it claims. Not a timeliness result —
   *  a record of work that had not happened when it was written down. */
  | 'entered_before_work'
  /** Loaded in bulk, or carrying no entry stamp. Out of the rate entirely. */
  | 'unmeasurable'
  /** Governed by §8.2 as a precondition rather than by a clock. */
  | 'precondition'

export interface EntryAssessment {
  standardId: string
  recordId: string
  recordLabel: string
  sectionNumber: string
  verdict: EntryVerdict
  workDate: IsoDate | null
  enteredOn: IsoDate | null
  dueBy: IsoDate | null
  /** Business days past the standard. Zero or absent when on time. */
  daysLate: number | null
  /** Why a record is unmeasurable, in words, so the count is explicable. */
  reason?: string
}

export interface MeasurableEvent {
  standardId: string
  recordId: string
  recordLabel: string
  workDate?: IsoDate | null
  enteredAt?: string | null
  entrySource?: 'field_entry' | 'bulk_import' | null
}

/** The date part of a timestamp, in UTC. Entry stamps are instants; the
 *  standards are expressed in days. */
const dateOf = (ts?: string | null): IsoDate | null =>
  ts ? (ts.slice(0, 10) as IsoDate) : null

export function assessEntry(e: MeasurableEvent, week: WorkWeek): EntryAssessment {
  const standard = STANDARD_BY_ID.get(e.standardId)
  const base = {
    standardId: e.standardId,
    recordId: e.recordId,
    recordLabel: e.recordLabel,
    sectionNumber: standard?.sectionNumber ?? '',
    workDate: e.workDate ?? null,
    enteredOn: dateOf(e.enteredAt),
    dueBy: null as IsoDate | null,
    daysLate: null as number | null,
  }

  if (!standard) {
    return { ...base, verdict: 'unmeasurable', reason: 'No entry standard defined for this record type.' }
  }
  if (standard.standard.kind === 'precondition') {
    return { ...base, verdict: 'precondition',
      reason: `§8.2 makes this a precondition, not a deadline: ${standard.statedAs}.` }
  }
  // Order matters below. A bulk import is unmeasurable whatever else is
  // true of it, and saying so is more useful than saying "no work date".
  if (e.entrySource === 'bulk_import') {
    return { ...base, verdict: 'unmeasurable',
      reason: 'Loaded in bulk. Its entry date records when the file was read, not when the crew filed it.' }
  }
  if (!e.enteredAt) {
    return { ...base, verdict: 'unmeasurable',
      reason: 'No entry time recorded, so this record cannot be timed against its work date.' }
  }
  if (e.entrySource == null) {
    return { ...base, verdict: 'unmeasurable',
      reason: 'The record does not say how it arrived, so it is not counted as either on time or late.' }
  }
  if (!e.workDate) {
    return { ...base, verdict: 'unmeasurable',
      reason: 'No work date on the record, so there is nothing to measure the entry against.' }
  }

  const enteredOn = dateOf(e.enteredAt) as IsoDate
  if (enteredOn < e.workDate) {
    return { ...base, enteredOn, verdict: 'entered_before_work',
      reason: `Entered ${enteredOn}, dated ${e.workDate}. The record predates the work it reports.` }
  }

  const dueBy = standard.standard.kind === 'same_day'
    ? addBusinessDays(e.workDate, 0, week)
    : addBusinessDays(e.workDate, standard.standard.days, week)

  if (enteredOn <= dueBy) {
    return { ...base, enteredOn, dueBy, verdict: 'on_time', daysLate: 0 }
  }
  return {
    ...base, enteredOn, dueBy, verdict: 'late',
    daysLate: businessDaysBetween(dueBy, enteredOn, week),
  }
}

// ---------------------------------------------------------------------
// One book, one rate
// ---------------------------------------------------------------------

/** Every §8.1 event the bundle can speak to, flattened. */
export function measurableEvents(b: JobBookBundle): MeasurableEvent[] {
  const out: MeasurableEvent[] = []

  for (const w of b.welds) {
    out.push({ standardId: 'weld', recordId: w.id, recordLabel: `Weld ${w.weldNumber}`,
      workDate: w.weldDate, enteredAt: w.enteredAt, entrySource: w.entrySource })
    if (w.visualInspectionDate) {
      out.push({ standardId: 'weld_visual', recordId: w.id,
        recordLabel: `Weld ${w.weldNumber} visual`,
        workDate: w.visualInspectionDate, enteredAt: w.visualEnteredAt ?? w.enteredAt,
        entrySource: w.entrySource })
    }
  }
  for (const c of b.torqueConnections) {
    out.push({ standardId: 'torque', recordId: c.id, recordLabel: `Torque ${c.isoFlangeNumber}`,
      workDate: c.torqueDate, enteredAt: c.enteredAt, entrySource: c.entrySource })
    if (c.inspectionDate) {
      out.push({ standardId: 'torque_inspection', recordId: c.id,
        recordLabel: `Torque ${c.isoFlangeNumber} inspection`,
        workDate: c.inspectionDate, enteredAt: c.inspectionEnteredAt ?? c.enteredAt,
        entrySource: c.entrySource })
    }
  }
  for (const r of b.ndeReports) {
    out.push({ standardId: 'nde_report', recordId: r.id,
      recordLabel: `NDE report ${r.reportNumber ?? r.id.slice(0, 8)}`,
      workDate: r.reportDate, enteredAt: r.enteredAt, entrySource: r.entrySource })
  }
  for (const t of b.pressureTests) {
    out.push({ standardId: 'pressure_test', recordId: t.id,
      recordLabel: `Pressure test ${t.testIdentifier}`,
      workDate: t.testDate, enteredAt: t.enteredAt, entrySource: t.entrySource })
  }
  for (const p of b.cpTestPoints) {
    out.push({ standardId: 'cp_reading', recordId: p.id,
      recordLabel: `CP point ${p.testPointId ?? p.id.slice(0, 8)}`,
      workDate: p.readingDate, enteredAt: p.enteredAt, entrySource: p.entrySource })
  }
  for (const u of b.utReadings) {
    out.push({ standardId: 'ut_reading', recordId: u.id,
      recordLabel: `UT reading ${u.locationId ?? u.id.slice(0, 8)}`,
      workDate: u.readingDate, enteredAt: u.enteredAt, entrySource: u.entrySource })
  }
  for (const h of b.materialHeats) {
    out.push({ standardId: 'material', recordId: h.id, recordLabel: `Heat ${h.heatNumber}`,
      workDate: h.receivedOn, enteredAt: h.enteredAt, entrySource: h.entrySource })
  }
  for (const c of b.coatingInspections ?? []) {
    out.push({ standardId: 'coating', recordId: c.id,
      recordLabel: `Coating ${c.constructionArea}`,
      workDate: c.inspectionDate, enteredAt: c.enteredAt, entrySource: c.entrySource })
  }
  return out
}

export interface TimelinessResult {
  /** Null when nothing was measurable. Zero would read as total failure;
   *  null reads as "there is nothing here to judge", which is the truth. */
  ratePct: number | null
  withinStandard: number
  /** The denominator: measurable entries only. */
  totalMeasured: number
  unmeasurable: number
  /** §8.2 preconditions, reported separately because they are not timed. */
  preconditions: number
  enteredBeforeWork: number
  meetsTarget: boolean
  needsEscalation: boolean
  late: EntryAssessment[]
  /** Every assessment, for drill-down and per-standard breakdowns. */
  all: EntryAssessment[]
}

export interface TimelinessWindow {
  /** Inclusive. Omit both for the whole book. */
  from?: IsoDate
  to?: IsoDate
}

export function entryTimeliness(
  b: JobBookBundle,
  window: TimelinessWindow = {},
): TimelinessResult {
  const week = (b.book.workWeek ?? 'mon_fri') as WorkWeek
  const all = measurableEvents(b)
    .map((e) => assessEntry(e, week))
    // §8.3 measures "records entered" in the period, so the window is on
    // the entry date, not the work date. A weld welded in March and filed
    // in May is May's problem, which is exactly the behaviour that makes a
    // backlog visible the week it is cleared.
    .filter((a) => {
      if (!window.from && !window.to) return true
      if (!a.enteredOn) return false
      if (window.from && a.enteredOn < window.from) return false
      if (window.to && a.enteredOn > window.to) return false
      return true
    })

  const timed = all.filter((a) => a.verdict === 'on_time' || a.verdict === 'late')
  const withinStandard = timed.filter((a) => a.verdict === 'on_time').length
  const totalMeasured = timed.length
  const ratePct = totalMeasured === 0
    ? null
    : Math.round((withinStandard / totalMeasured) * 10_000) / 100

  return {
    ratePct,
    withinStandard,
    totalMeasured,
    unmeasurable: all.filter((a) => a.verdict === 'unmeasurable').length,
    preconditions: all.filter((a) => a.verdict === 'precondition').length,
    enteredBeforeWork: all.filter((a) => a.verdict === 'entered_before_work').length,
    meetsTarget: ratePct != null && ratePct >= TIMELINESS_TARGET_PCT,
    // A book with nothing measured is not escalated. There is no evidence
    // of a problem, and inventing one out of an absence is how a metric
    // loses its audience.
    needsEscalation: ratePct != null && ratePct < TIMELINESS_ESCALATION_PCT,
    late: all.filter((a) => a.verdict === 'late')
      .sort((x, y) => (y.daysLate ?? 0) - (x.daysLate ?? 0)),
    all,
  }
}

// ---------------------------------------------------------------------
// Weeks — §8.3
// ---------------------------------------------------------------------

/** The Monday on or before `d`. §8.3 reports weekly; weeks need an edge. */
export function weekStart(d: IsoDate): IsoDate {
  const dow = dayOfWeek(d)
  return addDays(d, dow === 0 ? -6 : 1 - dow)
}

export interface TimelinessPeriod {
  periodStart: IsoDate
  periodEnd: IsoDate
  ratePct: number | null
  withinStandard: number
  totalMeasured: number
  unmeasurable: number
}

/** Weekly rates, oldest first, for every week in which anything was
 *  entered. Weeks with no entries are omitted rather than reported as 0%. */
export function weeklyTimeliness(b: JobBookBundle): TimelinessPeriod[] {
  const week = (b.book.workWeek ?? 'mon_fri') as WorkWeek
  const buckets = new Map<IsoDate, EntryAssessment[]>()

  for (const a of measurableEvents(b).map((e) => assessEntry(e, week))) {
    if (!a.enteredOn) continue
    const start = weekStart(a.enteredOn)
    const bucket = buckets.get(start)
    if (bucket) bucket.push(a)
    else buckets.set(start, [a])
  }

  return [...buckets.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([periodStart, items]) => {
      const timed = items.filter((a) => a.verdict === 'on_time' || a.verdict === 'late')
      const withinStandard = timed.filter((a) => a.verdict === 'on_time').length
      return {
        periodStart,
        periodEnd: addDays(periodStart, 6),
        withinStandard,
        totalMeasured: timed.length,
        unmeasurable: items.filter((a) => a.verdict === 'unmeasurable').length,
        ratePct: timed.length === 0
          ? null
          : Math.round((withinStandard / timed.length) * 10_000) / 100,
      }
    })
}

/**
 * §8.3: "A book below 90% for two consecutive weeks is escalated to the
 * Project Manager and the VP of Operations."
 *
 * Consecutive means consecutive in the weeks that were measured. A week
 * where nothing was entered breaks nothing and proves nothing — treating
 * it as a pass would let a book dodge escalation by filing nothing at all,
 * which is the opposite of what §8 is for.
 */
export function escalationWeeks(periods: TimelinessPeriod[]): TimelinessPeriod[] {
  const measured = periods.filter((p) => p.ratePct != null)
  const out: TimelinessPeriod[] = []
  for (let i = 1; i < measured.length; i += 1) {
    const prev = measured[i - 1]!
    const curr = measured[i]!
    if (prev.ratePct! < TIMELINESS_ESCALATION_PCT && curr.ratePct! < TIMELINESS_ESCALATION_PCT) {
      out.push(curr)
    }
  }
  return out
}

/** Per-standard breakdown, for the screen that answers "which crew?". */
export function byStandard(result: TimelinessResult): {
  standard: EntryStandard
  onTime: number
  late: number
  unmeasurable: number
  ratePct: number | null
}[] {
  return ENTRY_STANDARDS.map((standard) => {
    const items = result.all.filter((a) => a.standardId === standard.id)
    const onTime = items.filter((a) => a.verdict === 'on_time').length
    const late = items.filter((a) => a.verdict === 'late').length
    const timed = onTime + late
    return {
      standard,
      onTime,
      late,
      unmeasurable: items.filter((a) => a.verdict === 'unmeasurable').length,
      ratePct: timed === 0 ? null : Math.round((onTime / timed) * 10_000) / 100,
    }
  }).filter((r) => r.onTime + r.late + r.unmeasurable > 0)
}

export { today }
