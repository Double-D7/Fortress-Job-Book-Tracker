/**
 * Facility torque log importer.
 *
 * Differs from the flowline template in two ways that matter:
 *
 *   · Required torque is a **range** (`130-260`), not a point value. Stored
 *     as min/max, with a point value setting both, so "is the actual within
 *     spec" becomes a containment test rather than a tolerance guess.
 *   · The header sits at row 17 under a job block and a wrench roster, and
 *     flange numbers are text — the Greeley log carries 39 decimal
 *     sub-numbers (`74.1`, `299.1`) for extra connections on one isometric.
 */
import type { TorqueConnection } from '@/lib/domain/types'
import { parseLooseDate } from '@/lib/domain/dates'
import { suggestWrenchTypo } from '@/lib/domain/torque'
import { normalizeWrenchId } from './torqueLog'
import type { ImportPreview, RowIssue } from './types'

export interface RosterWrench {
  wrenchId: string
  rawLabel: string
  capacityLabel: string | null
  lastCalibrationDate: string | null
  /** What the log *claims* about the certificate, which is not the same as
   *  what section 13 actually holds. */
  certClaimedSubmitted: boolean
}

export interface ParsedFacilityTorqueRow {
  rowNumber: number
  isoFlangeNumber: string
  isoNumber: string | null
  flangePipeSize: string | null
  boltDiameter: string | null
  boltCount: number | null
  requiredTorqueMin: number | null
  requiredTorqueMax: number | null
  requiredTorqueRaw: string | null
  actualTorque: number | null
  wrenchIdRaw: string | null
  torqueDate: string | null
  employeeInitials: string | null
  inspectionDate: string | null
  inspectorInitials: string | null
}

export interface FacilityTorqueImportResult extends ImportPreview<ParsedFacilityTorqueRow> {
  roster: RosterWrench[]
  /** Totals printed in the log's own header block, for cross-checking
   *  against what the rows actually say. */
  headerTotals: { totalFlanges: number | null; inspected: number | null; inspectionPct: string | null }
}

const norm = (v: unknown) => (v == null ? '' : String(v).trim())
const normKey = (v: unknown) => norm(v).toLowerCase().replace(/\s+/g, ' ')

