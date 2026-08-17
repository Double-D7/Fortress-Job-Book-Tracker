/**
 * Noble torque log importer.
 *
 * The workbook carries a job header, a wrench roster block, and then one
 * row per flanged connection. Both the roster and the connection rows are
 * parsed, because the difference between them is itself a finding: in the
 * DP452 log the roster lists nine wrenches and the rows use eleven.
 *
 * Wrench identity is resolved against the managed roster, never invented
 * from the cell. A wrench id appearing on a row but nowhere else is
 * reported for a human to confirm rather than silently created — one of the
 * two extra ids in the source is almost certainly a mistyped neighbour, and
 * auto-creating it would launder a typo into a permanent equipment record.
 */
import type { WorkBook, WorkSheet } from 'xlsx'
import * as XLSX from 'xlsx'
import type { TorqueConnection, TorqueWrench } from '@/lib/domain/types'
import { parseLooseDate } from '@/lib/domain/dates'
import { suggestWrenchTypo } from '@/lib/domain/torque'
import type { ImportPreview, RowIssue } from './types'

const COLUMN_MAP: Record<string, keyof ParsedTorqueRow> = {
  'iso flange number': 'isoFlangeNumber',
  'iso/flange number': 'isoFlangeNumber',
  'flange number': 'isoFlangeNumber',
  'flange #': 'isoFlangeNumber',
  'iso number': 'isoNumber',
  'iso #': 'isoNumber',
  'iso': 'isoNumber',
  'flange pipe size': 'flangePipeSize',
  'pipe size': 'flangePipeSize',
  'size': 'flangePipeSize',
  'bolt diameter': 'boltDiameter',
  'bolt dia': 'boltDiameter',
  'bolt count': 'boltCount',
  'number of bolts': 'boltCount',
  '# of bolts': 'boltCount',
  'required torque': 'requiredTorque',
  'required torque (ft-lb)': 'requiredTorque',
  'req torque': 'requiredTorque',
  'actual torque': 'actualTorque',
  'actual torque (ft-lb)': 'actualTorque',
  'act torque': 'actualTorque',
  'wrench id': 'wrenchIdRaw',
  'torque wrench': 'wrenchIdRaw',
  'wrench': 'wrenchIdRaw',
  'wrench #': 'wrenchIdRaw',
  'cp test on flange': 'cpTest',
  'cp test': 'cpTest',
  'torque date': 'torqueDate',
  'date': 'torqueDate',
  'employee initials': 'employeeInitials',
  'employee': 'employeeInitials',
  'inspection date': 'inspectionDate',
  'inspected': 'inspectionDate',
  'inspector initials': 'inspectorInitials',
  'inspector': 'inspectorInitials',
}

export interface ParsedTorqueRow {
  sheet: string
  rowNumber: number
  isoFlangeNumber: string
  isoNumber: string | null
  flangePipeSize: string | null
  boltDiameter: string | null
  boltCount: number | null
  requiredTorque: number | null
  actualTorque: number | null
  wrenchIdRaw: string | null
  cpTest: boolean
  torqueDate: string | null
  employeeInitials: string | null
  inspectionDate: string | null
  inspectorInitials: string | null
}

const norm = (v: unknown) => String(v ?? '').trim()
const normKey = (v: unknown) => norm(v).toLowerCase().replace(/\s+/g, ' ')

function parseNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function parseYesNo(v: unknown): boolean {
  return /^(y|yes|true|x|1)$/i.test(norm(v))
}

/** Wrench ids are stored as text and zero-padded: a spreadsheet turns
 *  `0245` into the number 245 the moment someone retypes the cell. */
export function normalizeWrenchId(v: unknown): string | null {
  const s = norm(v)
  if (!s) return null
  if (/^\d+$/.test(s) && s.length < 4) return s.padStart(4, '0')
  return s
}

