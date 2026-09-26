/**
 * Planning a Noble flowline weld log.
 *
 * `weldLog.ts` has parsed this template correctly since the first build —
 * per sheet, line code from the sheet name, four welder passes, heat
 * numbers, duplicate detection scoped to the line. Nothing ever called
 * it. The one weld-log route in the application read every workbook with
 * the facility reader, which flattens the sheets, and a flowline log went
 * through it reporting `ok: true` while losing most of its welds.
 *
 * This is the missing middle: the Noble parse, expressed as the same
 * `WeldLogIngestPlan` the facility path produces, so the preview screen,
 * the commit and the provider all work on it unchanged.
 *
 * ## The two things that differ, and must
 *
 * **Weld identity is per line.** Weld 1 exists on FL-7 and on FL-8 and
 * they are different welds. The facility record id is derived from the
 * book and the weld number alone, which is right for a book numbered once
 * through and silently merges every line on a book that is not. The
 * database has said so all along: `unique (weld_line_id, weld_number)`.
 *
 * **The welder cell names four passes.** `AB/AB/CD/CD` is root, hot,
 * fill and cap, not a stamp. Attribution is per pass, so the register
 * check has to resolve each of them.
 */
import type { JobBookBundle, Welder, WeldLine } from '@/lib/domain/types'
import { parsePassAssignment, resolveWelder } from '@/lib/domain/welders'
import { recordId } from '@/lib/domain/recordId'
import type { OverviewFinding } from './weldLogOverview'
import {
  parseWeldLogSheets, toWeldRecords,
  type ParsedWeldRow, type WeldImportResult,
} from './weldLog'
import type { PlannedArea, PlannedStamp, WeldLogIngestPlan } from './weldLogIngest'
import type { WorkBook } from 'xlsx'

const norm = (s: string) => s.trim().toUpperCase()

/** Stable id so a re-import updates rather than duplicating. Scoped to the
 *  line, because the weld number alone does not identify a weld here. */
export function flowlineWeldRecordId(weldLineId: string, weldNumber: string): string {
  return recordId('weld', weldLineId, weldNumber)
}

export function parseFlowlineWorkbook(wb: WorkBook, welders: Welder[]): WeldImportResult {
  return parseWeldLogSheets(wb, { welders })
}

/**
 * Every welder named by any pass on the log, resolved against the
 * register.
 *
 * Reported as `stamps` so the preview screen — which knows nothing about
 * passes — still shows who welded this book and who is not on the
 * roster. The count is welds touched, not passes: a welder who ran root
 * and cap on the same joint welded it once.
 */
function passWelders(rows: ParsedWeldRow[], welders: Welder[]): PlannedStamp[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!row.welderPassAssignment) continue
    const named = new Set(
      parsePassAssignment(row.welderPassAssignment).filter((p): p is string => !!p),
    )
    for (const p of named) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([stamp, welds]) => {
      const welder = resolveWelder(stamp, welders)
      return {
        stamp, welds,
        welderId: welder?.id ?? null,
        action: (welder ? 'match' : 'unresolved') as PlannedStamp['action'],
      }
    })
    .sort((a, b) => b.welds - a.welds)
}

