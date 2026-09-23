/**
 * How many pages a PDF has.
 *
 * Structural, not textual. This reads the page-tree objects, which every
 * PDF carries whether or not there is a character of text inside it — so
 * it works on the scans that defeat every other kind of reading in this
 * codebase.
 *
 * It exists for one job: a mill certificate covering four pages, recorded
 * against a single heat, is probably a certificate whose other heats
 * nobody entered. That is worth showing beside the heat count. It is a
 * prompt to a person and never a decision — a four-page certificate for
 * one heat is perfectly ordinary too (chemistry, mechanicals, the mill's
 * declaration), so this must not gate anything.
 *
 * Deliberately not `extractPdfText`. That parses content streams and
 * would spend real time on a thirty-megabyte scan to answer a question
 * that is answered by counting objects.
 */

/** Never larger than a real certificate; anything past this is a parse
 *  going wrong rather than a document. */
const SANE_MAX = 5000

/**
 * The page count, or null when it cannot be determined.
 *
 * Null rather than a guess. Every caller displays this, and "we could not
 * tell" has to be distinguishable from "one page" or the prompt it feeds
 * becomes noise.
 */
export function pdfPageCount(bytes: Uint8Array): number | null {
  // Latin-1 keeps one byte to one character, so byte offsets and string
  // indices agree and no multi-byte sequence can fabricate a match.
  const text = Buffer.from(bytes).toString('latin1')

  // The authoritative answer when present: the page tree root states its
  // own count. Linearised files repeat it, and the largest is the whole
  // document rather than a fragment.
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,800}?\/Count\s+(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= SANE_MAX)
  if (counts.length > 0) return Math.max(...counts)

  // Failing that, count the page objects themselves. `/Type /Page` must
  // not also match `/Type /Pages`, hence the boundary.
  const pages = [...text.matchAll(/\/Type\s*\/Page(?![s\w])/g)].length
  if (pages > 0 && pages <= SANE_MAX) return pages

  return null
}
