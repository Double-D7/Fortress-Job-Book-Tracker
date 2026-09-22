/**
 * Ingesting the Torque Log — Appendix A §14.
 *
 * The third of the three field logs, and the last parser in this folder
 * that no code path in the running application could reach. It has been
 * complete and tested since the import work started; it was wired to the
 * offline seed script and to vitest, and to nothing a person could click.
 * A book created in the app therefore held zero torque connections no
 * matter what the crew filed, so §14 scored on document count alone and
 * every torque rule in the flags engine — wrench calibration, torque
 * within range, inspection coverage — ran over an empty set and reported
 * nothing wrong.
 *
 * ONE PARSER, TWO FILE FORMATS, same as §12: `parseFacilityTorqueRows`
 * takes a grid, so a PDF export is read by recovering the grid rather
 * than by a second parser nobody would keep in step.
 *
 * WHAT THIS IMPORT IS ACTUALLY FOR. A torque log's rows are cheap; its
 * WRENCH IDS are the compliance content. §11.1 makes a connection
 * torqued with an uncalibrated wrench a Critical finding, and the only
 * way to know is to resolve every id in the log against the controlled
 * register in §13. So the plan reports three populations and the gaps
 * between them — ids on the log's roster, ids actually used, and ids
 * holding a certificate — before a single row is written.
 *
 * A wrench id one character away from a rostered one is reported as a
 * probable typo and never corrected. Silently rewriting a compliance
 * record is worse than the typo: the typo is visible.
 */

import * as XLSX from 'xlsx'
import type { JobBookBundle, TorqueConnection, TorqueWrench } from '@/lib/domain/types'
import { isWrenchValidOn, suggestWrenchTypo } from '@/lib/domain/torque'
import { extractPdfText, pdfGridAllPages } from './pdfText'
import {
  parseFacilityTorqueRows, toFacilityTorqueRecords,
  type FacilityTorqueImportResult, type ParsedFacilityTorqueRow,
} from './facilityTorqueLog'
import type { OverviewFinding } from './weldLogOverview'

// ---------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------

export interface TorqueLogGrid {
  grid: (string | null)[][]
  format: 'xlsx' | 'pdf'
  /** Sheet names for a workbook; page labels for a PDF. */
  sheetsParsed: string[]
  error?: string
}

const isPdf = (b: Uint8Array) =>
  b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 // %PDF

/** The facility parser reads text cells, so everything arrives as text or
 *  null. Numbers are parsed from the string by the parser itself, which
 *  is what lets one code path read a workbook and a PDF alike. */
const asText = (grid: unknown[][]): (string | null)[][] =>
  grid.map((row) =>
    row.map((c) => (c == null || c === '' ? null : String(c))),
  )

