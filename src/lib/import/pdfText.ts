/**
 * Text out of a PDF, with the geometry kept.
 *
 * Job book evidence arrives as PDF at least as often as it arrives as a
 * workbook — the weld log overview sheet, calibration certificates, NDE
 * reports. Reading one as a flat string loses the thing that makes it a
 * record: a weld log is a TABLE, and "TYLER WALKER TW 11/7/2026 128" is
 * only a row if you know those four runs sat on the same line.
 *
 * So every text run keeps the x and y it was drawn at, runs sharing a
 * baseline are grouped into a line, and a line's runs are ordered left to
 * right. That is enough to recover a table from a PDF that never knew it
 * was one.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a PDF renderer. It reads
 * uncompressed and Flate-compressed content streams and the standard
 * single-byte text operators, which is what Excel, Word and every
 * certificate generator these crews use actually emit. It does not do
 * CID/Type0 multi-byte encodings, and it says so rather than returning
 * confident mojibake: `extractPdfText` reports how many runs it could not
 * decode, and a caller that gets zero lines out of a page with content has
 * been told plainly that this file needs a human.
 */

import { inflateSync } from 'node:zlib'

export interface PdfRun {
  x: number
  y: number
  text: string
}

export interface PdfLine {
  y: number
  runs: PdfRun[]
  /** The line's runs joined left to right, single-spaced. */
  text: string
}

export interface PdfPage {
  index: number
  lines: PdfLine[]
}

export interface PdfExtraction {
  pages: PdfPage[]
  /** Content streams that inflated but yielded no text. */
  emptyStreams: number
  /** Streams that could not be inflated or decoded at all. */
  undecodable: number
}

/**
 * How far off a baseline a cell may sit and still belong to the same row.
 *
 * Fixed tolerances get this wrong in both directions, and both are costly.
 * Too tight and a cell drawn slightly low splits off into a row of its
 * own: on the DP-318 overview sheet one inspector's "Submitted" is drawn
 * 2.6pt below its row, and a 2pt tolerance reported a qualified CWI as
 * having submitted no documentation — an accusation, from a rounding
 * error. Too loose and adjacent rows merge, which silently attributes one
 * welder's welds to another.
 *
 * So the tolerance is derived from the document: half the ROW PITCH. A row
 * cannot be confused with its neighbour at half the distance to it, and
 * anything closer than that is a cell sitting slightly proud within its
 * own row.
 *
 * Finding the pitch took three attempts, and the two failures are worth
 * recording because both looked right.
 *
 * The MEDIAN gap is wrong: baseline gaps are bimodal — a tight cluster of
 * intra-row jitter and a wide cluster at the row pitch — and the median of
 * a bimodal population lands in the empty space between the modes, which
 * is the one value wrong in both directions. Here it gives 5.1 against a
 * true pitch of 8.3.
 *
 * The MODAL gap is also wrong, and more insidiously: the commonest gap on
 * this page is under a tenth of a point, because runs within one row are
 * emitted at very slightly different baselines. Counting occurrences makes
 * jitter the most popular spacing on the page.
 *
 * What works is weighting each spacing by the distance it accounts for.
 * Thirty-one jitter gaps span three points between them; twenty row gaps
 * span a hundred and sixty. The pitch is the spacing that most of the page
 * is actually made of.
 */
const MIN_TOLERANCE = 1.5
const MAX_TOLERANCE = 5
/** Gaps are bucketed this coarsely before the mode is taken, so a pitch
 *  that wobbles between 8.2 and 8.5 still counts as one value. */
const GAP_BUCKET = 0.5

export function baselineTolerance(ys: number[]): number {
  const distinct = [...new Set(ys.map((y) => Math.round(y * 10) / 10))].sort((a, b) => b - a)
  if (distinct.length < 3) return MIN_TOLERANCE
  const gaps = distinct.slice(1).map((y, i) => distinct[i]! - y).filter((g) => g > 0)
  if (gaps.length === 0) return MIN_TOLERANCE

  const buckets = new Map<number, number[]>()
  for (const g of gaps) {
    const key = Math.round(g / GAP_BUCKET)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(g)
    else buckets.set(key, [g])
  }
  let pitch = gaps[0]!
  let best = 0
  for (const [, values] of buckets) {
    const total = values.reduce((a, b) => a + b, 0)
    if (total <= best) continue
    best = total
    pitch = total / values.length
  }
  return Math.min(MAX_TOLERANCE, Math.max(MIN_TOLERANCE, pitch / 2))
}

