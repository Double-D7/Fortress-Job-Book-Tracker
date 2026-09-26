/**
 * Ingesting the Detailed Weld Log — Appendix A §12.
 *
 * §12 carries the heaviest weight on a facility book (20 of 100) and it is
 * the section every other integrity claim resolves to: a weld's welder, its
 * date, its heat, its inspection. Until now the application could hold the
 * log as a FILE and know nothing about the welds in it.
 *
 * ONE PARSER, TWO FILE FORMATS. `parseFacilityWeldRows` takes a grid, so a
 * PDF export is read by recovering the grid (`pdfGrid`) rather than by a
 * second parser that would have to be kept in step with the first and
 * would not be. The workbook path and the PDF path produce the same rows
 * and are checked by the same code.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OVERVIEW IMPORT. The overview sheet
 * is a summary: ten rows, and every one of them a person. The detailed log
 * is the population — twelve hundred rows on DP-318 — so the questions are
 * about coverage and attribution rather than about identity. Which welds
 * carry no stamp. Which stamps resolve to nobody in the register. Which
 * welds were made on a date the welder's qualification did not cover,
 * which is the check that needs BOTH imports and is the reason to do them
 * in this order.
 */

import * as XLSX from 'xlsx'
import type {
  IsoDate, JobBookBundle, Weld, WeldLine,
} from '@/lib/domain/types'
import { qualificationOn } from '@/lib/domain/welders'
import { extractPdfText, pdfGridAllPages } from './pdfText'
import {
  parseFacilityWeldRows, toFacilityWeldRecords,
  type FacilityWeldImportResult, type ParsedFacilityWeldRow,
} from './facilityWeldLog'
import type { OverviewFinding } from './weldLogOverview'
import type { ParsedWeldRow, WeldImportResult } from './weldLog'
import { rowsForFlowlinePlan } from './flowlineWeldLog'

// ---------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------

export interface WeldLogGrid {
  grid: unknown[][]
  format: 'xlsx' | 'pdf'
  /** Sheet names for a workbook; page count for a PDF. */
  sheetsParsed: string[]
  /**
   * Each sheet on its own, in workbook order. Empty for a PDF.
   *
   * The flat grid above is right for a facility log, which is one table
   * however many tabs it is split across. It is wrong for the Noble
   * flowline template, where each sheet is a line, the sheet *name* is
   * the only place the line code appears, and each sheet repeats the job
   * header block — so flattening reads the second sheet's header as data
   * and throws every line code away.
   */
  sheets: { name: string; grid: unknown[][] }[]
  error?: string
}

const isPdf = (b: Uint8Array) =>
  b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 // %PDF

export function readWeldLogGrid(bytes: Uint8Array, filename = ''): WeldLogGrid {
  if (isPdf(bytes) || /\.pdf$/i.test(filename)) {
    const extracted = extractPdfText(bytes)
    if (extracted.pages.length === 0) {
      return {
        grid: [], format: 'pdf', sheetsParsed: [], sheets: [],
        error: extracted.undecodable > 0
          ? 'No text could be read from this PDF. It is either a scan or uses an encoding this reader does not handle, so the welds in it cannot be imported — file it as a document instead.'
          : 'No text found in this PDF.',
      }
    }
    return {
      grid: pdfGridAllPages(extracted),
      format: 'pdf',
      sheetsParsed: extracted.pages.map((p) => `page ${p.index + 1}`),
      sheets: [],
    }
  }

  try {
    const wb = XLSX.read(bytes, { type: 'array', cellDates: false })
    // Every sheet, concatenated. A weld log is routinely split by area or
    // by month across tabs, and the parser skips a repeated header row.
    const grid: unknown[][] = []
    const sheets: { name: string; grid: unknown[][] }[] = []
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name]
      if (!sheet) continue
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
      sheets.push({ name, grid: rows })
      grid.push(...rows)
    }
    return { grid, format: 'xlsx', sheetsParsed: wb.SheetNames, sheets }
  } catch {
    return {
      grid: [], format: 'xlsx', sheetsParsed: [], sheets: [],
      error: 'That file could not be read as a workbook or a PDF.',
    }
  }
}

// ---------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------

export interface PlannedArea {
  code: string
  weldLineId: string | null
  action: 'create' | 'match'
  weldCount: number
}

export interface PlannedStamp {
  stamp: string
  welds: number
  welderId: string | null
  action: 'match' | 'unresolved'
}

