/**
 * Tying an NDE report to the welds it examined.
 *
 * The gap this closes is the one the `/nde` page has been reporting
 * honestly and uselessly: every examined weld shows as "claims an
 * examination the book cannot evidence", because reports arrive as a
 * header and a PDF with no lines, and nothing in the application could
 * ever add them. §10 of the checklist is the job logs and films — the
 * paperwork that says *this shot covers these welds*. Without lines,
 * section 10 is a folder of PDFs nobody can audit against the weld log.
 *
 * ## Proposed, never decided
 *
 * The weld log already records a ticket or x-ray number per weld. So a
 * report filed under that number can propose its own lines, and a person
 * confirms them. The same arrangement as heat numbers on a mill
 * certificate, for the same reason: a radiograph attached to the wrong
 * weld does not fail loudly. It reports the wrong pipe as examined, and
 * the weld that was actually shot keeps looking unexamined while the one
 * that was not looks clear.
 *
 * ## The case that makes this a module
 *
 * Weld numbers are not unique. `W-0001` appears five times in this
 * project's own live data — welds are numbered per line or per spool, and
 * a book holds many. Any matcher that takes the first row would silently
 * attach a film to whichever weld the query happened to return. Every
 * ambiguous match is surfaced and none is resolved, which is the whole
 * reason this is a tested function rather than a `.find()` at a call site.
 */
import type { Weld } from './types'

/**
 * The comparison key for a weld number.
 *
 * The reports and the log do not write welds the same way, and this is
 * measured rather than assumed: the DP-318 log numbers its 1,259 welds
 * `1` … `1193`, with repairs as `124.1`, while the vendor's reports print
 * the same welds as `FW-1130` — FW for Field Weld. So the prefix and any
 * trailing letter are dropped and the number is what identifies a weld.
 * Against the five real reports this resolves all 42 exposure rows to a
 * weld in the log.
 *
 * Dropping the prefix is also what makes corroboration necessary rather
 * than optional. `B-7`, an IQI designation printed on the same row, keys
 * to weld 7 exactly as `FW-7` would — and in the real data `CW-1` keys to
 * weld 1 and is almost certainly not that weld. A key alone is a
 * proposal; see `corroborate`.
 *
 * Returns "" for anything that is not a weld number at all, so a caller
 * cannot match on emptiness.
 */
export function weldNumberKey(raw: string): string {
  const m = /^\s*(?:[A-Za-z]{1,5}[-_\s]?)?0*(\d+(?:\.\d+)?)[A-Za-z]?\s*$/.exec(raw)
  return m ? m[1]! : ''
}

/** The ticket a weld was examined under, whichever column carries it. */
export function ticketOf(w: Weld): string | null {
  const t = (w.ndtTicketNumber ?? '').trim() || (w.xrayNumber ?? '').trim()
  return t === '' ? null : t
}

/** Same normalising as weld numbers: vendors punctuate tickets freely. */
export function ticketKey(raw: string): string {
  return weldNumberKey(raw)
}

export type LineMatch =
  /** Exactly one weld in the book carries this number. */
  | { status: 'matched'; weldNumber: string; weldId: string }
  /**
   * Several welds share it. Both are named so a person can choose; the
   * application must not.
   */
  | { status: 'ambiguous'; weldNumber: string; weldIds: string[] }
  /** No weld in this book carries it — the report may belong to another
   *  book, or the number was mistyped. Either is worth seeing. */
  | { status: 'unknown'; weldNumber: string }

/**
 * Resolve weld numbers, as printed on a report, against the book's log.
 *
 * Order follows the input, because that is the order they appear on the
 * report and it is how somebody checks the screen against the page.
 */
export function matchWeldNumbers(
  welds: readonly Weld[], weldNumbers: readonly string[],
): LineMatch[] {
  const byKey = new Map<string, string[]>()
  for (const w of welds) {
    const key = weldNumberKey(w.weldNumber)
    if (!key) continue
    byKey.set(key, [...(byKey.get(key) ?? []), w.id])
  }

  return weldNumbers.map((weldNumber) => {
    const ids = byKey.get(weldNumberKey(weldNumber)) ?? []
    if (ids.length === 0) return { status: 'unknown', weldNumber }
    if (ids.length > 1) return { status: 'ambiguous', weldNumber, weldIds: ids }
    return { status: 'matched', weldNumber, weldId: ids[0]! }
  })
}

/**
 * The welds the log says were examined under this ticket.
 *
 * This is the proposal: a report numbered RT-1000 suggests the welds whose
 * ticket reads RT-1000. It reads only what the weld log already records,
 * so it invents nothing — and when the log says nothing, it proposes
 * nothing rather than guessing from dates or sequence.
 */
