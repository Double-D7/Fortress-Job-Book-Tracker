/**
 * Reading a radiographic inspection report.
 *
 * These are the section 10 job logs: the sheet an NDT vendor issues
 * saying which welds were shot, on what film, to what procedure, and what
 * was found. Until now the application could hold the PDF and nothing
 * else, so a book could show a folder of reports and still not evidence a
 * single weld.
 *
 * ## Two vendors, one shape
 *
 * The five real DP-318 reports come from two inspection companies and
 * differ in layout, but both print a numbered row per exposure carrying a
 * field weld number:
 *
 *   American Piping   `12 | FW-1130 0,1,2 | 3.5 0.300 | D | … | #S | LC`
 *   the other         `1 | (FW-850)DSFB-850 | 0,1,2 | 6.625 | … | JP`
 *
 * So the parser does not attempt to read columns. Column positions differ
 * between vendors, between revisions of one vendor's template, and
 * between the pages of a single report where a table continues. What is
 * stable is the field weld number — `FW` for Field Weld, matching the
 * weld log exactly — and that is what a line is identified by.
 *
 * Everything else on the row is offered as context for the person
 * confirming, never as fact the book relies on. The weld number is the
 * only thing this extracts that anything downstream acts upon.
 *
 * ## Why it reads loosely and reports precisely
 *
 * A stricter parser that demanded a known column layout would fail
 * completely on the next vendor, and failing completely is how section 10
 * ends up typed by hand again. A looser one that guessed at values would
 * put numbers into a compliance record that nobody wrote. Reading only
 * what is unambiguous, and saying how many rows it could not read, keeps
 * both from happening.
 */
import type { PdfExtraction } from './pdfText'

/**
 * A weld-number-shaped token: a short letter prefix and a number.
 *
 * Deliberately not `FW` only. The first version of this matched field
 * welds alone and met a real report reading `(CW-1) DRTI-001P` — it
 * found nothing and returned a report covering no welds, with no rows
 * flagged unread. A report that covers a weld arriving as covering
 * nothing is the worst shape this can fail in, because it looks like a
 * success.
 *
 * What a prefix means is not decided here, and guessing would be worse
 * than useless: `CW` is Certified Welder in AWS terminology, so a row
 * carrying it may name no weld at all. Every token on the row is offered
 * and the weld log settles it.
 *
 * So the prefix is not assumed. Candidates are extracted by shape and the
 * weld log decides which are real — the log is the only authority on what
 * weld numbers this job has, and it already holds them. That also means
 * `B7` and `A5`, the IQI designations sitting in the same row, are
 * harmless: they match nothing and fall out.
 */
const WELD_TOKEN = /\b([A-Z]{1,5})-?\s?(\d+[A-Za-z]?)\b/g

/**
 * The weld-number candidates on one line of a report.
 *
 * `(FW-850)DSFB-850` yields `FW-850` once: the parenthesised field weld
 * and the line identifier that follows it are the same weld written
 * twice, and returning it twice would double every count on that vendor's
 * reports.
 */
