/**
 * Facility weld log importer.
 *
 * Three differences from the flowline template drive everything here:
 *
 *   · One welder stamp per weld, not four pass assignments.
 *   · Work is organised by construction area and equipment tag, not by line.
 *   · Each weld carries the pipe data — size/schedule, grade, design
 *     pressure — from which its inspection obligation is *derived*, rather
 *     than inheriting a flat job-wide percentage.
 *
 * The tier is recomputed here rather than read from the workbook's own
 * column. Trusting the spreadsheet's arithmetic would make this importer a
 * transcriber; recomputing makes it a check, and `verifyAgainstWorkbook`
 * reports any cell where the two disagree.
 */
import type { NdtMethod, PassFail, Weld } from '@/lib/domain/types'
import { parseLooseDate } from '@/lib/domain/dates'
import { recordId } from '@/lib/domain/recordId'
import {
  computeSmys, type NpsDimension, type SmysResult, type TierRule,
} from '@/lib/domain/engineering'
import type { ImportPreview, RowIssue } from './types'

export interface ParsedFacilityWeldRow {
  rowNumber: number
  weldNumber: string
  weldDate: string | null
  welderStamp: string | null
  jointType: string | null
  constructionArea: string | null
  equipmentTag: string | null
  isometricNumber: string | null
  pipeSizeSchedule: string | null
  pipeGrade: string | null
  designPressurePsi: number | null
  cwiInitials: string | null
  cwiVisualResult: PassFail | null
  visualInspectionDate: string | null
  ndtMethod: NdtMethod | null
  ndtTicketNumber: string | null
  ndtResult: PassFail | null
  pressureTestRef: string | null
  /** The workbook's own % SMYS and tier, kept for cross-checking only. */
  workbookPctSmys: number | null
  workbookTier: string | null
  /** Recomputed from pipe engineering. */
  smys: SmysResult
}

type Field = keyof ParsedFacilityWeldRow

const COLUMN_MAP: Record<string, Field> = {
  'weld number': 'weldNumber', 'weld #': 'weldNumber', 'weld no': 'weldNumber',
  'weld id': 'weldNumber', 'weld': 'weldNumber',
  'date': 'weldDate', 'weld date': 'weldDate',
  'welder': 'welderStamp', 'welder stamp': 'welderStamp', 'welder id': 'welderStamp',
  'stamp': 'welderStamp', 'welder initials': 'welderStamp',
  'joint type': 'jointType', 'type': 'jointType', 'weld type': 'jointType',
  'area': 'constructionArea', 'construction area': 'constructionArea',
  'const area': 'constructionArea', 'area #': 'constructionArea',
  'equipment tag': 'equipmentTag', 'tag': 'equipmentTag', 'equipment': 'equipmentTag',
  'iso': 'isometricNumber', 'iso number': 'isometricNumber', 'iso #': 'isometricNumber',
  'isometric': 'isometricNumber', 'isometric number': 'isometricNumber',
  'line number': 'isometricNumber', 'line #': 'isometricNumber',
  'pipe size': 'pipeSizeSchedule', 'pipe size/schedule': 'pipeSizeSchedule',
  'size/schedule': 'pipeSizeSchedule', 'pipe size and schedule': 'pipeSizeSchedule',
  'size': 'pipeSizeSchedule', 'pipe size (in)': 'pipeSizeSchedule',
  'schedule': 'pipeSizeSchedule', 'pipe schedule': 'pipeSizeSchedule',
  'grade': 'pipeGrade', 'pipe grade': 'pipeGrade', 'material grade': 'pipeGrade',
  'design pressure': 'designPressurePsi', 'design pressure (psi)': 'designPressurePsi',
  'design psi': 'designPressurePsi', 'pressure': 'designPressurePsi',
  'mawp': 'designPressurePsi',
  'cwi': 'cwiInitials', 'cwi initials': 'cwiInitials', 'inspector': 'cwiInitials',
  'visual': 'cwiVisualResult', 'visual result': 'cwiVisualResult',
  'cwi visual': 'cwiVisualResult', 'visual inspection': 'cwiVisualResult',
  'visual date': 'visualInspectionDate', 'inspection date': 'visualInspectionDate',
  'ndt': 'ndtMethod', 'ndt method': 'ndtMethod', 'nde method': 'ndtMethod',
  'method': 'ndtMethod', 'ndt type': 'ndtMethod',
  'ndt ticket': 'ndtTicketNumber', 'ticket': 'ndtTicketNumber',
  'ticket number': 'ndtTicketNumber', 'ndt ticket #': 'ndtTicketNumber',
  'report #': 'ndtTicketNumber',
  'ndt result': 'ndtResult', 'nde result': 'ndtResult', 'result': 'ndtResult',
  'pressure test': 'pressureTestRef', 'test #': 'pressureTestRef',
  'pressure test #': 'pressureTestRef', 'hydro test': 'pressureTestRef',
  '% smys': 'workbookPctSmys', 'percent smys': 'workbookPctSmys',
  '% of smys': 'workbookPctSmys', 'smys %': 'workbookPctSmys',
  'required inspection': 'workbookTier', 'inspection requirement': 'workbookTier',
  'required inspection tier': 'workbookTier', 'tier': 'workbookTier',
}

