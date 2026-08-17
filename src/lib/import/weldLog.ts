/**
 * Noble detailed weld log importer.
 *
 * The template repeats on every line sheet: a job header block in the first
 * ~22 rows, the column header at row 23, and data from row 24 down in
 * columns B–Q. A workbook carries one sheet per line — 38 of them in the
 * DP452 Flow Lines book — so the importer walks every sheet and treats the
 * sheet name as the line code.
 *
 * The header row is *located*, not assumed: field workbooks pick up
 * inserted rows over a job's life, and an importer that hard-codes row 23
 * silently shifts every column when someone adds a note at the top.
 */
import type { WorkBook, WorkSheet } from 'xlsx'
import * as XLSX from 'xlsx'
import type { JointType, NdtMethod, PassFail, Weld, WeldLine } from '@/lib/domain/types'
import { parseLooseDate } from '@/lib/domain/dates'
import { parsePassAssignment, resolveWelder } from '@/lib/domain/welders'
import type { Welder } from '@/lib/domain/types'
import type { ImportPreview, RowIssue } from './types'

/** Column header text → field, matched case- and space-insensitively so a
 *  workbook with `Weld  Date` or `WELD DATE` still lands. */
const COLUMN_MAP: Record<string, keyof ParsedWeldRow> = {
  'weld number': 'weldNumber',
  'weld no': 'weldNumber',
  'weld #': 'weldNumber',
  'date': 'weldDate',
  'weld date': 'weldDate',
  'welder': 'welderPassAssignment',
  'welder id': 'welderPassAssignment',
  'welders': 'welderPassAssignment',
  'welder root/hot/fill/cap': 'welderPassAssignment',
  'joint type': 'jointType',
  'type': 'jointType',
  'description': 'componentDescription',
  'component': 'componentDescription',
  'part description': 'componentDescription',
  'length': 'partLength',
  'part length': 'partLength',
  'heat number': 'heatNumbersRaw',
  'heat numbers': 'heatNumbersRaw',
  'heat #': 'heatNumbersRaw',
  'cwi': 'cwiInitials',
  'cwi initials': 'cwiInitials',
  'visual': 'cwiVisualResult',
  'visual result': 'cwiVisualResult',
  'cwi visual': 'cwiVisualResult',
  'visual date': 'visualInspectionDate',
  'ndt company': 'ndtCompany',
  'ndt': 'ndtCompany',
  'x-ray': 'xrayNumber',
  'xray': 'xrayNumber',
  'x-ray number': 'xrayNumber',
  'ticket': 'ndtTicketNumber',
  'ticket number': 'ndtTicketNumber',
  'method': 'ndtMethod',
  'ndt method': 'ndtMethod',
  'ndt result': 'ndtResult',
  'result': 'ndtResult',
  'comments': 'comments',
  'notes': 'comments',
}

export interface ParsedWeldRow {
  sheet: string
  rowNumber: number
  weldNumber: string
  weldDate: string | null
  welderPassAssignment: string | null
  jointType: JointType | null
  componentDescription: string | null
  partLength: string | null
  heatNumbersRaw: string | null
  heatNumbers: string[]
  cwiInitials: string | null
  cwiVisualResult: PassFail | null
  visualInspectionDate: string | null
  ndtCompany: string | null
  xrayNumber: string | null
  ndtTicketNumber: string | null
  ndtMethod: NdtMethod | null
  ndtResult: PassFail | null
  comments: string | null
  /** `NOT USED` rows are sequence gaps by design, kept so the numbering
   *  stays faithful but excluded from every denominator. */
  isNotUsed: boolean
}

const norm = (v: unknown) => String(v ?? '').trim()
const normKey = (v: unknown) => norm(v).toLowerCase().replace(/\s+/g, ' ')

