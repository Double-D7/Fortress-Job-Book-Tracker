/**
 * Filing a stack of mill certificates at once.
 *
 * Filing them one at a time works and does not scale: a facility turnover
 * arrives as a folder of eighty scans, and eighty rounds of choose-file,
 * confirm, upload is an afternoon.
 *
 * ## What bulk must not quietly cost
 *
 * The single-file screen is arranged around one rule — the heat number is
 * suggested from the filename and a person confirms it, because most of
 * these are scans with no text in them and a wrong heat number files the
 * wrong steel against a weld while the book reports the material as
 * traceable. A "file all" button that skips straight past that rule
 * converts a careful process into a bulk mistake.
 *
 * So the batch is confirmed as a list rather than not confirmed at all.
 * Every suggested heat is on screen, editable, next to the filename it
 * came from, and the two cases where a person genuinely has to intervene
 * stop their row from being filed:
 *
 *   - no heat could be read from the filename, and none was typed;
 *   - two files in the same batch claim the same heat, where picking one
 *     silently would be a guess about which scan is which.
 *
 * Everything else files. Rows that cannot are left behind with the reason
 * attached, so a partly-good batch is partly filed rather than refused
 * whole — the alternative is that one unreadable filename blocks the other
 * seventy-nine.
 *
 * ## What is deliberately not checked here
 *
 * Whether a heat already has a certificate in the library. The database
 * decides that, on a unique index, and it is the only thing that can:
 * anything this module believed about the library would be a snapshot
 * taken before the upload started, and stale the moment a colleague filed
 * something. Those rejections come back per row and are shown per row.
 */
import { heatKey, parseHeatList } from './heats'

/** Why a row cannot be filed, or `null` when it can. */
export type RowIssue = 'missing_heat' | 'duplicate_in_batch'

export type BatchRow = {
  /** As chosen, for display and for matching a result back to its row. */
  filename: string
  /**
   * The heats this certificate covers, as typed — one field holding a
   * list, because a mill certificate routinely certifies several
   * products on one sheet. Suggested from the filename, then completed
   * by the person reading the document.
   */
  heat: string
}

/**
 * The issue on each row, positionally.
 *
 * Returns one entry per input row rather than a filtered list, so a caller
 * cannot lose track of which row an issue belongs to.
 */
export function classifyBatch(rows: readonly BatchRow[]): (RowIssue | null)[] {
  // Counted per heat, not per row, because one row can now carry several.
  // A certificate covering KZ9 and KL5 clashes with another row claiming
  // KL5, and that has to surface on both.
  const seen = new Map<string, number>()
  for (const row of rows) {
    for (const key of parseHeatList(row.heat).map(heatKey)) {
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
  }

  return rows.map((row) => {
    const keys = parseHeatList(row.heat).map(heatKey)
    // Blank, or punctuation that reduces to nothing. Both mean nobody has
    // said what this certificate is for.
    if (keys.length === 0) return 'missing_heat'
    // Every row of a collision is blocked, not all but the first. The
    // whole point is that the application cannot tell which file is which.
    if (keys.some((k) => (seen.get(k) ?? 0) > 1)) return 'duplicate_in_batch'
    return null
  })
}

/** The rows that will be sent, by index into the original list. */
export function filableIndexes(rows: readonly BatchRow[]): number[] {
  const issues = classifyBatch(rows)
  return rows.map((_, i) => i).filter((i) => issues[i] === null)
}

export type BatchCounts = {
  total: number
  ready: number
  missingHeat: number
  duplicate: number
  /** Heats across every ready row. A folder of forty certificates can
   *  cover far more than forty heats, and that is the number that says
   *  what the batch actually closes. */
  heats: number
}

export function batchCounts(rows: readonly BatchRow[]): BatchCounts {
  const issues = classifyBatch(rows)
  return {
    total: rows.length,
    ready: issues.filter((i) => i === null).length,
    missingHeat: issues.filter((i) => i === 'missing_heat').length,
    duplicate: issues.filter((i) => i === 'duplicate_in_batch').length,
    heats: rows.reduce(
      (n, row, i) => n + (issues[i] === null ? parseHeatList(row.heat).length : 0),
      0,
    ),
  }
}

/** Sentences for the two blocking cases, in the terms a person can act on. */
export const ISSUE_LABELS: Record<RowIssue, string> = {
  missing_heat: 'Type the heat number from the certificate',
  duplicate_in_batch: 'Two files in this batch claim this heat',
}

/**
 * What is being left behind, or null when nothing is.
 *
 * Built here rather than assembled in the markup so the agreement is
 * testable. "1 need a heat number" is the kind of thing that survives
 * review and then reads as sloppiness on a compliance record.
 */
export function heldBackSummary(counts: BatchCounts): string | null {
  const parts: string[] = []
  if (counts.missingHeat > 0) {
    parts.push(`${counts.missingHeat} need${counts.missingHeat === 1 ? 's' : ''} a heat number`)
  }
  if (counts.duplicate > 0) {
    parts.push(`${counts.duplicate} clash within this batch`)
  }
  if (parts.length === 0) return null
  return `${parts.join(' · ')} — these stay here until you fix them.`
}

/**
 * What the file button says.
 *
 * Names the shortfall when there is one. "File 12 certificates" next to
 * fifteen chosen files invites the reading that three were filed quietly,
 * which is the opposite of what happened.
 */
export function fileButtonLabel(counts: BatchCounts): string {
  if (counts.ready === 0) return 'Nothing ready to file'
  // In "1 of 4" the noun belongs to the four, not to the one.
  const governing = counts.ready === counts.total ? counts.ready : counts.total
  const noun = governing === 1 ? 'certificate' : 'certificates'
  // When a certificate covers more than one heat, the heat count is the
  // number that says what is about to happen — "File 2 certificates"
  // under a batch closing five heats undersells it and, worse, hides
  // whether the extra heats were understood.
  const heats = counts.heats > counts.ready
    ? ` (${counts.heats} heats)`
    : ''
  return counts.ready === counts.total
    ? `File ${counts.ready} ${noun}${heats}`
    : `File ${counts.ready} of ${counts.total} ${noun}${heats}`
}