const norm = (v: unknown) => (v == null ? '' : String(v).trim())
const normKey = (v: unknown) => norm(v).toLowerCase().replace(/\s+/g, ' ').replace(/[:.]+$/, '')

function parsePassFail(v: unknown): PassFail | null {
  const s = normKey(v)
  if (!s) return null
  if (/^(p|pass|passed|acc|accept|accepted|ok|yes)$/.test(s)) return 'Pass'
  if (/^(f|fail|failed|rej|reject|rejected)$/.test(s)) return 'Fail'
  return null
}

function parseMethod(v: unknown): NdtMethod | null {
  const s = normKey(v).toUpperCase()
  if (!s || s === '--' || s === 'N/A' || s === 'NONE') return null
  return (['RT', 'PT', 'MT', 'UT'] as const).find((m) => s.includes(m)) ?? null
}

function parseNumber(v: unknown): number | null {
  const s = norm(v)
  if (!s) return null
  const pctForm = s.match(/^([\d.]+)\s*%$/)
  if (pctForm) return Number(pctForm[1]) / 100
  const n = Number(s.replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Locate the header row. The Greeley log holds its data in an Excel Table
 * (`Table1`) starting partway down the sheet, so a fixed offset would be
 * wrong the moment someone inserts a note above it.
 */
function locateHeader(rows: unknown[][]): { headerRow: number; columns: Map<number, Field> } {
  let best = { headerRow: -1, columns: new Map<number, Field>() }
  for (let r = 0; r < Math.min(60, rows.length); r++) {
    const columns = new Map<number, Field>()
    ;(rows[r] ?? []).forEach((cell, c) => {
      const field = COLUMN_MAP[normKey(cell)]
      // First header wins: a log with both "Pipe Size" and "Schedule"
      // should not have the second silently overwrite the first.
      if (field && ![...columns.values()].includes(field)) columns.set(c, field)
    })
    if (columns.size > best.columns.size) best = { headerRow: r, columns }
  }
  return best
}

export interface FacilityWeldImportResult extends ImportPreview<ParsedFacilityWeldRow> {
  constructionAreas: string[]
  isometrics: string[]
  welderStamps: { stamp: string; welds: number; nde: number }[]
  /** Rows where the recomputed tier disagrees with the workbook's own. */
  tierDisagreements: { rowNumber: number; weldNumber: string; workbook: string; computed: string }[]
}

export function parseFacilityWeldRows(
  rows: unknown[][],
  opts: {
    sheetName?: string
    tierRules?: TierRule[]
    npsTable?: NpsDimension[]
    /** Used where a weld row carries no design pressure of its own. */
    defaultDesignPressurePsi?: number | null
  } = {},
): FacilityWeldImportResult {
  const sheetName = opts.sheetName ?? 'Weld Log'
  // No bands unless the job supplies them: % of SMYS is computed either
  // way, but a tier is only assigned where one is actually specified.
  const rules = opts.tierRules ?? []
  const { headerRow, columns } = locateHeader(rows)
  const issues: RowIssue[] = []
  const parsed: ParsedFacilityWeldRow[] = []
  const tierDisagreements: FacilityWeldImportResult['tierDisagreements'] = []
  let rejectedCount = 0

  if (headerRow < 0 || columns.size < 4) {
    return {
      rows: [], issues: [{ severity: 'error', sheet: sheetName, row: 1,
        message: 'No weld log column header found. Expected a row containing at least ' +
          '"Weld Number", "Date" and "Welder".' }],
      rejectedCount: 0, sheetsParsed: [], constructionAreas: [], isometrics: [],
      welderStamps: [], tierDisagreements: [],
      proposedWelders: [], proposedWrenches: [], proposedHeats: [],
    }
  }

  const stampCounts = new Map<string, { welds: number; nde: number }>()
  const areas = new Set<string>()
  const isos = new Set<string>()
  const seen = new Set<string>()

  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = rows[r] ?? []
    const raw: Record<string, unknown> = {}
    for (const [idx, field] of columns) raw[field] = cells[idx]

    const weldNumber = norm(raw.weldNumber)
    if (!weldNumber) continue
    const rowNumber = r + 1

    if (seen.has(weldNumber)) {
      issues.push({ severity: 'error', sheet: sheetName, row: rowNumber, column: 'Weld Number',
        message: `Weld ${weldNumber} appears more than once.` })
      rejectedCount++
      continue
    }
    seen.add(weldNumber)

    const weldDate = parseLooseDate(raw.weldDate)
    if (raw.weldDate != null && norm(raw.weldDate) !== '' && !weldDate) {
      issues.push({ severity: 'error', sheet: sheetName, row: rowNumber, column: 'Date',
        message: `Cannot read "${norm(raw.weldDate)}" as a date.` })
      rejectedCount++
      continue
    }

    const welderStamp = norm(raw.welderStamp) || null
    if (!welderStamp) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber, column: 'Welder',
        message: `Weld ${weldNumber} carries no welder stamp, so it cannot be attributed or ` +
          `checked against a qualification.` })
    }

    const area = norm(raw.constructionArea) || null
    if (area) areas.add(area)
    const iso = norm(raw.isometricNumber) || null
    if (iso) isos.add(iso.toUpperCase())

    const designPressure = parseNumber(raw.designPressurePsi) ?? opts.defaultDesignPressurePsi ?? null
    const smys = computeSmys(
      {
        pipeSizeSchedule: norm(raw.pipeSizeSchedule) || null,
        pipeGrade: norm(raw.pipeGrade) || null,
        designPressurePsi: designPressure,
      },
      rules, opts.npsTable,
    )
    if (smys.uncomputableReason) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber,
        message: `Weld ${weldNumber}: % of SMYS cannot be computed — ${smys.uncomputableReason}.` })
    }

    const workbookPctSmys = parseNumber(raw.workbookPctSmys)
    const workbookTier = norm(raw.workbookTier) || null
    // Four decimal places, as the task requires: a spreadsheet rounds for
    // display, and a mismatch at the fifth place is formatting, not error.
    if (workbookPctSmys != null && smys.pctSmys != null &&
        Math.abs(workbookPctSmys - smys.pctSmys) > 0.00005) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber, column: '% SMYS',
        message: `Weld ${weldNumber}: workbook says ${(workbookPctSmys * 100).toFixed(4)}% SMYS, ` +
          `recomputed ${(smys.pctSmys * 100).toFixed(4)}%.` })
    }
    if (workbookTier && smys.tier && normKey(workbookTier) !== normKey(smys.tier)) {
      tierDisagreements.push({
        rowNumber, weldNumber, workbook: workbookTier, computed: smys.tier,
      })
    }

    const ndtMethod = parseMethod(raw.ndtMethod)
    const ndtResult = parsePassFail(raw.ndtResult)
    const ticket = norm(raw.ndtTicketNumber) || null
    if (ndtMethod && (!ticket || !ndtResult)) {
      issues.push({ severity: 'warning', sheet: sheetName, row: rowNumber,
        message: `Weld ${weldNumber} records a ${ndtMethod} examination but is missing ` +
          `${!ticket ? 'a ticket number' : ''}${!ticket && !ndtResult ? ' and ' : ''}` +
          `${!ndtResult ? 'a result' : ''}.` })
    }

    if (welderStamp) {
      const e = stampCounts.get(welderStamp) ?? { welds: 0, nde: 0 }
      e.welds++
      if (ndtMethod) e.nde++
      stampCounts.set(welderStamp, e)
    }

    parsed.push({
      rowNumber, weldNumber, weldDate, welderStamp,
      jointType: norm(raw.jointType) || null,
      constructionArea: area,
      equipmentTag: norm(raw.equipmentTag) || null,
      isometricNumber: iso,
      pipeSizeSchedule: norm(raw.pipeSizeSchedule) || null,
      pipeGrade: norm(raw.pipeGrade) || null,
      designPressurePsi: designPressure,
      cwiInitials: norm(raw.cwiInitials) || null,
      cwiVisualResult: parsePassFail(raw.cwiVisualResult),
      visualInspectionDate: parseLooseDate(raw.visualInspectionDate),
      ndtMethod, ndtTicketNumber: ticket, ndtResult,
      pressureTestRef: norm(raw.pressureTestRef) || null,
      workbookPctSmys, workbookTier, smys,
    })
  }

  return {
    rows: parsed, issues, rejectedCount, sheetsParsed: [sheetName],
    constructionAreas: [...areas].sort(),
    isometrics: [...isos].sort(),
    welderStamps: [...stampCounts.entries()]
      .map(([stamp, v]) => ({ stamp, ...v }))
      .sort((a, b) => b.welds - a.welds),
    tierDisagreements,
    proposedWelders: [...stampCounts.entries()]
      .map(([nameOrInitials, v]) => ({ nameOrInitials, occurrences: v.welds })),
    proposedWrenches: [], proposedHeats: [],
  }
}

