/**
 * Reading a pressure test hold sheet — Appendix A §17.
 *
 * §17 is the section the baseline review found in the worst state: 13 of
 * 21 facility test packages held instrument certificates and no result
 * document, and nothing in the application could tell, because a
 * pressure test only existed as a folder of PDFs. §11.1 makes accepting
 * a test "without gauge, recorder and pressure safety valve certificates
 * valid on the test date" a Critical finding, and that check needs a row
 * with a date on it before it can be made at all.
 *
 * WHAT THIS READS. The hold table a crew actually keeps — one row per
 * test, with the date, the hold duration, the start and end pressure and
 * the ambient temperature. Greeley's lives in "Testing Times and
 * Pressures.xlsx"; the same shape shows up under a dozen names, so the
 * columns are matched by what they say rather than by position.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide pass or fail. A
 * hold that ends lower than it started is not automatically a failure —
 * ambient temperature moves a reading, and §17's acceptance criteria are
 * the test procedure's, not arithmetic on two numbers. The result
 * document in the pack decides it, and this reader has not seen it. So
 * `result` comes back null and stays null until somebody files the
 * document that settles it.
 *
 * A row of zeros is not a test. The Greeley template ships rows 14-20
 * pre-numbered with all-zero values and no recorded hold; importing
 * those as seven passing tests would be inventing seven tests.
 */

import * as XLSX from 'xlsx'
import type { IsoDate, PressureTest } from '@/lib/domain/types'
import { extractPdfText, pdfGridAllPages } from './pdfText'
import { parseLooseDate } from '@/lib/domain/dates'
import { recordId } from '@/lib/domain/recordId'

export interface ParsedPressureRow {
  rowNumber: number
  /** As the sheet writes it — "1", "Test #7", "PT-014". Never renumbered. */
  testIdentifier: string
  testDate: IsoDate | null
  durationMinutes: number | null
  startPressurePsi: number | null
  endPressurePsi: number | null
  ambientTempF: number | null
  /** A row the sheet holds but which records no test. */
  empty: boolean
}

export interface PressureRowIssue {
  severity: 'error' | 'warning'
  row: number
  column?: string
  message: string
}

export interface PressureTestImportResult {
  rows: ParsedPressureRow[]
  /** Rows present in the sheet that record nothing. Counted and named,
   *  never imported: a numbered blank is a placeholder, not a test. */
  emptyRows: ParsedPressureRow[]
  issues: PressureRowIssue[]
  sheetsParsed: string[]
}

type Cell = string | null

