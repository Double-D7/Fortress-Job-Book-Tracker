/**
 * What filing an NDE report would do to a book.
 *
 * The screen shows this and a person confirms it. Everything here is
 * decided before anything is written, so the preview and the commit
 * cannot disagree — the commit takes this plan, it does not re-derive it.
 *
 * ## What a row's status means
 *
 * `confirmed`   the number resolves to one weld and something else about
 *               the row agrees — the welder stamp, or the log's own NDT
 *               ticket naming the report's date.
 * `unconfirmed` the number resolves and nothing corroborates it. Real in
 *               this project's data: `CW-1` keys to weld 1 while CW is
 *               Certified Welder in AWS terminology, so that row probably
 *               names no weld at all.
 * `unchecked`   the number resolves and there was nothing to check it
 *               against — no stamp printed, no ticket in the log. Held
 *               apart from `unconfirmed` because absence of evidence and
 *               disagreement are different things.
 * `ambiguous`   several welds carry the number. Never resolved here.
 * `unmatched`   no weld in this book carries it.
 *
 * Only `confirmed` rows are written without somebody saying so, and that
 * bar was raised after measuring. Letting `unchecked` through as well
 * looked defensible and was not: on the real 11/19/25 report the film
 * sizes printed in the image-plate table — `4.5" X 17"`, `3.5" X 10"` —
 * resolve to welds 17 and 10 with nothing to contradict them, and would
 * have attached radiographs to three welds nobody examined. A row with
 * nothing corroborating it is a row for a person, whatever the reason
 * nothing could be checked.
 */
import type { NdtMethod, Weld } from './types'
import type { ParsedNdeDocument, ParsedNdeLine, ParsedNdeReport } from '@/lib/import/ndeReport'
import { corroborate, isConfirmed, matchWeldNumbers, weldNumberKey } from './ndeLinking'
import type { Corroboration } from './ndeLinking'

export type PlannedRowStatus =
  | 'confirmed' | 'unchecked' | 'unconfirmed' | 'ambiguous' | 'unmatched'

export type PlannedRow = {
  sequence: number | null
  /** The token this row was matched on, as printed. */
  printed: string
  /** The book's weld, when one was resolved. */
  weldId: string | null
  weldNumber: string | null
  status: PlannedRowStatus
  corroboration: Corroboration | null
  welderStamp: string | null
  discontinuity: string | null
  /** Welds sharing the number, when ambiguous. */
  candidateWeldIds: string[]
  raw: string
}

export type PlannedReport = {
  reportNumber: string | null
  reportDate: string | null
  ndtCompany: string | null
  technicianName: string | null
  procedureReference: string | null
  revision: string | null
  acceptanceCriteria: string | null
  method: NdtMethod | null
  rows: PlannedRow[]
}

/**
 * The examination method, read off the procedure reference.
 *
 * These vendors name the method in the procedure — `API-RT-006`,
 * `API-MT-001`, `API-PT-001` — which is more reliable than the form
 * title, because one template is reused across methods. Null when it
 * cannot be read: guessing RT because it is commonest would put a
 * volumetric claim on a surface examination.
 */
export function methodFrom(report: ParsedNdeReport): NdtMethod | null {
  const haystack = `${report.procedureReference ?? ''} ${report.reportNumber ?? ''}`
  const m = /\b(RT|MT|PT|UT)\b/i.exec(haystack)
  return m ? (m[1]!.toUpperCase() as NdtMethod) : null
}

/**
 * Choose the row's weld from the tokens printed on it.
 *
 * Two passes, and the order matters more than it looks.
 *
 * First, look for a token that resolves *and* is corroborated. Both
 * vendors print the Weld/Line/Drawing column before the IQI columns, so
 * in practice this is the weld column and the search ends immediately.
 *
 * Failing that, report on the *first* token and nothing else. An earlier
 * version fell through to later tokens, and against a book that did not
 * contain the report's welds every row came back as "B-7, several welds
 * share this number" — an IQI designation explaining a row whose actual
 * problem was that FW-1080 is not in this book. The person is owed the
 * weld column's own answer, because that is the column that names a weld.
 */