function parsePassFail(v: unknown): PassFail | null {
  const s = normKey(v)
  if (!s) return null
  if (/^(p|pass|passed|acc|accept|accepted|ok)$/.test(s)) return 'Pass'
  if (/^(f|fail|failed|rej|reject|rejected)$/.test(s)) return 'Fail'
  return null
}

function parseJointType(v: unknown): JointType | null {
  const s = normKey(v)
  if (!s) return null
  if (s.startsWith('butt')) return 'Butt'
  if (s.includes('let')) return 'O-let'
  if (s.startsWith('sock')) return 'Socket'
  if (s.startsWith('branch')) return 'Branch'
  return null
}

function parseMethod(v: unknown): NdtMethod | null {
  const s = normKey(v).toUpperCase()
  return (['RT', 'PT', 'MT', 'UT'] as const).find((m) => s.includes(m)) ?? null
}

/** Split `A12345 / B67890` or `A12345, B67890` into individual heats. */
export function parseHeatNumbers(v: unknown): string[] {
  const s = norm(v)
  if (!s) return []
  return [...new Set(s.split(/[/,;|]+/).map((x) => x.trim()).filter(Boolean))]
}

/**
 * Find the column header row and map its cells to fields. Scans the first
 * 40 rows for the row containing the most recognisable headers rather than
 * trusting a fixed offset.
 */
function locateHeader(rows: unknown[][]): { headerRow: number; columns: Map<number, keyof ParsedWeldRow> } {
  let best = { headerRow: -1, columns: new Map<number, keyof ParsedWeldRow>() }
  for (let r = 0; r < Math.min(40, rows.length); r++) {
    const cells = rows[r] ?? []
    const columns = new Map<number, keyof ParsedWeldRow>()
    cells.forEach((cell, c) => {
      const field = COLUMN_MAP[normKey(cell)]
      if (field) columns.set(c, field)
    })
    if (columns.size > best.columns.size) best = { headerRow: r, columns }
  }
  return best
}

/** Job header fields repeated at the top of every line sheet. */
function readSheetHeader(rows: unknown[][], headerRow: number): Partial<WeldLine> {
  const out: Partial<WeldLine> = {}
  const labels: [RegExp, keyof WeldLine][] = [
    [/facility name/i, 'facilityName'],
    [/drill pad/i, 'drillPadName'],
    [/well name/i, 'wellName'],
    [/(noble energy pic|noble pic|operator pic)/i, 'operatorPic'],
    [/welding company/i, 'weldingCompany'],
    [/pipe size/i, 'pipeSize'],
    [/pipe schedule/i, 'pipeSchedule'],
    [/pipe grade/i, 'pipeGrade'],
    [/(service|service type)/i, 'serviceType'],
  ]
  for (let r = 0; r < headerRow; r++) {
    const cells = rows[r] ?? []
    for (let c = 0; c < cells.length; c++) {
      const label = norm(cells[c])
      if (!label) continue
      for (const [re, field] of labels) {
        if (!re.test(label)) continue
        // The value sits in the next non-empty cell to the right.
        for (let k = c + 1; k < Math.min(c + 5, cells.length); k++) {
          const v = norm(cells[k])
          if (v) { (out as Record<string, unknown>)[field] = v; break }
        }
      }
    }
  }
  return out
}

export interface WeldImportResult extends ImportPreview<ParsedWeldRow> {
  lines: (Partial<WeldLine> & { lineCode: string; rowCount: number })[]
}

export function parseWeldLogWorkbook(
  data: ArrayBuffer | Uint8Array,
  opts: { welders?: Welder[]; workbookLabel?: string } = {},
): WeldImportResult {
  const wb: WorkBook = XLSX.read(data, { type: 'array', cellDates: true })
  return parseWeldLogSheets(wb, opts)
}

