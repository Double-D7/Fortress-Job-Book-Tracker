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
 * Letters and digits, uppercased. A report typed as "W-0001" and a log
 * reading "W0001" are the same weld, and leading zeros are significant —
 * W-0001 and W-1 are not obviously the same and are not treated as such.
 */
export function weldNumberKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
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