function chooseRow(
  line: ParsedNdeLine, welds: readonly Weld[], reportDate: string | null,
): PlannedRow {
  const base = {
    sequence: line.sequence,
    welderStamp: line.welderStamp,
    discontinuity: line.discontinuity,
    raw: line.raw,
  }

  const matches = matchWeldNumbers(welds, line.candidates)
  const byId = new Map(welds.map((w) => [w.id, w]))

  const evaluate = (i: number): PlannedRow | null => {
    const m = matches[i]
    const printed = line.candidates[i]
    if (!m || printed === undefined) return null

    if (m.status === 'unknown') {
      return {
        ...base, printed, weldId: null, weldNumber: null,
        status: 'unmatched', corroboration: null, candidateWeldIds: [],
      }
    }
    if (m.status === 'ambiguous') {
      return {
        ...base, printed, weldId: null, weldNumber: weldNumberKey(printed),
        status: 'ambiguous', corroboration: null, candidateWeldIds: m.weldIds,
      }
    }
    const weld = byId.get(m.weldId)!
    const c = corroborate(weld, line, reportDate)
    return {
      ...base, printed, weldId: weld.id, weldNumber: weld.weldNumber,
      status: isConfirmed(c) ? 'confirmed' : c.unchecked ? 'unchecked' : 'unconfirmed',
      corroboration: c, candidateWeldIds: [],
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const row = evaluate(i)
    if (row?.status === 'confirmed') return row
  }

  return evaluate(0) ?? {
    ...base,
    printed: '',
    weldId: null,
    weldNumber: null,
    status: 'unmatched',
    corroboration: null,
    candidateWeldIds: [],
  }
}

export function planReport(
  report: ParsedNdeReport, welds: readonly Weld[],
): PlannedReport {
  return {
    reportNumber: report.reportNumber,
    reportDate: report.reportDate,
    ndtCompany: report.ndtCompany,
    technicianName: report.technicianName,
    procedureReference: report.procedureReference,
    revision: report.revision,
    acceptanceCriteria: report.acceptanceCriteria,
    method: methodFrom(report),
    rows: report.lines.map((l) => chooseRow(l, welds, report.reportDate)),
  }
}

export type NdePlan = {
  reports: PlannedReport[]
  /** Everything the file did not give up, carried through unchanged. */
  gaps: ParsedNdeDocument['gaps']
}

export function planNdeImport(
  doc: ParsedNdeDocument, welds: readonly Weld[],
): NdePlan {
  return { reports: doc.reports.map((r) => planReport(r, welds)), gaps: doc.gaps }
}

export type PlanCounts = {
  reports: number
  rows: number
  confirmed: number
  unchecked: number
  unconfirmed: number
  ambiguous: number
  unmatched: number
  /** Rows written without anybody intervening: corroborated ones only. */
  writable: number
  criticalGaps: number
}

export function countPlan(plan: NdePlan): PlanCounts {
  const rows = plan.reports.flatMap((r) => r.rows)
  const of = (s: PlannedRowStatus) => rows.filter((r) => r.status === s).length
  const confirmed = of('confirmed')
  const unchecked = of('unchecked')
  return {
    reports: plan.reports.length,
    rows: rows.length,
    confirmed,
    unchecked,
    unconfirmed: of('unconfirmed'),
    ambiguous: of('ambiguous'),
    unmatched: of('unmatched'),
    writable: confirmed,
    criticalGaps: plan.gaps.filter((g) => g.severity === 'critical').length,
  }
}

/**
 * Welds this report evidences that the log does not mark as examined.
 *
 * Not an error. The report is often what the weld log gets updated from,
 * and weld 675 on the 11/19/25 DP-318 report is exactly this case. But a
 * report claiming a weld nobody shot is how a book over-reports coverage,
 * so the list is shown either way.
 *
 * Rows with nothing to corroborate are excluded. They are the ones most
 * likely not to be exposure rows at all — a film size resolving to a
 * weld number — and listing those as evidence gaps would bury the one
 * real finding under three invented ones.
 */
export function evidencedButNotLogged(
  plan: NdePlan, welds: readonly Weld[],
): string[] {
  const byId = new Map(welds.map((w) => [w.id, w]))
  const out: string[] = []
  for (const report of plan.reports) {
    for (const row of report.rows) {
      if (!row.weldId) continue
      if (row.corroboration === null || row.corroboration.unchecked) continue
      const w = byId.get(row.weldId)
      if (w && !w.ndtMethod && !w.ndtTicketNumber && !w.xrayNumber) {
        out.push(w.weldNumber)
      }
    }
  }
  return [...new Set(out)]
}