export function planFlowlineWeldLog(
  parsed: WeldImportResult,
  bundle: Pick<JobBookBundle, 'book' | 'welds' | 'weldLines' | 'welders'>,
  templateReason: string,
): WeldLogIngestPlan {
  const findings: OverviewFinding[] = []

  // -- sheets -> weld lines ---------------------------------------------
  const areas: PlannedArea[] = parsed.lines.map((line) => {
    const existing = bundle.weldLines.find((l) => norm(l.lineCode) === norm(line.lineCode))
    return {
      code: line.lineCode,
      weldLineId: existing?.id ?? null,
      action: existing ? 'match' : 'create',
      weldCount: line.rowCount,
    }
  })

  const stamps = passWelders(parsed.rows, bundle.welders)

  // -- welds: create or update ------------------------------------------
  //
  // Keyed on line and weld number together. Keyed on the number alone,
  // every line's weld 1 is the same weld, and a 38-sheet book reports a
  // few dozen welds where it has twelve hundred.
  const lineIdByCode = new Map(areas.map((a) => [norm(a.code), a.weldLineId]))
  const existing = new Set(
    bundle.welds.map((w) => {
      const line = bundle.weldLines.find((l) => l.id === w.weldLineId)
      return `${line ? norm(line.lineCode) : ''}|${norm(w.weldNumber)}`
    }),
  )
  let weldsToCreate = 0
  let weldsToUpdate = 0
  for (const row of parsed.rows) {
    if (existing.has(`${norm(row.sheet)}|${norm(row.weldNumber)}`)) weldsToUpdate += 1
    else weldsToCreate += 1
  }
  void lineIdByCode

  // -- findings ---------------------------------------------------------

  const unattributed = parsed.rows.filter((r) => !r.isNotUsed && !r.welderPassAssignment?.trim())
  if (unattributed.length > 0) {
    findings.push({
      ruleId: 'weldlog.weld_without_stamp',
      severity: 'critical',
      title: `${unattributed.length} weld${unattributed.length === 1 ? '' : 's'} name no welder`,
      detail:
        `${unattributed.slice(0, 12).map((r) => `${r.sheet} ${r.weldNumber}`).join(', ')}` +
        `${unattributed.length > 12 ? ` and ${unattributed.length - 12} more` : ''}. ` +
        `§11.1 makes this Critical in its own right: with no attribution neither the welder's ` +
        `qualification nor the weld's inspection requirement can be verified, and no later ` +
        `record can supply what the log did not capture.`,
      subject: 'Welder',
    })
  }

  const unresolved = stamps.filter((s) => s.action === 'unresolved')
  if (unresolved.length > 0) {
    findings.push({
      ruleId: 'weldlog.stamp_not_in_register',
      severity: 'critical',
      title:
        `${unresolved.length} welder${unresolved.length === 1 ? '' : 's'} on this log ` +
        `${unresolved.length === 1 ? 'is' : 'are'} not in the welder register`,
      detail:
        unresolved.map((s) => `${s.stamp} (${s.welds} weld${s.welds === 1 ? '' : 's'})`).join(', ') +
        `. §9.1: identity resolves to a register entry or it is not identity. Import the ` +
        `welder qualifications first, or add these welders, so each pass can be attributed.`,
      subject: 'Welder register',
    })
  }

  // Heat numbers are why a flowline log exists: they are the only link
  // from a weld to the mill certificate for the pipe in it.
  const noHeat = parsed.rows.filter((r) => !r.isNotUsed && r.heatNumbers.length === 0)
  if (noHeat.length > 0) {
    findings.push({
      ruleId: 'weldlog.weld_without_heat',
      severity: 'warning',
      title: `${noHeat.length} weld${noHeat.length === 1 ? '' : 's'} record no heat number`,
      detail:
        `${noHeat.slice(0, 12).map((r) => `${r.sheet} ${r.weldNumber}`).join(', ')}` +
        `${noHeat.length > 12 ? ` and ${noHeat.length - 12} more` : ''}. ` +
        `The heat number is the only link from a weld to the mill certificate for the pipe ` +
        `in it, so §15 cannot evidence the material in these joints.`,
      subject: 'Heat number',
    })
  }

  return {
    template: 'flowline',
    templateReason,
    format: 'xlsx',
    sheetsParsed: parsed.sheetsParsed,
    parsedRows: parsed.rows.length,
    rejectedRows: parsed.rejectedCount,
    weldsToCreate,
    weldsToUpdate,
    areas,
    stamps,
    findings,
    issues: [],
    rows: [],
    flowlineRows: parsed.rows,
    flowlineLines: parsed.lines,
    proposedHeats: parsed.proposedHeats,
  }
}

/**
 * The lines and welds a flowline plan writes.
 *
 * Returns the same shape the facility path does, so the commit in either
 * provider is unchanged — it takes weld lines and welds and knows nothing
 * about which template produced them.
 */
export function rowsForFlowlinePlan(
  plan: WeldLogIngestPlan,
  bundle: Pick<JobBookBundle, 'book' | 'welders' | 'cwis' | 'weldLines'>,
  opts: { enteredAt: string; entrySource: 'field_entry' | 'bulk_import'; newId: () => string },
): { weldLines: WeldLine[]; welds: ReturnType<typeof toWeldRecords> } {
  const jobBookId = bundle.book.id
  const weldLines: WeldLine[] = []
  const lineIdByCode = new Map<string, string>()

  const headerByCode = new Map(
    (plan.flowlineLines ?? []).map((l) => [norm(l.lineCode), l]),
  )

  for (const area of plan.areas) {
    if (area.action === 'match' && area.weldLineId) {
      lineIdByCode.set(area.code.trim(), area.weldLineId)
      continue
    }
    const id = opts.newId()
    lineIdByCode.set(area.code.trim(), id)
    const header = headerByCode.get(norm(area.code))
    weldLines.push({
      id,
      jobBookId,
      lineCode: area.code,
      lineDescription: null,
      sortOrder: weldLines.length,
      // The distinction the schema already carries: a flowline book is
      // grouped by line, not by construction area.
      groupingKind: 'line',
      expectedWeldCount: area.weldCount,
      facilityName: header?.facilityName ?? null,
      drillPadName: header?.drillPadName ?? null,
      wellName: header?.wellName ?? null,
      operatorPic: header?.operatorPic ?? null,
      weldingCompany: header?.weldingCompany ?? null,
      pipeSize: header?.pipeSize ?? null,
      pipeSchedule: header?.pipeSchedule ?? null,
      pipeGrade: header?.pipeGrade ?? null,
      serviceType: header?.serviceType ?? null,
    } as WeldLine)
  }

  const welds = toWeldRecords(plan.flowlineRows ?? [], {
    jobBookId,
    lineIdByCode,
    welders: bundle.welders,
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