export interface WeldLogIngestPlan {
  /**
   * Which of the two weld log templates this workbook is.
   *
   * Carried on the plan rather than inferred again downstream, so the
   * preview a person confirms and the rows the commit writes can never
   * disagree about what was read.
   */
  template: 'facility' | 'flowline'
  /** Why the reader decided that, in a person's words. */
  templateReason: string
  format: 'xlsx' | 'pdf'
  sheetsParsed: string[]
  /** Rows the parser accepted. */
  parsedRows: number
  rejectedRows: number
  weldsToCreate: number
  weldsToUpdate: number
  areas: PlannedArea[]
  stamps: PlannedStamp[]
  findings: OverviewFinding[]
  /** Parser-level row issues, surfaced as they are. */
  issues: FacilityWeldImportResult['issues']
  rows: ParsedFacilityWeldRow[]

  // -- flowline only ---------------------------------------------------
  /** The Noble parse. Empty on a facility log. */
  flowlineRows?: ParsedWeldRow[]
  /** The job header block read off each line sheet. */
  flowlineLines?: WeldImportResult['lines']
  /** Every heat number the log names — the link to §15. */
  proposedHeats?: string[]
}

const UNKNOWN_AREA = 'Unassigned'

export function planWeldLogIngest(
  parsed: FacilityWeldImportResult,
  bundle: Pick<JobBookBundle, 'book' | 'welds' | 'weldLines' | 'welders' | 'welderQualifications'>,
  format: 'xlsx' | 'pdf' = 'xlsx',
  templateReason = 'Read as a facility log.',
): WeldLogIngestPlan {
  const findings: OverviewFinding[] = []
  const norm = (s: string) => s.trim().toUpperCase()

  // -- construction areas -> weld lines ---------------------------------
  const areaCounts = new Map<string, number>()
  for (const row of parsed.rows) {
    const code = row.constructionArea?.trim() || UNKNOWN_AREA
    areaCounts.set(code, (areaCounts.get(code) ?? 0) + 1)
  }
  const areas: PlannedArea[] = [...areaCounts.entries()].map(([code, weldCount]) => {
    const existing = bundle.weldLines.find((l) => norm(l.lineCode) === norm(code))
    return {
      code,
      weldLineId: existing?.id ?? null,
      action: existing ? 'match' : 'create',
      weldCount,
    }
  })

  // -- welder stamps -> the register ------------------------------------
  const stamps: PlannedStamp[] = parsed.welderStamps.map((s) => {
    const welder = bundle.welders.find((w) => norm(w.initials) === norm(s.stamp))
    return {
      stamp: s.stamp,
      welds: s.welds,
      welderId: welder?.id ?? null,
      action: welder ? 'match' : 'unresolved',
    }
  })

  // -- welds: create or update ------------------------------------------
  const existingByNumber = new Map(bundle.welds.map((w) => [norm(w.weldNumber), w]))
  let weldsToCreate = 0
  let weldsToUpdate = 0
  for (const row of parsed.rows) {
    if (existingByNumber.has(norm(row.weldNumber))) weldsToUpdate += 1
    else weldsToCreate += 1
  }

  // -- findings ---------------------------------------------------------

  // §11.1: a weld with no welder stamp. Attribution and inspection
  // adequacy are both unverifiable, which is why it sits above the general
  // blank-field rule.
  const unstamped = parsed.rows.filter((r) => !r.welderStamp?.trim())
  if (unstamped.length > 0) {
    findings.push({
      ruleId: 'weldlog.weld_without_stamp',
      severity: 'critical',
      title: `${unstamped.length} weld${unstamped.length === 1 ? '' : 's'} carry no welder stamp`,
      detail:
        `${unstamped.slice(0, 12).map((r) => r.weldNumber).join(', ')}` +
        `${unstamped.length > 12 ? ` and ${unstamped.length - 12} more` : ''}. ` +
        `§11.1 makes this Critical in its own right: with no attribution neither the welder's ` +
        `qualification nor the weld's inspection requirement can be verified, and no later ` +
        `record can supply what the log did not capture.`,
      subject: 'Welder stamp',
    })
  }

  // §9.1: identity resolves to a register entry, or it is not identity.
  const unresolved = stamps.filter((s) => s.action === 'unresolved')
  if (unresolved.length > 0) {
    findings.push({
      ruleId: 'weldlog.stamp_not_in_register',
      severity: 'critical',
      title:
        `${unresolved.length} welder stamp${unresolved.length === 1 ? '' : 's'} on this log ` +
        `${unresolved.length === 1 ? 'is' : 'are'} not in the welder register`,
      detail:
        unresolved.map((s) => `${s.stamp} (${s.welds} weld${s.welds === 1 ? '' : 's'})`).join(', ') +
        `. §9.1 keys the register on the stamp, so a stamp that resolves to nobody leaves those ` +
        `welds unattributable. Import the Weld Log Overview Sheet first, or add the welder to ` +
        `the register, before committing these rows.`,
      subject: 'Welder register',
    })
  }

  // The check that needed both imports.
  const expired: string[] = []
  const unverifiable = new Set<string>()
  for (const row of parsed.rows) {
    if (!row.weldDate || !row.welderStamp) continue
    const welder = bundle.welders.find((w) => norm(w.initials) === norm(row.welderStamp!))
    if (!welder) continue
    const { verdict } = qualificationOn(welder.id, row.weldDate, bundle.welderQualifications)
    if (verdict === 'expired' || verdict === 'not_yet' || verdict === 'no_record') {
      expired.push(`${row.weldNumber} (${row.welderStamp}, ${row.weldDate})`)
    } else if (verdict === 'unverifiable') {
      unverifiable.add(row.welderStamp)
    }
  }
  if (expired.length > 0) {
    findings.push({
      ruleId: 'weldlog.weld_outside_qualification',
      severity: 'critical',
      title:
        expired.length === 1
          ? `1 weld falls outside its welder's qualification`
          : `${expired.length} welds fall outside their welder's qualification`,
      detail:
        `${expired.slice(0, 12).join(', ')}${expired.length > 12 ? ` and ${expired.length - 12} more` : ''}. ` +
        `§11.1: a weld performed on a date when the welder held no valid Welder Performance ` +
        `Qualification is a Critical finding.`,
      subject: 'Welder qualification',
    })
  }
  if (unverifiable.size > 0) {
    findings.push({
      ruleId: 'weldlog.qualification_currency_unverifiable',
      severity: 'warning',
      title:
        `Qualification currency cannot be confirmed for ${unverifiable.size} welder` +
        `${unverifiable.size === 1 ? '' : 's'} on this log`,
      detail:
        `${[...unverifiable].join(', ')}. The register holds an expiry for each — read off the ` +
        `overview sheet, which is all that sheet carries — but not the date the qualification ` +
        `was granted, so the window cannot be closed. This is not an expired qualification; ` +
        `filing the WPQ itself in section 6 resolves it.`,
      subject: 'Welder qualification',
    })
  }

  // Dates outside the construction window are a transcription smell, and
  // §11.1 makes a future-dated record Critical.
  const { constructionStart, constructionEnd, dataAsOfDate } = bundle.book
  const horizon = dataAsOfDate ?? constructionEnd ?? null
  const future = parsed.rows.filter((r) => r.weldDate && horizon && r.weldDate > horizon)
  if (future.length > 0) {
    findings.push({
      ruleId: 'weldlog.weld_dated_after_log',
      severity: 'critical',
      title: `${future.length} weld${future.length === 1 ? '' : 's'} dated after ${horizon}`,
      detail:
        `${future.slice(0, 12).map((r) => `${r.weldNumber} (${r.weldDate})`).join(', ')}` +
        `${future.length > 12 ? ` and ${future.length - 12} more` : ''}. ` +
        `The log itself is closed at ${horizon}, so these records post-date the document ` +
        `reporting them. §11.1 makes any record dated in the future a Critical finding.`,
      subject: 'Weld date',
    })
  }
  const early = parsed.rows.filter((r) => r.weldDate && constructionStart && r.weldDate < constructionStart)
  if (early.length > 0) {
    findings.push({
      ruleId: 'weldlog.weld_before_construction',
      severity: 'warning',
      title: `${early.length} weld${early.length === 1 ? '' : 's'} dated before construction began`,
      detail:
        `Construction starts ${constructionStart}; these rows are dated earlier. Either the ` +
        `construction window on the book is wrong or the dates are.`,
      subject: 'Weld date',
    })
  }

  // The parser's own tier cross-check: where the workbook's stated tier
  // disagrees with the one recomputed from pipe engineering.
  if (parsed.tierDisagreements.length > 0) {
    findings.push({
      ruleId: 'weldlog.tier_disagreement',
      severity: 'warning',
      title:
        `${parsed.tierDisagreements.length} row${parsed.tierDisagreements.length === 1 ? '' : 's'} ` +
        `state a tier that disagrees with the one computed from the pipe`,
      detail:
        parsed.tierDisagreements.slice(0, 8)
          .map((d) => `${d.weldNumber}: log says ${d.workbook}, computed ${d.computed}`)
          .join('; ') +
        `${parsed.tierDisagreements.length > 8 ? `, and ${parsed.tierDisagreements.length - 8} more` : ''}. ` +
        `The tier decides the inspection the weld owes, so a disagreement is a disagreement ` +
        `about whether the weld has been inspected enough.`,
      subject: 'Inspection tier',
    })
  }

  // No heat check here on purpose. §11.1 makes an installed heat with no
  // MTR Critical, and `ruleHeatWithoutMtr` already makes it — but from the
  // committed welds, which carry heat numbers. The facility weld log this
  // parser reads does not have a heat column, so a check written here
  // would iterate an empty set and report "no problems" about a question
  // it never asked. A check that cannot fire is worse than no check: it
  // reads on screen as a clean result.

  return {
    template: 'facility',
    templateReason,
    format,
    sheetsParsed: parsed.sheetsParsed,
    parsedRows: parsed.rows.length,
    rejectedRows: parsed.rejectedCount,
    weldsToCreate,
    weldsToUpdate,
    areas,
    stamps,
    findings,
    issues: parsed.issues,
    rows: parsed.rows,
  }
}