function parseNumber(v: unknown): number | null {
  const s = norm(v)
  if (!s) return null
  const n = Number(s.replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * `130-260` → {min: 130, max: 260}. A point value sets both, so a range
 * and a single figure are one shape downstream.
 */
export function parseTorqueRange(v: unknown): {
  min: number | null; max: number | null; raw: string | null
} {
  const raw = norm(v)
  if (!raw) return { min: null, max: null, raw: null }
  // An en dash or hyphen between two numbers, tolerating spaces.
  const range = raw.match(/^(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)$/)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    return { min: Math.min(a, b), max: Math.max(a, b), raw }
  }
  const point = parseNumber(raw)
  return point == null ? { min: null, max: null, raw } : { min: point, max: point, raw }
}

/** Actual torque satisfies a range when it falls inside it, inclusive. */
export function torqueWithinRange(
  actual: number | null | undefined, min: number | null, max: number | null,
): boolean | null {
  if (actual == null || min == null || max == null) return null
  return actual >= min && actual <= max
}

const COLUMN_MAP: Record<string, keyof ParsedFacilityTorqueRow | 'requiredTorque'> = {
  'iso flange #': 'isoFlangeNumber',
  'iso flange number': 'isoFlangeNumber',
  'flange #': 'isoFlangeNumber',
  'iso number': 'isoNumber',
  'iso #': 'isoNumber',
  'flange pipe size (in)': 'flangePipeSize',
  'flange pipe size': 'flangePipeSize',
  'pipe size': 'flangePipeSize',
  'bolt diameter (in)': 'boltDiameter',
  'bolt diameter': 'boltDiameter',
  '# of bolts': 'boltCount',
  'number of bolts': 'boltCount',
  'required torque (ft-lbs)': 'requiredTorque',
  'required torque': 'requiredTorque',
  'actual torque (ft-lbs)': 'actualTorque',
  'actual torque': 'actualTorque',
  'wrench id #': 'wrenchIdRaw',
  'wrench id': 'wrenchIdRaw',
  'torque date': 'torqueDate',
  'employee initials': 'employeeInitials',
  'inspection date': 'inspectionDate',
  'inspector initials': 'inspectorInitials',
}

function locateHeader(rows: (string | null)[][]): {
  headerRow: number; columns: Map<number, keyof ParsedFacilityTorqueRow | 'requiredTorque'>
} {
  let best = { headerRow: -1, columns: new Map<number, keyof ParsedFacilityTorqueRow | 'requiredTorque'>() }
  for (let r = 0; r < Math.min(60, rows.length); r++) {
    const columns = new Map<number, keyof ParsedFacilityTorqueRow | 'requiredTorque'>()
    ;(rows[r] ?? []).forEach((cell, c) => {
      const field = COLUMN_MAP[normKey(cell)]
      if (field) columns.set(c, field)
    })
    if (columns.size > best.columns.size) best = { headerRow: r, columns }
  }
  return best
}

/**
 * Wrench roster from the header block. Labels read like
 * `122360 O480 (100-600 LB)` — an asset number, the wrench id, and a
 * capacity. The id is the middle token, and the Greeley log writes one of
 * them with a letter O for a zero, which is exactly why identity comes
 * from a managed record and never from this string.
 */
export function parseRoster(rows: (string | null)[][], headerRow: number): RosterWrench[] {
  const out: RosterWrench[] = []
  for (let r = 0; r < Math.max(headerRow, 0); r++) {
    const cells = rows[r] ?? []
    const label = norm(cells[0])
    if (!label) continue
    const m = label.match(/^([0-9]+)\s+([0-9O]{3,6})\s*(\(.*\))?\s*$/i)
    if (!m) continue
    const id = normalizeWrenchId((m[2] ?? '').replace(/O/gi, '0'))
    if (!id) continue
    const calCell = cells.find((c, i) => i > 0 && parseLooseDate(c) != null)
    const certCell = cells.slice(1).map(norm).find((c) => /^(y|yes|n|no)$/i.test(c))
    out.push({
      wrenchId: id,
      rawLabel: label,
      capacityLabel: m[3] ? m[3].replace(/[()]/g, '').trim() : null,
      lastCalibrationDate: parseLooseDate(calCell),
      certClaimedSubmitted: /^(y|yes)$/i.test(certCell ?? ''),
    })
  }
  return out
}

/** `Total Flanges 718` style figures printed in the header block. */
function parseHeaderTotals(rows: (string | null)[][], headerRow: number) {
  const totals = { totalFlanges: null as number | null, inspected: null as number | null,
                   inspectionPct: null as string | null }
  for (let r = 0; r < Math.max(headerRow, 0); r++) {
    const cells = (rows[r] ?? []).map(norm)
    for (let c = 0; c < cells.length; c++) {
      const label = normKey(cells[c])
      const value = cells.slice(c + 1).find((v) => v !== '')
      if (!value) continue
      if (label === 'total flanges') totals.totalFlanges = parseNumber(value)
      else if (label.startsWith('# of flanges inspected')) totals.inspected = parseNumber(value)
      else if (label === 'inspection percentage') totals.inspectionPct = value
    }
  }
  return totals
}

export function parseFacilityTorqueRows(
  rows: (string | null)[][], sheetName = 'Torque Log',
): FacilityTorqueImportResult {
  const { headerRow, columns } = locateHeader(rows)
  const issues: RowIssue[] = []
  const parsed: ParsedFacilityTorqueRow[] = []
  let rejectedCount = 0

  if (headerRow < 0 || columns.size < 4) {
    return {
      rows: [], issues: [{ severity: 'error', sheet: sheetName, row: 1,
        message: 'No torque log column header found. Expected a row containing ' +
          '"ISO Flange #", "Required Torque (ft-lbs)" and "Wrench ID #".' }],
      rejectedCount: 0, sheetsParsed: [], roster: [],
      headerTotals: { totalFlanges: null, inspected: null, inspectionPct: null },
      proposedWelders: [], proposedWrenches: [], proposedHeats: [],
    }
  }

  const roster = parseRoster(rows, headerRow)
  const headerTotals = parseHeaderTotals(rows, headerRow)
  const usage = new Map<string, number>()

  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = rows[r] ?? []
    const raw: Record<string, unknown> = {}
    for (const [idx, field] of columns) raw[field] = cells[idx]

    // Flange numbers are text: the Greeley log carries decimal sub-numbers
    // for extra connections on one isometric.
    const flange = norm(raw.isoFlangeNumber)
    if (!flange) continue
    const rowNumber = r + 1

    const torqueDate = parseLooseDate(raw.torqueDate)
    if (raw.torqueDate != null && norm(raw.torqueDate) !== '' && !torqueDate) {
      issues.push({ severity: 'error', sheet: sheetName, row: rowNumber, column: 'Torque Date',
        message: `Cannot read "${norm(raw.torqueDate)}" as a date.` })
      rejectedCount++
      continue
    }

    const wrenchIdRaw = normalizeWrenchId(norm(raw.wrenchIdRaw).replace(/O/gi, '0'))
    if (wrenchIdRaw) usage.set(wrenchIdRaw, (usage.get(wrenchIdRaw) ?? 0) + 1)
    else {
      issues.push({ severity: 'error', sheet: sheetName, row: rowNumber, column: 'Wrench ID #',
        message: `Connection ${flange} records no wrench; it cannot be tied to a calibration certificate.` })
      rejectedCount++
      continue
    }

    const range = parseTorqueRange(raw.requiredTorque)
    const actual = parseNumber(raw.actualTorque)
    if (range.min == null && range.raw) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Required Torque',
        message: `Cannot read "${range.raw}" as a value or a range.` })
    }
    if (actual == null) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Actual Torque',
        message: `Connection ${flange} has no recorded actual torque.` })
    } else if (torqueWithinRange(actual, range.min, range.max) === false) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Actual Torque',
        message: `Connection ${flange}: actual ${actual} ft-lb is outside the required range ${range.raw}.` })
    }

    const inspectionDate = parseLooseDate(raw.inspectionDate)
    const inspectorInitials = norm(raw.inspectorInitials) || null
    // A populated-but-unparseable inspection date must never be dropped in
    // silence. In the Greeley log three rows carry inspector initials typed
    // into the date column, which reads as "inspected" to anyone counting
    // populated cells and as "not inspected" to anyone parsing dates.
    if (!inspectionDate && norm(raw.inspectionDate) !== '') {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Inspection Date',
        message: `Connection ${flange}: "${norm(raw.inspectionDate)}" is not a date. The cell is ` +
          `populated, so a count of filled cells treats this connection as inspected, but no ` +
          `inspection date can be recorded against it.` })
    }
    if (inspectionDate && !inspectorInitials) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Inspector Initials',
        message: `Connection ${flange} has an inspection date with no inspector; the sign-off chain is open.` })
    }

    parsed.push({
      rowNumber,
      isoFlangeNumber: flange,
      isoNumber: norm(raw.isoNumber) || null,
      flangePipeSize: norm(raw.flangePipeSize) || null,
      boltDiameter: norm(raw.boltDiameter) || null,
      boltCount: parseNumber(raw.boltCount),
      requiredTorqueMin: range.min,
      requiredTorqueMax: range.max,
      requiredTorqueRaw: range.raw,
      actualTorque: actual,
      wrenchIdRaw,
      torqueDate,
      employeeInitials: norm(raw.employeeInitials) || null,
      inspectionDate,
      inspectorInitials,
    })
  }

  // A flange number reused on two rows. Harmless where the isometrics
  // differ — the pair is still unique — but worth saying out loud, because
  // anything keyed on the flange number alone would lose one of them.
  const byFlange = new Map<string, ParsedFacilityTorqueRow[]>()
  for (const row of parsed) {
    const key = row.isoFlangeNumber.trim().toUpperCase()
    const list = byFlange.get(key) ?? []
    list.push(row)
    byFlange.set(key, list)
  }
  for (const [flange, dupes] of byFlange) {
    if (dupes.length < 2) continue
    const isos = new Set(dupes.map((d) => (d.isoNumber ?? '').toUpperCase()))
    issues.push({
      severity: isos.size === dupes.length ? 'warning' : 'error',
      sheet: sheetName, row: dupes[1]!.rowNumber, column: 'ISO Flange #',
      message: `Flange ${flange} appears on ${dupes.length} rows` +
        (isos.size === dupes.length
          ? ` under different isometrics (${[...isos].join(', ')}). Both are kept, keyed by ` +
            `isometric and flange together, but the numbering is ambiguous on the log itself.`
          : ` under the same isometric. One of them is a duplicate entry.`),
    })
  }

  // The log's own header count against what the rows actually carry. In
  // Greeley these disagree, and the disagreement is a finding rather than
  // something to reconcile silently.
  const inspectedRows = parsed.filter((p) => p.inspectionDate).length
  const populatedInspectionCells = parsed.filter((p) => p.inspectionDate).length +
    issues.filter((i) => i.column === 'Inspection Date').length
  if (populatedInspectionCells !== inspectedRows) {
    issues.push({ severity: 'info', sheet: sheetName, row: 0,
      message: `${populatedInspectionCells} connections have something in the inspection date ` +
        `column, but only ${inspectedRows} of those parse as a date. The other ` +
        `${populatedInspectionCells - inspectedRows} were inspected but carry no usable date.` })
  }
  if (headerTotals.inspected != null && headerTotals.inspected !== inspectedRows) {
    issues.push({ severity: 'info', sheet: sheetName, row: 0,
      message: `The log header reports ${headerTotals.inspected} connections inspected, but ` +
        `${inspectedRows} rows carry an inspection date. The header figure is stale.` })
  }
  if (headerTotals.totalFlanges != null && headerTotals.totalFlanges !== parsed.length) {
    issues.push({ severity: 'info', sheet: sheetName, row: 0,
      message: `The log header reports ${headerTotals.totalFlanges} total flanges; ${parsed.length} rows parsed.` })
  }

  const rosterIds = roster.map((r) => r.wrenchId)
  const proposedWrenches = [...usage.entries()]
    .filter(([id]) => !rosterIds.includes(id))
    .map(([wrenchId, occurrences]) => ({ wrenchId, occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences)
  for (const p of proposedWrenches) {
    const suggestion = suggestWrenchTypo(p.wrenchId, rosterIds)
    issues.push({ severity: 'warning', sheet: sheetName, row: 0, column: 'Wrench ID #',
      message: `Wrench ${p.wrenchId} is used on ${p.occurrences} connection(s) but is absent from the ` +
        `log's roster block.` +
        (suggestion ? ` It differs from rostered wrench ${suggestion} by one character — confirm ` +
          `before creating it.` : ' Confirm it exists and upload its calibration certificate.') })
  }

  return {
    rows: parsed, issues, rejectedCount, sheetsParsed: [sheetName],
    roster, headerTotals,
    proposedWelders: [], proposedWrenches, proposedHeats: [],
  }
}

/**
 * Stable id, so a re-import updates rather than duplicates.
 *
 * Keyed on the isometric *and* the flange number, because the flange
 * number alone is not unique: the Greeley log reuses `377.1` on two
 * different isometrics with two different wrenches. Keying on the flange
 * alone would have let the second row silently overwrite the first, and
 * the book would have lost a connection without anyone being told.
 */
export function facilityTorqueRecordId(
  jobBookId: string, flange: string, isoNumber?: string | null,
): string {
  const iso = (isoNumber ?? '').trim().toUpperCase()
  const f = flange.trim().toUpperCase()
  return iso ? `${jobBookId}:tq:${iso}:${f}` : `${jobBookId}:tq:${f}`
}

export function toFacilityTorqueRecords(
  parsed: ParsedFacilityTorqueRow[],
  ctx: { jobBookId: string; wrenchIdByCode: Map<string, string> },
): TorqueConnection[] {
  return parsed.map((row) => ({
    id: facilityTorqueRecordId(ctx.jobBookId, row.isoFlangeNumber, row.isoNumber),
    jobBookId: ctx.jobBookId,
    isoFlangeNumber: row.isoFlangeNumber,
    isoNumber: row.isoNumber,
    flangePipeSize: row.flangePipeSize,
    boltDiameter: row.boltDiameter,
    boltCount: row.boltCount,
    requiredTorqueFtLb: row.requiredTorqueMin,
    requiredTorqueMinFtLb: row.requiredTorqueMin,
    requiredTorqueMaxFtLb: row.requiredTorqueMax,
    actualTorqueFtLb: row.actualTorque,
    wrenchId: row.wrenchIdRaw ? ctx.wrenchIdByCode.get(row.wrenchIdRaw) ?? null : null,
    wrenchIdRaw: row.wrenchIdRaw,
    cpTestOnFlange: false,
    torqueDate: row.torqueDate,
    employeeInitials: row.employeeInitials,
    inspectionDate: row.inspectionDate,
    inspectorInitials: row.inspectorInitials,
    status: 'recorded',
  }))
}