/**
 * Stable id so a re-import updates rather than duplicates.
 *
 * Hashed into a UUID rather than being the natural key as text: `weld.id`
 * is a uuid column and `<book>:weld:1140` is not one, so the text form
 * could never be written to the database at all.
 */
export function facilityWeldRecordId(jobBookId: string, weldNumber: string): string {
  return recordId('weld', jobBookId, weldNumber)
}

export function toFacilityWeldRecords(
  parsed: ParsedFacilityWeldRow[],
  ctx: {
    jobBookId: string
    areaLineIdByCode: Map<string, string>
    welderIdByStamp: Map<string, string>
    cwiIdByInitials: Map<string, string>
  },
): Weld[] {
  return parsed.map((row, i) => ({
    id: facilityWeldRecordId(ctx.jobBookId, row.weldNumber),
    weldLineId: row.constructionArea
      ? ctx.areaLineIdByCode.get(row.constructionArea)
          ?? recordId('weld_line', ctx.jobBookId, 'Unassigned')
      : recordId('weld_line', ctx.jobBookId, 'Unassigned'),
    jobBookId: ctx.jobBookId,
    weldNumber: row.weldNumber,
    sortOrder: i,
    weldDate: row.weldDate,
    welderPassAssignment: null,
    rootWelderId: null, hotWelderId: null, fillWelderId: null, capWelderId: null,
    welderStamp: row.welderStamp,
    welderId: row.welderStamp
      ? ctx.welderIdByStamp.get(row.welderStamp.toUpperCase()) ?? null
      : null,
    jointType: row.jointType === 'Butt' || row.jointType === 'O-let'
      || row.jointType === 'Socket' || row.jointType === 'Branch'
      ? row.jointType
      : row.jointType?.toLowerCase().includes('let') ? 'O-let'
      : row.jointType?.toLowerCase().startsWith('sock') ? 'Socket'
      : row.jointType?.toLowerCase().startsWith('butt') ? 'Butt'
      : null,
    componentDescription: row.equipmentTag,
    partLength: null,
    heatNumbers: [],
    cwiInitials: row.cwiInitials,
    cwiId: row.cwiInitials ? ctx.cwiIdByInitials.get(row.cwiInitials.toUpperCase()) ?? null : null,
    cwiVisualResult: row.cwiVisualResult,
    visualInspectionDate: row.visualInspectionDate,
    ndtCompany: null,
    xrayNumber: row.ndtMethod === 'RT' ? row.ndtTicketNumber : null,
    ndtTicketNumber: row.ndtTicketNumber,
    ndtMethod: row.ndtMethod,
    ndtResult: row.ndtResult,
    ndtReportId: null,
    status: row.ndtResult ? 'ndt_complete' : row.cwiVisualResult ? 'visual_complete' : 'welded',
    comments: null,
    constructionArea: row.constructionArea,
    equipmentTag: row.equipmentTag,
    isometricNumber: row.isometricNumber,
    pressureTestRef: row.pressureTestRef,
    pipeSizeSchedule: row.pipeSizeSchedule,
    pipeGrade: row.pipeGrade,
    designPressurePsi: row.designPressurePsi,
  }))
}