/** Inflate every stream that will inflate; keep the rest as raw bytes. */
function contentStreams(buf: Buffer): { text: string; inflated: boolean }[] {
  const out: { text: string; inflated: boolean }[] = []
  let i = 0
  for (;;) {
    const s = buf.indexOf('stream', i)
    if (s < 0) break
    let p = s + 'stream'.length
    // The keyword is followed by CRLF or LF, never by the data directly.
    if (buf[p] === 0x0d) p += 1
    if (buf[p] === 0x0a) p += 1
    const e = buf.indexOf('endstream', p)
    if (e < 0) break
    const chunk = buf.subarray(p, e)
    try {
      out.push({ text: inflateSync(chunk).toString('latin1'), inflated: true })
    } catch {
      // Not Flate — either an uncompressed content stream or a font file.
      // Only the former carries text operators, and the check below tells
      // them apart without having to parse the object dictionary.
      out.push({ text: chunk.toString('latin1'), inflated: false })
    }
    i = e + 'endstream'.length
  }
  return out
}

/** `(a\(b\)c)` → `a(b)c`, with octal escapes resolved. */
function decodeString(s: string): string {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, esc: string) => {
    switch (esc) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case 'b': return '\b'
      case 'f': return '\f'
      case '(': return '('
      case ')': return ')'
      case '\\': return '\\'
      default: return String.fromCharCode(parseInt(esc, 8))
    }
  })
}

/**
 * The strings inside one TJ array, with kerning applied as spacing.
 *
 * A TJ array interleaves strings with numbers: `[(Wel)-3(der)] TJ`. The
 * numbers move the pen backwards in thousandths of an em, and a large
 * negative number is how a generator draws a space without emitting one.
 * Ignoring them entirely glues words together ("WelderName"); the
 * threshold below restores the gap without inventing spaces inside a word,
 * where the kerning is single digits.
 */
function decodeTJ(body: string): string {
  let out = ''
  for (const m of body.matchAll(/\(((?:[^()\\]|\\.)*)\)|(-?[\d.]+)/g)) {
    if (m[1] !== undefined) out += decodeString(m[1])
    else if (m[2] !== undefined && Number(m[2]) <= -100) out += ' '
  }
  return out
}

/** Does this stream look like page content rather than an embedded font? */
const isContent = (s: string) => /\bBT\b/.test(s) && /\bTJ\b|\bTj\b/.test(s)

export function extractPdfText(input: Buffer | Uint8Array): PdfExtraction {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const pages: PdfPage[] = []
  let emptyStreams = 0
  let undecodable = 0

  for (const stream of contentStreams(buf)) {
    if (!isContent(stream.text)) {
      if (stream.inflated && /\bBT\b/.test(stream.text)) undecodable += 1
      continue
    }

    const runs: PdfRun[] = []
    // Text state: the matrix set by Tm, then moved by Td/TD/T*.
    let x = 0
    let y = 0
    let lineX = 0
    let lineY = 0

    const ops =
      /(?<tm>[-\d.]+)\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\s+Tm|(?<tdx>[-\d.]+)\s+([-\d.]+)\s+(?:Td|TD)|(?<star>T\*)|\[(?<tj>(?:[^\][\\]|\\.)*)\]\s*TJ|\((?<tj1>(?:[^()\\]|\\.)*)\)\s*Tj/g

    for (const m of stream.text.matchAll(ops)) {
      const g = m.groups!
      if (g.tm !== undefined) {
        x = Number(m[2]); y = Number(m[3]); lineX = x; lineY = y
      } else if (g.tdx !== undefined) {
        lineX += Number(m[4]); lineY += Number(m[5]); x = lineX; y = lineY
      } else if (g.star !== undefined) {
        // No leading tracked; T* without Tm is rare in generated tables and
        // a nominal step keeps runs from collapsing onto one baseline.
        lineY -= 10; x = lineX; y = lineY
      } else {
        const text = g.tj !== undefined ? decodeTJ(g.tj) : decodeString(g.tj1!)
        if (text.trim()) runs.push({ x, y, text })
      }
    }

    if (runs.length === 0) { emptyStreams += 1; continue }

    // Group by baseline, top of page first, then left to right.
    const tolerance = baselineTolerance(runs.map((r) => r.y))
    const lines: PdfLine[] = []
    for (const run of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(last.y - run.y) <= tolerance) last.runs.push(run)
      else lines.push({ y: run.y, runs: [run], text: '' })
    }
    for (const line of lines) {
      line.runs.sort((a, b) => a.x - b.x)
      line.text = line.runs.map((r) => r.text.trim()).filter(Boolean).join(' ')
    }

    pages.push({ index: pages.length, lines: lines.filter((l) => l.text) })
  }

  return { pages, emptyStreams, undecodable }
}

/**
 * Runs grouped into columns by x position.
 *
 * A table whose header row is known can be read by asking, for each body
 * line, which header column each run sits under. `columnAt` answers that:
 * the nearest column start at or left of the run, which is how a
 * left-aligned cell behaves and how a centred one behaves closely enough.
 */
export function columnAt(x: number, columnStarts: number[]): number {
  let best = 0
  for (let i = 0; i < columnStarts.length; i += 1) {
    if (x + 1 >= columnStarts[i]!) best = i
  }
  return best
}