function locateHeader(rows: unknown[][]): { headerRow: number; columns: Map<number, keyof ParsedTorqueRow> } {
  let best = { headerRow: -1, columns: new Map<number, keyof ParsedTorqueRow>() }
  for (let r = 0; r < Math.min(50, rows.length); r++) {
    const columns = new Map<number, keyof ParsedTorqueRow>()
    ;(rows[r] ?? []).forEach((cell, c) => {
      const field = COLUMN_MAP[normKey(cell)]
      if (field) columns.set(c, field)
    })
    if (columns.size > best.columns.size) best = { headerRow: r, columns }
  }
  return best
}

/**
 * Read the wrench roster block from the header area. Any run of 3–5 digit
 * tokens near a "wrench" label is treated as the roster; the block is
 * formatted inconsistently across books, so this is deliberately loose.
 */
export function parseWrenchRoster(rows: unknown[][], headerRow: number): string[] {
  const ids = new Set<string>()
  for (let r = 0; r < Math.max(headerRow, 0); r++) {
    const cells = rows[r] ?? []
    const rowText = cells.map(norm).join(' ').toLowerCase()
    if (!/wrench|calibrat/.test(rowText)) continue
    for (const cell of cells) {
      const s = norm(cell)
      if (/^\d{3,5}$/.test(s)) ids.add(s.padStart(4, '0'))
      // A roster written as one comma-separated cell.
      for (const part of s.split(/[,;/]+/).map((x) => x.trim())) {
        if (/^\d{3,5}$/.test(part)) ids.add(part.padStart(4, '0'))
      }
    }
  }
  return [...ids].sort()
}

export interface TorqueImportResult extends ImportPreview<ParsedTorqueRow> {
  rosterWrenchIds: string[]
}

export function parseTorqueLogWorkbook(
  data: ArrayBuffer | Uint8Array,
  opts: { wrenches?: TorqueWrench[] } = {},
): TorqueImportResult {
  const wb: WorkBook = XLSX.read(data, { type: 'array', cellDates: true })
  return parseTorqueLogSheets(wb, opts)
}