const norm = (v: unknown) => (v == null ? '' : String(v).trim())
const key = (v: unknown) => norm(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Column headers, matched by meaning.
 *
 * Every spelling here came off a real sheet. A crew writes "Start PSI",
 * "Starting Pressure" and "Press. Start" for the same column, and a
 * reader that insists on one of them reads a third of the sheets it is
 * handed.
 */
const HEADERS: Record<string, keyof ParsedPressureRow> = {
  'test': 'testIdentifier', 'test no': 'testIdentifier', 'test number': 'testIdentifier',
  'test id': 'testIdentifier', 'test identifier': 'testIdentifier',
  'pressure test': 'testIdentifier', 'hydro test': 'testIdentifier', 'pt': 'testIdentifier',

  'date': 'testDate', 'test date': 'testDate', 'date tested': 'testDate',

  'hold minutes': 'durationMinutes', 'hold time': 'durationMinutes',
  'duration': 'durationMinutes', 'duration minutes': 'durationMinutes',
  'minutes': 'durationMinutes', 'hold': 'durationMinutes',
  'time minutes': 'durationMinutes', 'hold duration': 'durationMinutes',

  'start psi': 'startPressurePsi', 'starting pressure': 'startPressurePsi',
  'start pressure': 'startPressurePsi', 'press start': 'startPressurePsi',
  'initial pressure': 'startPressurePsi', 'start': 'startPressurePsi',

  'end psi': 'endPressurePsi', 'ending pressure': 'endPressurePsi',
  'end pressure': 'endPressurePsi', 'press end': 'endPressurePsi',
  'final pressure': 'endPressurePsi', 'end': 'endPressurePsi',

  'temp f': 'ambientTempF', 'temperature': 'ambientTempF', 'temp': 'ambientTempF',
  'ambient temp': 'ambientTempF', 'ambient temperature': 'ambientTempF',
  'ambient': 'ambientTempF',
}

function parseNumber(v: unknown): number | null {
  const s = norm(v).replace(/,/g, '')
  if (!s) return null
  const n = Number(s.replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** The header row, and which column each field is in. */
function locateHeader(rows: Cell[][]): {
  headerRow: number
  columns: Map<number, keyof ParsedPressureRow>
} {
  let best = { headerRow: -1, columns: new Map<number, keyof ParsedPressureRow>() }
  // Scan a generous way down: these sheets carry a title block, a logo
  // and two blank rows before the table starts.
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const row = rows[r] ?? []
    const columns = new Map<number, keyof ParsedPressureRow>()
    for (let c = 0; c < row.length; c++) {
      const field = HEADERS[key(row[c])]
      // First column wins a field, so a trailing "Notes (start)" cannot
      // steal the start-pressure column from the real one.
      if (field && ![...columns.values()].includes(field)) columns.set(c, field)
    }
    if (columns.size > best.columns.size) best = { headerRow: r, columns }
  }
  return best
}

export function parsePressureTestRows(
  rows: Cell[][], sheetName = 'Pressure Tests',
): PressureTestImportResult {
  const { headerRow, columns } = locateHeader(rows)
  const issues: PressureRowIssue[] = []

  // Four is the floor for a usable table: an identifier, a date and the
  // two pressures. Anything less and the sheet is something else.
  if (headerRow < 0 || columns.size < 4) {
    return {
      rows: [], emptyRows: [], sheetsParsed: [sheetName],
      issues: [{
        severity: 'error', row: 1,
        message:
          'No pressure test table found. Expected a header row naming at least a test ' +
          'number, a date, and start and end pressures.',
      }],
    }
  }

  const parsed: ParsedPressureRow[] = []
  const empties: ParsedPressureRow[] = []

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? []
    const get = (field: keyof ParsedPressureRow): Cell => {
      for (const [c, f] of columns) if (f === field) return row[c] ?? null
      return null
    }

    const identifier = norm(get('testIdentifier'))
    const rawDate = get('testDate')
    const start = parseNumber(get('startPressurePsi'))
    const end = parseNumber(get('endPressurePsi'))
    const minutes = parseNumber(get('durationMinutes'))
    const temp = parseNumber(get('ambientTempF'))

    // A row with nothing in any column is the end of the table or a
    // spacer, not a test.
    if (!identifier && !rawDate && start == null && end == null && minutes == null) continue

    let testDate: IsoDate | null = null
    if (rawDate) {
      testDate = parseLooseDate(rawDate)
      if (!testDate) {
        issues.push({
          severity: 'warning', row: r + 1, column: 'Date',
          message:
            `Row ${r + 1}: "${norm(rawDate)}" is not a date this reader recognises. The test ` +
            `imports without one, and §11.1 cannot check its instrument certificates until ` +
            `it has one.`,
        })
      }
    }

    // A numbered row with no date and no pressure is a placeholder in the
    // template, not a test that happened. Importing it would invent a
    // test — and on the Greeley sheet that is seven of them.
    //
    // Zero counts as absent here, for every field. The template ships
    // those rows filled with zeros rather than blanks, and a hold of
    // nought minutes at nought psi is not a test held at low pressure —
    // it is a row nobody filled in. Treating only `null` as absent reads
    // all seven as passing tests.
    const blank = (n: number | null) => n == null || n === 0
    const empty =
      testDate == null && blank(minutes) && blank(start) && blank(end)

    const record: ParsedPressureRow = {
      rowNumber: r + 1,
      testIdentifier: identifier || `Row ${r + 1}`,
      testDate,
      durationMinutes: minutes,
      startPressurePsi: start,
      endPressurePsi: end,
      ambientTempF: temp,
      empty,
    }
    if (empty) empties.push(record)
    else parsed.push(record)
  }

  return { rows: parsed, emptyRows: empties, issues, sheetsParsed: [sheetName] }
}

// ---------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------

export interface PressureLogGrid {
  grid: Cell[][]
  format: 'xlsx' | 'pdf'
  sheetsParsed: string[]
  error?: string
}

const isPdf = (b: Uint8Array) =>
  b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46

const asText = (grid: unknown[][]): Cell[][] =>
  grid.map((row) => row.map((c) => (c == null || c === '' ? null : String(c))))

export function readPressureLogGrid(
  bytes: Uint8Array, filename = '',
): PressureLogGrid {
  if (isPdf(bytes) || /\.pdf$/i.test(filename)) {
    const extracted = extractPdfText(bytes)
    if (extracted.pages.length === 0) {
      return {
        grid: [], format: 'pdf', sheetsParsed: [],
        error: extracted.undecodable > 0
          ? 'No text could be read from this PDF. It is either a scan or uses an encoding this reader does not handle, so the tests in it cannot be imported — file it as a document instead.'
          : 'No text found in this PDF.',
      }
    }
    return {
      grid: asText(pdfGridAllPages(extracted)),
      format: 'pdf',
      sheetsParsed: extracted.pages.map((p) => `page ${p.index + 1}`),
    }
  }

  try {
    const wb = XLSX.read(bytes, { type: 'array', cellDates: false })
    const grid: unknown[][] = []
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name]
      if (!sheet) continue
      grid.push(
        ...XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1, raw: false, defval: null,
        }),
      )
    }
    return { grid: asText(grid), format: 'xlsx', sheetsParsed: wb.SheetNames }
  } catch {
    return {
      grid: [], format: 'xlsx', sheetsParsed: [],
      error: 'That file could not be read as a workbook or a PDF.',
    }
  }
}

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------