export function weldTokensOnLine(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(WELD_TOKEN)) {
    const normalized = `${m[1]!.toUpperCase()}-${m[2]!.toUpperCase()}`
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

export type ParsedNdeLine = {
  /** The row number the vendor printed, which is the exposure's identity
   *  on the sheet and survives a table split across pages. */
  sequence: number | null
  /**
   * Weld-number-shaped tokens on this row, in the order printed.
   *
   * Candidates, not welds. A row also carries IQI designations (`B7`,
   * `A5`), a source type (`IR-192`) and sometimes an address, all of
   * which have the same shape. The weld log decides which of these names
   * a weld, and the first one that matches is the weld — the
   * Weld/Line/Drawing column is printed before the IQI columns on both
   * vendors' sheets.
   *
   * Returning the row's candidates rather than a guess is what keeps a
   * misread out of the record: nothing here can invent a weld the log
   * does not already have.
   */
  candidates: string[]
  /** The row as printed, kept whole so a person confirming can compare
   *  against the page rather than against this parser's reading of it. */
  raw: string
  /** Free text from the discontinuity column when one is recognisable.
   *  Never interpreted — "Porosity/ESI (0-1)" is a finding a person
   *  reads, not a pass/fail this decides. */
  discontinuity: string | null
  /** The welder stamp printed on the row, when the row ends with one. */
  welderStamp: string | null
}

export type ParsedNdeReport = {
  reportNumber: string | null
  reportDate: string | null
  ndtCompany: string | null
  technicianName: string | null
  procedureReference: string | null
  revision: string | null
  acceptanceCriteria: string | null
  jobLocation: string | null
  lines: ParsedNdeLine[]
  /** Lines that looked like table rows but named no weld. Reported so a
   *  report whose table did not parse is visible as such rather than
   *  arriving as a report covering nothing. */
  unreadRows: number
}

/**
 * The labels that end a value.
 *
 * These sheets print several fields on one line — "PROCEDURE # API-MT-001
 * REVISION # 24 REV. DATE: 1/7/2024" is one line — and the extractor
 * joins runs with spaces, so a value taken as "everything after the
 * label" swallows the next three fields. The first version did exactly
 * that and reported a procedure reference of "API-RT-006- CR ASME
 * REVISION # 3 REV. DATE: 2/28/2025".
 */
const NEXT_LABEL =
  /\b(REVISION|REV\.?\s*DATE|REPORT\s*(?:NUMBER|#)|DESCRIPTION|JOB\s*(?:LOCATION|NUMBER)|ACCEPTANCE\s*CRITERIA|APPLICABLE\s*CODE|PROCEDURE|Customer\s*(?:Printed|Signature)|Technician\s*(?:Name|Signature)|DATE)\b\s*:?/i

/** The value printed after a label, stopping where the next label starts. */
function fieldAfter(lines: string[], label: RegExp): string | null {
  for (const line of lines) {
    const m = label.exec(line)
    if (!m) continue
    let after = line.slice(m.index + m[0].length)
    const next = NEXT_LABEL.exec(after)
    if (next) after = after.slice(0, next.index)
    const value = after.split('|').map((s) => s.trim()).filter(Boolean)[0]
    if (value) return value
  }
  return null
}

/**
 * The report's own date, not a calibration or procedure revision date.
 *
 * Three of the five real reports came back with the wrong date because
 * "REV. DATE:" and "Cal Date:" match a bare /DATE/ first — and one of
 * them was dated two years out. A wrong date on an inspection record is
 * not a cosmetic defect: it is what a reviewer uses to decide whether the
 * examination preceded the pressure test.
 */
function reportDateFrom(lines: string[]): string | null {
  for (const line of lines) {
    // A date label not preceded by a qualifier on the same phrase.
    const m = /(?<!REV\.\s?)(?<!REV\s)(?<!Cal\s)(?<!CAL\s)\bDATE\b\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(line)
    if (m && !/REV\.?\s*DATE|Cal\s*Date|Calibration/i.test(line.slice(0, m.index + 5))) {
      return isoDate(m[1]!)
    }
  }
  return null
}

/** A US-format date as printed, normalised to ISO when it is unambiguous. */
export function isoDate(raw: string | null): string | null {
  if (!raw) return null
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(raw)
  if (!m) return null
  const [, mm, dd, yy] = m
  const year = yy!.length === 2 ? 2000 + Number(yy) : Number(yy)
  const month = Number(mm)
  const day = Number(dd)
  // A day past 12 in the first position would be a European date, and
  // guessing between the two is how a report lands in the wrong month.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * A trailing welder stamp: two or three letters, sometimes with a digit.
 *
 * Read off the end of the row, where both vendors print it. Offered as
 * context for the person confirming and never acted on — a row ending in
 * an IQI designation would be read the same way, and that costs nothing
 * because nothing downstream treats this as fact.
 */
const WELDER_STAMP = /(?:^|[\s|])([A-Z]{2,3}\d?)\s*$/

/** Discontinuity wording these vendors print. Recognised, never judged. */
const DISCONTINUITY =
  /\b(porosity|crack|lof|lack of fusion|incomplete penetration|ip\b|esi|isi|undercut|burn-?through|slag|linear|excessive penetration|concave root)\b[^|]*/i

/** One report's worth of lines, already segmented. */
export function parseNdeReport(input: PdfExtraction | string[]): ParsedNdeReport {
  const lines = Array.isArray(input)
    ? input
    : input.pages.flatMap((p) => p.lines.map((l) => l.text))

  const lineItems: ParsedNdeLine[] = []
  let unreadRows = 0

  for (const raw of lines) {
    const welds = weldTokensOnLine(raw)
    if (welds.length === 0) {
      // A numbered row carrying real content but no weld-shaped token.
      // Counted so a report whose table did not parse is visible as such,
      // rather than arriving as a report that covers nothing.
      if (/^\s*\d{1,3}\s+\S/.test(raw) && raw.trim().length > 25) unreadRows += 1
      continue
    }

    const seqMatch = /^\s*(\d{1,3})\b/.exec(raw)
    // Rows without a printed sequence number are letterhead and footers
    // that happen to contain a code shaped like a weld number — an
    // address, a film size, a source serial. The table rows are numbered.
    if (!seqMatch) continue

    const disc = DISCONTINUITY.exec(raw)
    const stamp = WELDER_STAMP.exec(raw)

    // One row per exposure. A weld legitimately appears on two rows of
    // one report — a reshoot after repair — and both are kept, because it
    // is the same weld examined twice and a person needs to see both.
    lineItems.push({
      sequence: Number(seqMatch[1]),
      candidates: welds,
      raw: raw.trim(),
      discontinuity: disc ? disc[0].trim() : null,
      welderStamp: stamp ? stamp[1]! : null,
    })
  }

  // Rows come out of the extractor in drawing order, which for a page
  // drawn with a flipped transform is bottom to top. The vendor's own row
  // number is the reliable ordering and is what the sheet is read by.
  lineItems.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))

  return {
    reportNumber: fieldAfter(lines, /REPORT\s*(?:NUMBER|#)\s*:?/i),
    reportDate: reportDateFrom(lines),
    ndtCompany: companyFrom(lines),
    technicianName: fieldAfter(lines, /Technician\s*Name\s*\(?Printed\)?\s*:?/i),
    procedureReference: fieldAfter(lines, /PROCEDURE\s*#?\s*:?/i),
    revision: fieldAfter(lines, /REVISION\s*#?\s*:?/i),
    acceptanceCriteria: fieldAfter(lines, /ACCEPTANCE\s*CRITERIA\s*:?/i),
    jobLocation: fieldAfter(lines, /JOB\s*LOCATION\s*:?/i),
    lines: lineItems,
    unreadRows,
  }
}

/**
 * The inspection company, taken from its letterhead.
 *
 * Vendors print their name and address on every page rather than against
 * a label, so this looks for the incorporation suffix that distinguishes
 * a company name from the rest of the sheet.
 */
function companyFrom(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^([A-Z][A-Za-z&.,' -]{4,60}?(?:Inc|LLC|Ltd|Co|Corp|Company)\.?)\b/.exec(line.trim())
    if (m) return m[1]!.trim()
  }
  return null
}


// ---------------------------------------------------------------------
// The document: several reports, and everything that could not be read.
//
// A job book is incomplete if data is missing, so nothing may be dropped
// quietly. A page that yields nothing, a table row with no weld on it, a
// report with no date — each is a fact about what this file did not give
// up, and each is reported rather than absorbed. The parser's job is to
// be honest about its own blind spots, because the alternative is a
// turnover that looks complete and is not.
// ---------------------------------------------------------------------

export type NdeGapKind =
  /** The page produced text but nothing this could interpret. */
  | 'page_not_understood'
  /** The page produced no text at all — a scan, or a decode failure. */
  | 'page_empty'
  /** A numbered table row carrying content but no weld-shaped token. */
  | 'row_not_read'
  /** The report states more pages than the file gave up. */
  | 'pages_missing'
  /** A header field a report is not complete without. */
  | 'missing_field'
  /** The file parsed but no report was found in it at all. */
  | 'no_reports'

export type NdeGap = {
  kind: NdeGapKind
  /**
   * `critical` means data that demonstrably exists was not captured —
   * a page nobody could read, a row that named no weld. `warning` means
   * something expected is absent and may legitimately be.
   */
  severity: 'critical' | 'warning'
  detail: string
  /** 1-based, as a person counts pages in a viewer. */
  page?: number
}

export type ParsedNdeDocument = {
  reports: ParsedNdeReport[]
  gaps: NdeGap[]
  /** Nothing in the file went unexplained. */
  complete: boolean
}

/** `Page 1 of 2`, which these vendors print on every sheet. */
export function pageMarker(text: string): { page: number; of: number } | null {
  const m = /\bPage\s+(\d{1,3})\s+of\s+(\d{1,3})\b/i.exec(text)
  if (!m) return null
  const page = Number(m[1])
  const of = Number(m[2])
  return of >= page && of > 0 && of < 500 ? { page, of } : null
}

/**
 * What identifies the report a page belongs to.
 *
 * Presence of a report number is not the marker: continuation sheets
 * reprint it, and splitting on presence cut one 25-exposure report into
 * two. What separates reports is a *different* number, or a different
 * procedure where a technician has sent a magnetic particle sheet and a
 * radiographic one in the same file.
 */
function pageIdentity(lines: string[]): { number: string | null; procedure: string | null } {
  return {
    number: fieldAfter(lines, /REPORT\s*(?:NUMBER|#)\s*:?/i),
    procedure: fieldAfter(lines, /PROCEDURE\s*#?\s*:?/i),
  }
}

/** Two pages belong to different reports when a key they both state disagrees. */
function conflicts(
  a: { number: string | null; procedure: string | null },
  b: { number: string | null; procedure: string | null },
): boolean {
  if (a.number && b.number && a.number !== b.number) return true
  if (a.procedure && b.procedure && a.procedure !== b.procedure) return true
  return false
}

/** Did this page give up anything at all that could be used? */
function pageYieldedSomething(lines: string[]): boolean {
  if (lines.some((l) => /^\s*\d{1,3}\s+\S/.test(l) && weldTokensOnLine(l).length > 0)) return true
  return lines.some((l) =>
    /REPORT\s*(?:NUMBER|#)|PROCEDURE|ACCEPTANCE\s*CRITERIA|Technician|JOB\s*LOCATION|REVISION/i.test(l))
}

/**
 * Split a PDF into the reports it holds and the gaps it leaves.
 *
 * Several reports in one file is normal — a technician sends a day's
 * work as one PDF — so a page announcing its own report number starts a
 * new one and every other page continues the last.
 */
export function parseNdeDocument(extraction: PdfExtraction): ParsedNdeDocument {
  const gaps: NdeGap[] = []
  const open: { id: { number: string | null; procedure: string | null }; lines: string[] }[] = []

  extraction.pages.forEach((page, i) => {
    const lines = page.lines.map((l) => l.text)
    const pageNo = i + 1

    if (lines.length === 0) {
      gaps.push({
        kind: 'page_empty', severity: 'critical', page: pageNo,
        detail: `Page ${pageNo} produced no text. If it carries exposures, they are not captured.`,
      })
      return
    }

    if (!pageYieldedSomething(lines)) {
      // Deliberately not called noise. All that is known is that nothing
      // usable came out, and a person has to look at the page itself.
      gaps.push({
        kind: 'page_not_understood', severity: 'critical', page: pageNo,
        detail: `Page ${pageNo} produced text but no report details or exposure rows could be read from it.`,
      })
      return
    }

    const id = pageIdentity(lines)
    const current = open.length > 0 ? open[open.length - 1]! : null

    if (current === null || conflicts(current.id, id)) {
      open.push({ id, lines: [...lines] })
    } else {
      // A continuation sheet often states less than the first; take
      // whatever it does state so the segment's identity fills in.
      current.id.number ??= id.number
      current.id.procedure ??= id.procedure
      current.lines.push(...lines)
    }
  })

  const segments = open.map((o) => o.lines)
  const reports = segments.map((lines) => parseNdeReport(lines))

  // The sheets state their own extent, which is the one check that can
  // catch a page the extractor never saw.
  const declared = extraction.pages
    .flatMap((p) => p.lines.map((l) => pageMarker(l.text)))
    .filter((m): m is { page: number; of: number } => m !== null)
    .reduce((max, m) => Math.max(max, m.of), 0)
  if (declared > extraction.pages.length) {
    gaps.push({
      kind: 'pages_missing', severity: 'critical',
      detail: `The report states ${declared} pages and the file gave up ${extraction.pages.length}.`,
    })
  }

  if (reports.length === 0) {
    gaps.push({
      kind: 'no_reports', severity: 'critical',
      detail: 'No inspection report could be read from this file.',
    })
  }

  reports.forEach((r, i) => {
    const which = reports.length > 1 ? ` (report ${i + 1} of ${reports.length})` : ''
    if (r.unreadRows > 0) {
      gaps.push({
        kind: 'row_not_read', severity: 'critical',
        detail: `${r.unreadRows} numbered row${r.unreadRows === 1 ? '' : 's'} carried content but named no weld${which}.`,
      })
    }
    // A report without these cannot be audited later: there is nothing to
    // cite, nothing to date it by, and nothing saying what it was shot to.
    const required: [keyof ParsedNdeReport, string][] = [
      ['reportNumber', 'report number'],
      ['reportDate', 'report date'],
      ['procedureReference', 'procedure reference'],
      ['technicianName', 'technician name'],
    ]
    for (const [key, label] of required) {
      if (r[key] === null) {
        gaps.push({
          kind: 'missing_field',
          severity: key === 'reportDate' || key === 'reportNumber' ? 'critical' : 'warning',
          detail: `No ${label} could be read${which}.`,
        })
      }
    }
    if (r.lines.length === 0) {
      gaps.push({
        kind: 'row_not_read', severity: 'critical',
        detail: `No exposure rows were read${which}.`,
      })
    }
  })

  return { reports, gaps, complete: gaps.length === 0 }
}