export function parseTorqueLogSheets(
  wb: WorkBook,
  opts: { wrenches?: TorqueWrench[] } = {},
): TorqueImportResult {
  const known = opts.wrenches ?? []
  const knownIds = known.map((w) => w.wrenchId)
  const rows: ParsedTorqueRow[] = []
  const issues: RowIssue[] = []
  const sheetsParsed: string[] = []
  const rosterIds = new Set<string>()
  const unknownUsage = new Map<string, number>()
  let rejectedCount = 0

  for (const sheetName of wb.SheetNames) {
    const sheet: WorkSheet | undefined = wb.Sheets[sheetName]
    if (!sheet) continue
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
    const { headerRow, columns } = locateHeader(grid)
    if (headerRow < 0 || columns.size < 3) continue

    for (const id of parseWrenchRoster(grid, headerRow)) rosterIds.add(id)
    let count = 0

    for (let r = headerRow + 1; r < grid.length; r++) {
      const cells = grid[r] ?? []
      const raw: Record<string, unknown> = {}
      for (const [colIdx, field] of columns) raw[field] = cells[colIdx]

      const flange = norm(raw.isoFlangeNumber)
      if (!flange) continue
      const rowNumber = r + 1

      const torqueDate = parseLooseDate(raw.torqueDate)
      if (raw.torqueDate != null && norm(raw.torqueDate) !== '' && !torqueDate) {
        issues.push({
          severity: 'error', sheet: sheetName, row: rowNumber, column: 'Torque Date',
          message: `Cannot read "${norm(raw.torqueDate)}" as a date.`,
        })
        rejectedCount++
        continue
      }

      const wrenchIdRaw = normalizeWrenchId(raw.wrenchIdRaw)
      if (!wrenchIdRaw) {
        issues.push({
          severity: 'error', sheet: sheetName, row: rowNumber, column: 'Wrench ID',
          message: `Connection ${flange} records no wrench. A torque record without the wrench ` +
            `used cannot be tied to a calibration certificate.`,
        })
        rejectedCount++
        continue
      }
      if (knownIds.length && !knownIds.includes(wrenchIdRaw)) {
        unknownUsage.set(wrenchIdRaw, (unknownUsage.get(wrenchIdRaw) ?? 0) + 1)
      }

      const required = parseNumber(raw.requiredTorque)
      const actual = parseNumber(raw.actualTorque)
      if (required == null) {
        issues.push({
          severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Required Torque',
          message: `Connection ${flange} has no required torque; the actual value cannot be checked.`,
        })
      }
      if (actual == null) {
        issues.push({
          severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Actual Torque',
          message: `Connection ${flange} has no recorded actual torque.`,
        })
      }

      const inspectionDate = parseLooseDate(raw.inspectionDate)
      const inspectorInitials = norm(raw.inspectorInitials) || null
      if (inspectionDate && !inspectorInitials) {
        issues.push({
          severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Inspector Initials',
          message: `Connection ${flange} has an inspection date with no inspector. An unattributed ` +
            `inspection does not close the sign-off chain.`,
        })
      }

      rows.push({
        sheet: sheetName, rowNumber,
        isoFlangeNumber: flange,
        isoNumber: norm(raw.isoNumber) || null,
        flangePipeSize: norm(raw.flangePipeSize) || null,
        boltDiameter: norm(raw.boltDiameter) || null,
        boltCount: parseNumber(raw.boltCount),
        requiredTorque: required,
        actualTorque: actual,
        wrenchIdRaw,
        cpTest: parseYesNo(raw.cpTest),
        torqueDate,
        employeeInitials: norm(raw.employeeInitials) || null,
        inspectionDate,
        inspectorInitials,
      })
      count++
    }
    if (count > 0) sheetsParsed.push(sheetName)
  }

  // Wrenches used on rows but absent from the roster block, reported with a
  // typo suggestion where one exists.
  const rosterList = [...rosterIds]
  for (const [id, occurrences] of unknownUsage) {
    const suggestion = suggestWrenchTypo(id, [...knownIds, ...rosterList])
    issues.push({
      severity: 'warning', sheet: sheetsParsed[0] ?? '', row: 0, column: 'Wrench ID',
      message: `Wrench ${id} appears on ${occurrences} row(s) but matches no managed wrench.` +
        (suggestion
          ? ` It differs from ${suggestion} by one character — confirm before creating it, as a ` +
            `new equipment record built from a typo is permanent.`
          : ' Confirm it exists and upload its calibration certificate before committing.'),
    })
  }

  return {
    rows, issues, rejectedCount, sheetsParsed,
    rosterWrenchIds: rosterList.sort(),
    proposedWelders: [],
    proposedWrenches: [...unknownUsage.entries()]
      .map(([wrenchId, occurrences]) => ({ wrenchId, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences),
    proposedHeats: [],
  }
}

export function toTorqueRecords(
  parsed: ParsedTorqueRow[],
  ctx: { jobBookId: string; wrenchIdByCode: Map<string, string> },
): TorqueConnection[] {
  return parsed.map((row, i) => ({
    id: `${ctx.jobBookId}:tq:${row.isoFlangeNumber}:${i}`,
    jobBookId: ctx.jobBookId,
    isoFlangeNumber: row.isoFlangeNumber,
    isoNumber: row.isoNumber,
    flangePipeSize: row.flangePipeSize,
    boltDiameter: row.boltDiameter,
    boltCount: row.boltCount,
    requiredTorqueFtLb: row.requiredTorque,
    actualTorqueFtLb: row.actualTorque,
    wrenchId: row.wrenchIdRaw ? ctx.wrenchIdByCode.get(row.wrenchIdRaw) ?? null : null,
    wrenchIdRaw: row.wrenchIdRaw,
    cpTestOnFlange: row.cpTest,
    torqueDate: row.torqueDate,
    employeeInitials: row.employeeInitials,
    inspectionDate: row.inspectionDate,
    inspectorInitials: row.inspectorInitials,
    status: 'recorded',
  }))
}