/**
 * A stable id from the book and the test identifier, so re-importing a
 * corrected sheet updates the same rows. The same property the weld and
 * torque imports rely on, and for the same reason.
 */
export function pressureTestRecordId(jobBookId: string, identifier: string): string {
  return recordId('pressure_test', jobBookId, identifier)
}

export function toPressureTestRecords(
  parsed: ParsedPressureRow[],
  ctx: { jobBookId: string },
): PressureTest[] {
  return parsed.map((row) => ({
    id: pressureTestRecordId(ctx.jobBookId, row.testIdentifier),
    jobBookId: ctx.jobBookId,
    testIdentifier: row.testIdentifier,
    lineCodes: [],
    testDate: row.testDate,
    testMedium: null,
    // The pressure the test was held at is the one it started at. The end
    // reading is what the hold produced, and is recorded separately.
    testPressurePsi: row.startPressurePsi,
    durationMinutes: row.durationMinutes == null
      ? null : Math.round(row.durationMinutes),
    startPressurePsi: row.startPressurePsi,
    endPressurePsi: row.endPressurePsi,
    ambientTempF: row.ambientTempF,
    // Not decided here. A hold that ends lower than it started is not
    // automatically a failure — ambient temperature moves a reading — and
    // §17's acceptance criteria belong to the test procedure, not to
    // arithmetic on two numbers. The result document settles it.
    result: null,
    recorderSerial: null,
    recorderCertId: null,
    gaugeCertId: null,
    psvCertId: null,
    resultDocumentId: null,
    chartDocumentId: null,
    witnessedBy: null,
  }))
}
