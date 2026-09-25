/**
 * How much of this job's NDE the book can actually stand behind.
 *
 * Three numbers get conflated everywhere, including on the screen this
 * replaces, and a turnover turns on the difference between them.
 *
 *   required   what the job owes. DP-318 states "100% visual & 10% NDE",
 *              a flat job-wide rule read off the log rather than inferred.
 *   examined   what the weld log says was examined. This is the number
 *              every percentage in the workbook is computed from.
 *   evidenced  what a filed inspection report actually covers.
 *
 * A book passes its own arithmetic on `examined` and fails an audit on
 * `evidenced`, because an auditor asks for the report. The gap between
 * the two is the finding, and until now nothing computed it: the weld log
 * said 223 welds were examined and the library held reports that
 * evidenced none of them, and both facts were on the same screen without
 * ever being subtracted.
 *
 * ## What counts as evidenced
 *
 * A weld is evidenced when a live report line names it. Not when the weld
 * log carries a ticket number — that is the log asserting an examination,
 * which is exactly the assertion an auditor wants evidence for. And not
 * when a report exists for that date, because a report covers the welds
 * it lists and no others.
 */
import type { JobBook, NdeReport, Weld } from './types'
import { isCountable, isXrayed } from './welders'

export type NdeCoverage = {
  /** Welds that count for or against anything. `NOT USED` numbers are
   *  gaps in the sequence by design and are excluded. */
  countableWelds: number

  /** From the book's inspection rule, when it states one. */
  requiredPct: number | null
  /** The whole welds that percentage implies. Rounded up: 10% of 1,259
   *  is 125.9, and 125 examinations does not satisfy a 10% rule. */
  requiredWelds: number | null

  examined: number
  examinedPct: number

  evidenced: number
  evidencedPct: number

  /** Examined per the log, with no report line naming them. The gap. */
  unevidenced: string[]
  /** Named by a report, with the log not marking them examined. The
   *  reverse, which is usually the log lagging the report. */
  unlogged: string[]

  /** Does the log's own claim meet the rule? */
  meetsOnExamined: boolean | null
  /** Does what the book can evidence meet it? The turnover question. */
  meetsOnEvidenced: boolean | null
}

function pct(n: number, of: number): number {
  return of === 0 ? 0 : Math.round((n / of) * 1000) / 10
}

/**
 * Weld numbers in the order somebody reads a log.
 *
 * These lists are checked against the weld log by eye, and weld order in
 * the database is not weld number order — unsorted, the gap came out as
 * "15, 19, 25, 4, 20, 9" and read as noise rather than as a list. Numeric
 * where the numbers are numeric, which is how this log numbers them, with
 * decimal repairs sorting beside their parent.
 */
function inWeldOrder(numbers: string[]): string[] {
  return [...numbers].sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return a.localeCompare(b, undefined, { numeric: true })
  })
}

export function requiredNdePct(book: Pick<JobBook, 'inspectionRule'>): number | null {
  const rule = book.inspectionRule
  // A tiered rule owes different percentages to different welds and
  // cannot be reduced to one number here. Reporting null says so rather
  // than quietly reporting the flat case's answer for a job that is not
  // flat.
  return rule?.kind === 'flat' ? rule.requiredNdePct : null
}

export function ndeCoverage(
  welds: readonly Weld[],
  reports: readonly NdeReport[],
  book: Pick<JobBook, 'inspectionRule'>,
): NdeCoverage {
  const countable = welds.filter(isCountable)

  // Every weld a live report line names. Superseded reports are excluded:
  // their successor carries the current reading, and counting both would
  // evidence a weld twice on the strength of one examination.
  const evidencedIds = new Set<string>()
  for (const r of reports) {
    if (r.isSuperseded) continue
    for (const line of r.lines) if (line.weldId) evidencedIds.add(line.weldId)
  }

  const examinedWelds = countable.filter(isXrayed)
  const evidencedWelds = countable.filter((w) => evidencedIds.has(w.id))

  const requiredPct = requiredNdePct(book)
  const requiredWelds = requiredPct === null
    ? null
    : Math.ceil((countable.length * requiredPct) / 100)

  const examinedPct = pct(examinedWelds.length, countable.length)
  const evidencedPct = pct(evidencedWelds.length, countable.length)

  return {
    countableWelds: countable.length,
    requiredPct,
    requiredWelds,
    examined: examinedWelds.length,
    examinedPct,
    evidenced: evidencedWelds.length,
    evidencedPct,
    unevidenced: inWeldOrder(
      examinedWelds.filter((w) => !evidencedIds.has(w.id)).map((w) => w.weldNumber),
    ),
    unlogged: inWeldOrder(
      evidencedWelds.filter((w) => !isXrayed(w)).map((w) => w.weldNumber),
    ),
    // Compared on whole welds rather than on the rounded percentage: a
    // book owing 126 and holding 125 is short by one, and 9.9% rounding
    // to 10% would call that met.
    meetsOnExamined: requiredWelds === null ? null : examinedWelds.length >= requiredWelds,
    meetsOnEvidenced: requiredWelds === null ? null : evidencedWelds.length >= requiredWelds,
  }
}