export function readTorqueLogGrid(bytes: Uint8Array, filename = ''): TorqueLogGrid {
  if (isPdf(bytes) || /\.pdf$/i.test(filename)) {
    const extracted = extractPdfText(bytes)
    if (extracted.pages.length === 0) {
      return {
        grid: [], format: 'pdf', sheetsParsed: [],
        error: extracted.undecodable > 0
          ? 'No text could be read from this PDF. It is either a scan or uses an encoding this reader does not handle, so the connections in it cannot be imported — file it as a document instead.'
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
// Planning
// ---------------------------------------------------------------------

export interface PlannedWrench {
  /** The id exactly as the log writes it. Never normalised into the
   *  register's spelling — that would hide the mismatch this exists to
   *  surface. */
  code: string
  connections: number
  wrenchId: string | null
  action: 'match' | 'unresolved'
  /** A rostered id one edit away, where there is one. A suggestion for a
   *  person to confirm, never an auto-correction. */
  probableTypo?: string | null
  /** False where the wrench resolved but its certificate did not cover
   *  every date it was used on. */
  calibrationValid?: boolean
}

export interface TorqueLogIngestPlan {
  format: 'xlsx' | 'pdf'
  sheetsParsed: string[]
  parsedRows: number
  rejectedRows: number
  connectionsToCreate: number
  connectionsToUpdate: number
  wrenches: PlannedWrench[]
  findings: OverviewFinding[]
  issues: FacilityTorqueImportResult['issues']
  rows: ParsedFacilityTorqueRow[]
}

const norm = (s: string) => s.trim().toUpperCase()

export function planTorqueLogIngest(
  parsed: FacilityTorqueImportResult,
  bundle: Pick<JobBookBundle, 'book' | 'torqueConnections' | 'torqueWrenches' | 'certificates'>,
  format: 'xlsx' | 'pdf' = 'xlsx',
): TorqueLogIngestPlan {
  const findings: OverviewFinding[] = []
  const rows = parsed.rows

  // -- Existing connections, so an import states what it will change ----
  const existing = new Map(
    bundle.torqueConnections.map((c) => [
      `${norm(c.isoNumber ?? '')}|${norm(c.isoFlangeNumber)}`, c,
    ]),
  )
  let toCreate = 0
  let toUpdate = 0
  for (const r of rows) {
    const key = `${norm(r.isoNumber ?? '')}|${norm(r.isoFlangeNumber)}`
    if (existing.has(key)) toUpdate += 1
    else toCreate += 1
  }

  // -- Wrench ids: the compliance content of the whole log --------------
  const wrenchByCode = new Map(bundle.torqueWrenches.map((w) => [norm(w.wrenchId), w]))
  const knownIds = bundle.torqueWrenches.map((w) => w.wrenchId)

  const usage = new Map<string, ParsedFacilityTorqueRow[]>()
  for (const r of rows) {
    if (!r.wrenchIdRaw) continue
    const code = r.wrenchIdRaw.trim()
    const list = usage.get(code)
    if (list) list.push(r)
    else usage.set(code, [r])
  }

  const wrenches: PlannedWrench[] = []
  for (const [code, used] of [...usage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const match = wrenchByCode.get(norm(code))
    if (!match) {
      wrenches.push({
        code, connections: used.length, wrenchId: null, action: 'unresolved',
        probableTypo: suggestWrenchTypo(code, knownIds),
      })
      continue
    }
    wrenches.push({
      code,
      connections: used.length,
      wrenchId: match.id,
      action: 'match',
      calibrationValid: coveredThroughout(match, used),
    })
  }

  // -- Findings ---------------------------------------------------------
  const unresolved = wrenches.filter((w) => w.action === 'unresolved')
  if (unresolved.length > 0) {
    const affected = unresolved.reduce((a, w) => a + w.connections, 0)
    findings.push({
      ruleId: 'torque_import.wrench_not_in_register',
      severity: 'critical',
      title: `${unresolved.length} wrench id${unresolved.length === 1 ? '' : 's'} in the log are not in the controlled register`,
      detail:
        `${affected} connection${affected === 1 ? '' : 's'} were torqued with ` +
        `${unresolved.map((w) => w.code).join(', ')}, and §13 holds no wrench under ` +
        `${unresolved.length === 1 ? 'that id' : 'those ids'}. §11.1 makes a connection ` +
        `torqued with an uncalibrated wrench a Critical finding, and an id the register ` +
        `does not know cannot be shown to be calibrated at all. ` +
        (unresolved.some((w) => w.probableTypo)
          ? `Some look like typos of rostered ids — ` +
            unresolved.filter((w) => w.probableTypo)
              .map((w) => `${w.code} vs ${w.probableTypo}`).join(', ') +
            `. Confirm each before importing; the import will not correct them for you.`
          : `Add them to the register with their certificates, or correct the log.`),
      subject: unresolved.map((w) => w.code).join(', '),
    })
  }

  const expired = wrenches.filter((w) => w.action === 'match' && w.calibrationValid === false)
  if (expired.length > 0) {
    findings.push({
      ruleId: 'torque_import.wrench_calibration_lapsed',
      severity: 'critical',
      title: `${expired.length} wrench${expired.length === 1 ? '' : 'es'} torqued outside their calibration window`,
      detail:
        `${expired.map((w) => w.code).join(', ')} ` +
        `${expired.length === 1 ? 'was' : 'were'} used on at least one connection dated ` +
        `outside the period the calibration certificate on file covers. §11.1: a torque ` +
        `applied with a wrench that was not calibrated on the day is a Critical finding.`,
      subject: expired.map((w) => w.code).join(', '),
    })
  }

  const noWrench = rows.filter((r) => !r.wrenchIdRaw).length
  if (noWrench > 0) {
    findings.push({
      ruleId: 'torque_import.connection_without_wrench',
      severity: 'critical',
      title: `${noWrench} connection${noWrench === 1 ? '' : 's'} record no wrench id`,
      detail:
        `A connection with no wrench id cannot be traced to a calibrated tool, so the ` +
        `§11.1 check cannot be made on it either way. These import as recorded, with the ` +
        `gap visible, rather than being dropped — but they will not close §14.`,
    })
  }

  const outOfRange = rows.filter(
    (r) =>
      r.actualTorque != null &&
      r.requiredTorqueMin != null &&
      r.requiredTorqueMax != null &&
      (r.actualTorque < r.requiredTorqueMin || r.actualTorque > r.requiredTorqueMax),
  )
  if (outOfRange.length > 0) {
    findings.push({
      ruleId: 'torque_import.torque_outside_required_range',
      severity: 'critical',
      title: `${outOfRange.length} connection${outOfRange.length === 1 ? '' : 's'} torqued outside the required range`,
      detail:
        `The log's own required range and its own recorded value disagree on ` +
        `${outOfRange.slice(0, 6).map((r) => r.isoFlangeNumber).join(', ')}` +
        `${outOfRange.length > 6 ? ` and ${outOfRange.length - 6} more` : ''}. ` +
        `This is the log contradicting itself, not the app contradicting the log.`,
    })
  }

  const notInspected = rows.filter((r) => !r.inspectionDate || !r.inspectorInitials).length
  if (notInspected > 0) {
    findings.push({
      ruleId: 'torque_import.not_inspected',
      severity: notInspected === rows.length ? 'critical' : 'warning',
      title: `${notInspected} of ${rows.length} connections carry no inspection`,
      detail:
        `§14 wants an inspection date and an inspector against each connection. ` +
        `${notInspected === rows.length
          ? 'No connection in this log carries either, so the section cannot close on this import alone.'
          : 'The rest are imported as recorded; the gap is visible per connection.'}`,
    })
  }

  // -- The log's own header block, against its own rows -----------------
  const stated = parsed.headerTotals.totalFlanges
  if (stated != null && stated !== rows.length) {
    findings.push({
      ruleId: 'torque_import.header_total_disagrees',
      severity: 'warning',
      title: `The log's header says ${stated.toLocaleString()} flanges; ${rows.length.toLocaleString()} rows were read`,
      detail:
        `A header total that does not match the rows beneath it means either the log was ` +
        `edited after the total was typed, or rows failed to parse. ` +
        `${parsed.rejectedCount > 0
          ? `${parsed.rejectedCount} row(s) were rejected by the parser, which likely accounts for it.`
          : `No rows were rejected, so the header total is the thing to check.`}`,
      subject: `header ${stated} vs ${rows.length} rows`,
    })
  }

  return {
    format,
    sheetsParsed: parsed.sheetsParsed?.length ? parsed.sheetsParsed : [],
    parsedRows: rows.length,
    rejectedRows: parsed.rejectedCount,
    connectionsToCreate: toCreate,
    connectionsToUpdate: toUpdate,
    wrenches,
    findings,
    issues: parsed.issues,
    rows,
  }
}

/**
 * Was this wrench's calibration valid on every date it was used?
 *
 * Every date, not the latest one. A wrench calibrated in March covers a
 * connection torqued in April and does not cover one torqued in January,
 * and checking only the most recent use would pass a log that contains
 * both. A row with no torque date cannot be judged and is not counted
 * against the wrench — it is reported separately as an unmeasurable gap.
 */
function coveredThroughout(
  wrench: TorqueWrench,
  used: ParsedFacilityTorqueRow[],
): boolean {
  const dated = used.map((r) => r.torqueDate).filter((d): d is string => !!d)
  if (dated.length === 0) return true
  return dated.every((d) => isWrenchValidOn(wrench, d))
}

// ---------------------------------------------------------------------
// Rows to write
// ---------------------------------------------------------------------

export interface TorqueLogIngestRows {
  torqueConnections: TorqueConnection[]
}

export function rowsForTorquePlan(
  plan: TorqueLogIngestPlan,
  bundle: Pick<JobBookBundle, 'book' | 'torqueWrenches'>,
  opts: { enteredAt: string; entrySource: 'field_entry' | 'bulk_import' },
): TorqueLogIngestRows {
  const torqueConnections = toFacilityTorqueRecords(plan.rows, {
    jobBookId: bundle.book.id,
    wrenchIdByCode: new Map(
      bundle.torqueWrenches.map((w) => [w.wrenchId, w.id]),
    ),
  }).map((c) => ({
    ...c,
    // §8.1 times the torque and its inspection separately — different
    // deadlines, different responsible parties — so a connection carries
    // two entry stamps, and the inspection one only where an inspection
    // actually happened.
    enteredAt: opts.enteredAt,
    entrySource: opts.entrySource,
    inspectionEnteredAt: c.inspectionDate ? opts.enteredAt : null,
  }))

  return { torqueConnections }
}

export type { ParsedFacilityTorqueRow, FacilityTorqueImportResult }
export { parseFacilityTorqueRows }