export function weldsForTicket(
  welds: readonly Weld[], reportNumber: string,
): Weld[] {
  const key = ticketKey(reportNumber)
  if (!key) return []
  return welds.filter((w) => {
    const t = ticketOf(w)
    return t !== null && ticketKey(t) === key
  })
}

/** Split the pasted or typed weld numbers on whatever a person produces. */
export function parseWeldNumberList(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const piece of raw.split(/[\s,;]+/)) {
    const key = weldNumberKey(piece)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(piece.trim())
  }
  return out
}

export type LinkSummary = {
  matched: number
  ambiguous: number
  unknown: number
  /** True when every line resolves to exactly one weld. */
  clean: boolean
}

export function summarise(matches: readonly LineMatch[]): LinkSummary {
  const matched = matches.filter((m) => m.status === 'matched').length
  const ambiguous = matches.filter((m) => m.status === 'ambiguous').length
  const unknown = matches.filter((m) => m.status === 'unknown').length
  return { matched, ambiguous, unknown, clean: ambiguous === 0 && unknown === 0 }
}

/**
 * Welds this report would claim that the log does not say were examined.
 *
 * Worth surfacing rather than blocking. A report legitimately covers a
 * weld the log has not caught up on — the report is often what the log is
 * updated *from*. But the reverse, a report claiming a weld nobody shot,
 * is how a book comes to over-report its coverage, so somebody should see
 * the list either way.
 */
export function linesNotMarkedExamined(
  welds: readonly Weld[], matches: readonly LineMatch[],
): string[] {
  const byId = new Map(welds.map((w) => [w.id, w]))
  return matches
    .filter((m): m is Extract<LineMatch, { status: 'matched' }> => m.status === 'matched')
    .filter((m) => {
      const w = byId.get(m.weldId)
      return w ? !w.ndtMethod && !ticketOf(w) : false
    })
    .map((m) => m.weldNumber)
}


// ---------------------------------------------------------------------
// Corroboration.
//
// Keying on the number alone is not enough to attach a radiograph to a
// weld. Measured against the five real DP-318 reports, 42 of 42 rows key
// to a weld in the log — but one of them is `CW-1` keying to weld 1, and
// CW is Certified Welder in AWS terminology, so that row almost certainly
// names no weld at all. It is the welder stamp and the log's own NDT
// ticket date that tell the two cases apart: on the true matches the
// stamp agrees 35 times out of 37, and the log's ticket date agrees with
// the report date 34 times.
//
// So a match is proposed, then checked against facts the report and the
// log both carry. A match with nothing corroborating it is not refused —
// it is handed to a person as the weakest thing on the screen.
// ---------------------------------------------------------------------

export type Corroboration = {
  /** The report's welder stamp equals the log's for this weld. */
  welderStamp: boolean
  /** The log's NDT ticket for this weld names the report's own date.
   *  DP-318 records the ticket as the examination date, which is what
   *  makes this check possible at all. */
  ticketDate: boolean
  /** Neither could be checked — the report did not print a stamp and the
   *  log holds no ticket. Distinct from disagreeing. */
  unchecked: boolean
}

/** Same-day comparison that tolerates the log's `11/19/25` against an
 *  ISO report date, without parsing either into a timezone. */
export function sameDay(logTicket: string | null | undefined, reportDate: string | null): boolean {
  if (!logTicket || !reportDate) return false
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(logTicket.trim())
  if (!m) return logTicket.trim() === reportDate
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!
  const iso = `${year}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  return iso === reportDate
}

export function corroborate(
  weld: Weld,
  row: { welderStamp?: string | null },
  reportDate: string | null,
): Corroboration {
  const stampComparable = !!row.welderStamp && !!weld.welderStamp
  const ticketComparable = !!ticketOf(weld) && !!reportDate

  return {
    welderStamp: stampComparable
      && weld.welderStamp!.toUpperCase() === row.welderStamp!.toUpperCase(),
    ticketDate: ticketComparable && sameDay(ticketOf(weld), reportDate),
    unchecked: !stampComparable && !ticketComparable,
  }
}

/**
 * Is this match strong enough to offer as the row's weld?
 *
 * One agreement is enough. Requiring both would reject the eight real
 * rows where the log carries no ticket at all — which are precisely the
 * rows worth keeping, because a report evidencing an examination the log
 * never recorded is the finding section 10 exists to surface.
 */
export function isConfirmed(c: Corroboration): boolean {
  return c.welderStamp || c.ticketDate
}