// ---------------------------------------------------------------------
// The rows a plan would write
// ---------------------------------------------------------------------

export interface WeldLogIngestRows {
  weldLines: WeldLine[]
  welds: Weld[]
}

export function rowsForWeldPlan(
  plan: WeldLogIngestPlan,
  bundle: Pick<JobBookBundle, 'book' | 'welders' | 'cwis' | 'weldLines'>,
  opts: { enteredAt: string; entrySource: 'field_entry' | 'bulk_import'; newId: () => string },
): WeldLogIngestRows {
  // The two templates produce the same rows for the commit and differ in
  // everything before it, so the branch belongs here — once, on the plan's
  // own statement of what it is — rather than in each provider.
  if (plan.template === 'flowline') return rowsForFlowlinePlan(plan, bundle, opts)

  const norm = (s: string) => s.trim().toUpperCase()
  const jobBookId = bundle.book.id

  const weldLines: WeldLine[] = []
  const areaLineIdByCode = new Map<string, string>()
  for (const area of plan.areas) {
    if (area.action === 'match' && area.weldLineId) {
      areaLineIdByCode.set(area.code, area.weldLineId)
      continue
    }
    const id = opts.newId()
    areaLineIdByCode.set(area.code, id)
    weldLines.push({
      id,
      jobBookId,
      lineCode: area.code,
      lineDescription: area.code === UNKNOWN_AREA
        ? 'Welds whose construction area the log did not state'
        : null,
      sortOrder: weldLines.length,
      groupingKind: 'construction_area',
      expectedWeldCount: area.weldCount,
    })
  }
  // A row with no area still needs a home, and putting it in a line named
  // for the gap keeps it countable instead of silently dropping it.
  if (!areaLineIdByCode.has(UNKNOWN_AREA)) {
    areaLineIdByCode.set(UNKNOWN_AREA, `${jobBookId}:area:unknown`)
  }

  const welds = toFacilityWeldRecords(plan.rows, {
    jobBookId,
    areaLineIdByCode,
    welderIdByStamp: new Map(bundle.welders.map((w) => [norm(w.initials), w.id])),
    cwiIdByInitials: new Map(
      bundle.cwis.filter((c) => c.initials).map((c) => [norm(c.initials!), c.id]),
    ),
  }).map((w) => ({
    ...w,
    // §8: the entry stamp is what makes this weld measurable against its
    // own weld date. Without it the row is evidence with no provenance.
    enteredAt: opts.enteredAt,
    entrySource: opts.entrySource,
    visualEnteredAt: w.visualInspectionDate ? opts.enteredAt : null,
  }))

  return { weldLines, welds }
}

export type { ParsedFacilityWeldRow, FacilityWeldImportResult }
export { parseFacilityWeldRows }
export type { IsoDate }