export function parseWeldLogSheets(
  wb: WorkBook,
  opts: { welders?: Welder[]; workbookLabel?: string } = {},
): WeldImportResult {
  const welders = opts.welders ?? []
  const rows: ParsedWeldRow[] = []
  const issues: RowIssue[] = []
  const lines: WeldImportResult['lines'] = []
  const unresolvedWelders = new Map<string, number>()
  const heats = new Set<string>()
  let rejectedCount = 0

  for (const sheetName of wb.SheetNames) {
    const sheet: WorkSheet | undefined = wb.Sheets[sheetName]
    if (!sheet) continue
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
    const { headerRow, columns } = locateHeader(grid)

    if (headerRow < 0 || columns.size < 3) {
      issues.push({
        severity: 'warning', sheet: sheetName, row: 1,
        message: `No weld log column header found on this sheet; skipped. ` +
          `Expected a row containing at least "Weld Number", "Date" and "Welder".`,
      })
      continue
    }
    const header = readSheetHeader(grid, headerRow)
    let sheetRowCount = 0

    for (let r = headerRow + 1; r < grid.length; r++) {
      const cells = grid[r] ?? []
      const raw: Record<string, unknown> = {}
      for (const [colIdx, field] of columns) raw[field] = cells[colIdx]

      const weldNumber = norm(raw.weldNumber)
      // A row with no weld number is padding, a subtotal, or a blank —
      // never a weld. Skip silently rather than filling the issue list.
      if (!weldNumber) continue

      const descr = norm(raw.componentDescription)
      const isNotUsed = /not\s*used/i.test(weldNumber) || /not\s*used/i.test(descr)

      const rowNumber = r + 1
      const weldDate = parseLooseDate(raw.weldDate)
      if (!isNotUsed && raw.weldDate != null && norm(raw.weldDate) !== '' && !weldDate) {
        issues.push({
          severity: 'error', sheet: sheetName, row: rowNumber, column: 'Date',
          message: `Cannot read "${norm(raw.weldDate)}" as a date. Accepted forms: ` +
            `2024-06-14, 6/14/24, 6-14-2024, 6.14.2024, or an Excel date cell.`,
        })
        rejectedCount++
        continue
      }

      const passCell = norm(raw.welderPassAssignment)
      const passes = passCell ? parsePassAssignment(passCell) : [null, null, null, null]
      if (!isNotUsed) {
        if (!passCell) {
          issues.push({
            severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Welder',
            message: 'No welder recorded. This weld will import but will not be complete.',
          })
        } else {
          for (const p of passes) {
            if (!p) continue
            if (resolveWelder(p, welders)) continue
            unresolvedWelders.set(p, (unresolvedWelders.get(p) ?? 0) + 1)
          }
          if (passCell.split('/').length !== 4) {
            issues.push({
              severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Welder',
              message: `"${passCell}" does not name four passes. The Noble template records ` +
                `Root/Hot/Fill/Cap; a partial entry cannot be attributed per pass.`,
            })
          }
        }
      }

      const heatNumbers = parseHeatNumbers(raw.heatNumbersRaw)
      for (const h of heatNumbers) heats.add(h)
      if (!isNotUsed && !heatNumbers.length) {
        issues.push({
          severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Heat Number',
          message: 'No heat number recorded; this weld cannot be traced to a material test report.',
        })
      }

      const ndtMethod = parseMethod(raw.ndtMethod)
      const xrayNumber = norm(raw.xrayNumber) || null
      if (!isNotUsed && xrayNumber && !ndtMethod) {
        issues.push({
          severity: 'info', sheet: sheetName, row: rowNumber, column: 'Method',
          message: `An X-ray number is recorded with no method; assuming RT.`,
        })
      }

      rows.push({
        sheet: sheetName,
        rowNumber,
        weldNumber,
        weldDate,
        welderPassAssignment: passCell || null,
        jointType: parseJointType(raw.jointType),
        componentDescription: descr || null,
        partLength: norm(raw.partLength) || null,
        heatNumbersRaw: norm(raw.heatNumbersRaw) || null,
        heatNumbers,
        cwiInitials: norm(raw.cwiInitials) || null,
        cwiVisualResult: parsePassFail(raw.cwiVisualResult),
        visualInspectionDate: parseLooseDate(raw.visualInspectionDate),
        ndtCompany: norm(raw.ndtCompany) || null,
        xrayNumber,
        ndtTicketNumber: norm(raw.ndtTicketNumber) || null,
        ndtMethod: ndtMethod ?? (xrayNumber ? 'RT' : null),
        ndtResult: parsePassFail(raw.ndtResult),
        comments: norm(raw.comments) || null,
        isNotUsed,
      })
      sheetRowCount++
    }

    if (sheetRowCount > 0) {
      lines.push({ ...header, lineCode: sheetName.trim(), rowCount: sheetRowCount })
    }
  }

  // Duplicate weld numbers within one line are a data error, not a variant:
  // the pair cannot both be joint 14 of line FL7.
  const seen = new Map<string, ParsedWeldRow>()
  for (const row of rows) {
    const key = `${row.sheet}|${row.weldNumber}`
    const prior = seen.get(key)
    if (prior && !row.isNotUsed) {
      issues.push({
        severity: 'error', sheet: row.sheet, row: row.rowNumber, column: 'Weld Number',
        message: `Weld ${row.weldNumber} already appears on row ${prior.rowNumber} of this sheet.`,
      })
    } else seen.set(key, row)
  }

  return {
    rows,
    issues,
    rejectedCount,
    sheetsParsed: lines.map((l) => l.lineCode),
    lines,
    proposedWelders: [...unresolvedWelders.entries()]
      .map(([nameOrInitials, occurrences]) => ({ nameOrInitials, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences),
    proposedWrenches: [],
    proposedHeats: [...heats].sort(),
  }
}

/** Turn parsed rows into weld records once a human has approved the
 *  preview and every proposed welder has been resolved to a managed one. */
export function toWeldRecords(
  parsed: ParsedWeldRow[],
  ctx: { jobBookId: string; lineIdByCode: Map<string, string>; welders: Welder[]; cwiIdByInitials: Map<string, string> },
): Weld[] {
  const out: Weld[] = []
  parsed.forEach((row, i) => {
    const weldLineId = ctx.lineIdByCode.get(row.sheet.trim())
    if (!weldLineId) return
    const passes = row.welderPassAssignment
      ? parsePassAssignment(row.welderPassAssignment)
      : [null, null, null, null]
    const ids = passes.map((p) => (p ? resolveWelder(p, ctx.welders)?.id ?? null : null))
    out.push({
      id: `${weldLineId}:${row.weldNumber}`,
      weldLineId,
      jobBookId: ctx.jobBookId,
      weldNumber: row.weldNumber,
      sortOrder: i,
      weldDate: row.weldDate,
      welderPassAssignment: row.welderPassAssignment,
      rootWelderId: ids[0] ?? null,
      hotWelderId: ids[1] ?? null,
      fillWelderId: ids[2] ?? null,
      capWelderId: ids[3] ?? null,
      jointType: row.jointType,
      componentDescription: row.componentDescription,
      partLength: row.partLength,
      heatNumbers: row.heatNumbers,
      cwiInitials: row.cwiInitials,
      cwiId: row.cwiInitials ? ctx.cwiIdByInitials.get(row.cwiInitials.toUpperCase()) ?? null : null,
      cwiVisualResult: row.cwiVisualResult,
      visualInspectionDate: row.visualInspectionDate,
      ndtCompany: row.ndtCompany,
      xrayNumber: row.xrayNumber,
      ndtTicketNumber: row.ndtTicketNumber,
      ndtMethod: row.ndtMethod,
      ndtResult: row.ndtResult,
      ndtReportId: null,
      status: row.isNotUsed
        ? 'not_used'
        : row.ndtResult ? 'ndt_complete' : row.cwiVisualResult ? 'visual_complete' : 'welded',
      comments: row.comments,
    })
  })
  return out
}
