/**
 * The Weld Log Overview Sheet with Inspection Percentages — Appendix A §11.
 *
 * This is the one page an operator turns to first, and it is the page that
 * decides whether a book's inspection claims hold up: every welder on the
 * job, their stamp, their WPQ expiry, how many welds they made, and what
 * percentage of those were inspected visually and by NDE.
 *
 * It arrives as a PDF export of a spreadsheet, so the parsing is in two
 * layers. `pdfText` recovers the table geometry; this reads the table.
 *
 * PARSED BY SHAPE, NOT BY COLUMN INDEX. A row is read by what its cells
 * look like — a date is a date, a percentage is a percentage — rather than
 * by counting from the left. That matters because the rows that break a
 * positional parser are exactly the rows worth finding: DP-318 has a
 * welder with no WPQ expiry at all, and a positional reader shifts every
 * cell after the gap one column left, silently turning "no qualification
 * on file" into "qualified, 27 welds, expiry 'Submitted'".
 *
 * NOTHING IS INFERRED. A missing expiry stays null. A stamp shared by two
 * welders stays the string on the page. §9.1 is explicit that identity is
 * never inferred from a filename or entered as free text, and the same
 * discipline applies here: this module reports what the sheet says, and
 * the rules downstream decide what it means.
 */

import type { IsoDate } from '@/lib/domain/types'
import { parseLooseDate } from '@/lib/domain/dates'
import { extractPdfText, type PdfExtraction, type PdfLine } from './pdfText'

export interface OverviewWelder {
  name: string
  /** Verbatim. DP-318 carries "MR LC" — one row, two welders. */
  stamp: string
  wpqExpires: IsoDate | null
  wpqSubmitted: boolean
  weldCount: number | null
  visualPct: number | null
  ndtPct: number | null
  failedVisuals: number | null
  failedNdt: number | null
}

export interface OverviewRollup {
  label: string
  weldCount: number | null
  visualPct: number | null
  ndtPct: number | null
  failedVisuals: number | null
  failedNdt: number | null
}

export interface OverviewInspector {
  name: string
  qualification: string
  documentationSubmitted: boolean
}

export interface OverviewHeader {
  locationName: string | null
  date: IsoDate | null
  /** The sheet's own label for the operator field, kept because it names
   *  the operator the sheet was branded to — "Noble Energy PIC:" on a book
   *  whose piping specification may since have moved to another operator. */
  operatorLabel: string | null
  operatorPic: string | null
  qaqcRepresentative: string | null
  weldingCompany: string | null
  facilityType: string | null
}

export interface OverviewRequirement {
  visualPct: number | null
  ndePct: number | null
  statedAs: string | null
}

export interface WeldLogOverview {
  header: OverviewHeader
  requirement: OverviewRequirement
  welders: OverviewWelder[]
  inspectors: OverviewInspector[]
  jointTypes: OverviewRollup[]
  projectTotals: OverviewRollup | null
  wpsReference: string | null
  pqrReference: string | null
  /** Raised where the sheet could not be read, never where it reads badly
   *  — a sheet that says something alarming is parsed successfully. */
  parseIssues: string[]
}

// ---------------------------------------------------------------------
// Cell readers
// ---------------------------------------------------------------------

/** A dash is how this sheet writes "not applicable". It is not zero. */
const isDash = (s: string) => /^-{1,3}$/.test(s.trim())

const asInt = (s: string): number | null => {
  const t = s.trim().replace(/,/g, '')
  return /^\d+$/.test(t) ? Number(t) : null
}

const asPct = (s: string): number | null => {
  const m = s.trim().match(/^([\d.]+)\s*%$/)
  return m ? Number(m[1]) : null
}

const asDate = (s: string): IsoDate | null =>
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s.trim()) ? parseLooseDate(s.trim()) : null

const JOINT_TYPE = /^(butt|o-?let|socket|seal)\s+w(e)?lds?$/i

// ---------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------

/**
 * Where the welder table ends and the CWI block beside it begins.
 *
 * Both sit on the same baselines, so a row carries cells from both. The
 * split is derived from the header rather than hard-coded: the welder
 * table's rightmost header cell is "NDT" (Failed NDT), and anything a
 * comfortable margin to the right of it belongs to the other table.
 */
function leftTableCutoff(lines: PdfLine[]): number {
  for (const line of lines) {
    if (!/\bWelds\b/.test(line.text) || !/\bVisuals\b/.test(line.text)) continue
    const rightmost = Math.max(...line.runs.map((r) => r.x))
    return rightmost + 40
  }
  return 460
}

function readRollupCells(cells: string[]): Omit<OverviewRollup, 'label'> {
  const counts = cells.map(asInt).filter((n): n is number => n != null)
  const pcts = cells.map(asPct).filter((n): n is number => n != null)
  const dashes = cells.filter(isDash).length
  return {
    weldCount: counts[0] ?? null,
    visualPct: pcts[0] ?? null,
    ndtPct: pcts[1] ?? null,
    // Failed Visuals sits between the NDT percentage and Failed NDT. On
    // every DP-318 row it is a dash, which is the sheet's "none recorded"
    // and emphatically not a zero.
    failedVisuals: dashes > 0 ? null : (counts[1] ?? null),
    failedNdt: counts[counts.length - 1] ?? null,
  }
}

export function parseWeldLogOverview(extraction: PdfExtraction): WeldLogOverview {
  const issues: string[] = []
  const page = extraction.pages[0]
  if (!page) {
    return {
      header: {
        locationName: null, date: null, operatorLabel: null, operatorPic: null,
        qaqcRepresentative: null, weldingCompany: null, facilityType: null,
      },
      requirement: { visualPct: null, ndePct: null, statedAs: null },
      welders: [], inspectors: [], jointTypes: [], projectTotals: null,
      wpsReference: null, pqrReference: null,
      parseIssues: [
        extraction.undecodable > 0
          ? 'No text could be read from this PDF. It is either a scan or uses an encoding this reader does not handle; it needs to be filed as a document rather than imported.'
          : 'No text found in this PDF.',
      ],
    }
  }

  const cutoff = leftTableCutoff(page.lines)
  const left = (l: PdfLine) => l.runs.filter((r) => r.x < cutoff)
  const right = (l: PdfLine) => l.runs.filter((r) => r.x >= cutoff)

  // -- header ----------------------------------------------------------
  //
  // Read run by run rather than by regex over the joined line. The sheet
  // draws a label and its value as separate cells, so "the value of
  // `Location Name:`" is exactly "the next run to its right" — which
  // survives a label being reworded, a column moving, and the case that
  // actually bites, two label/value pairs sharing one baseline.
  const labelled = new Map<string, string>()
  for (const line of page.lines) {
    for (let i = 0; i < line.runs.length; i += 1) {
      const text = line.runs[i]!.text.trim()
      if (!text.endsWith(':')) continue
      const value = line.runs[i + 1]?.text.trim()
      if (value && !value.endsWith(':')) labelled.set(text.slice(0, -1).trim(), value)
    }
  }
  const labelFor = (re: RegExp): string | null =>
    [...labelled.keys()].find((k) => re.test(k)) ?? null

  const picKey = labelFor(/\bPIC$/i)
  const header: OverviewHeader = {
    locationName: labelled.get(labelFor(/^Location Name$/i) ?? '') ?? null,
    date: parseLooseDate(labelled.get(labelFor(/^Date$/i) ?? '') ?? ''),
    // Captured as the sheet writes it. §3 names a sheet still branded to a
    // previous operator "a finding waiting to happen", and the only way to
    // surface that is to keep the branding visible instead of normalising
    // it into a neutral field.
    operatorLabel: picKey ? picKey.replace(/\s*PIC$/i, '').trim() || null : null,
    operatorPic: picKey ? labelled.get(picKey) ?? null : null,
    qaqcRepresentative: labelled.get(labelFor(/QA\/QC Representative$/i) ?? '') ?? null,
    weldingCompany: labelled.get(labelFor(/^Welding Company$/i) ?? '') ?? null,
    facilityType: null,
  }
  for (const line of page.lines) {
    const run = line.runs.find((r) => /^(FACILITY|FLOWLINE)$/i.test(r.text.trim()))
    if (run) { header.facilityType = run.text.trim().toUpperCase(); break }
  }

  // -- the stated requirement ------------------------------------------
  //
  // "100% visual & 10% NDE" is set in a narrow column and wraps, so the
  // two halves land on different baselines with an unrelated caption
  // between them. Joining the page and allowing a bounded gap reads it
  // without assuming how the wrap falls.
  const flat = page.lines.map((l) => l.text).join(' ')
  const reqMatch = flat.match(/Requirement-\s*([\d.]+%)[\s\S]{0,40}?visual\s*&\s*([\d.]+%)\s*NDE/i)
  const requirement: OverviewRequirement = {
    visualPct: asPct(reqMatch?.[1] ?? ''),
    ndePct: asPct(reqMatch?.[2] ?? ''),
    statedAs: reqMatch ? `${reqMatch[1]} visual & ${reqMatch[2]} NDE` : null,
  }

  // -- welders, joint types, project totals ----------------------------
  const welders: OverviewWelder[] = []
  const jointTypes: OverviewRollup[] = []
  let projectTotals: OverviewRollup | null = null

  for (const line of page.lines) {
    const cells = left(line).map((r) => r.text.trim()).filter(Boolean)
    if (cells.length < 2) continue
    const first = cells[0]!

    if (JOINT_TYPE.test(first)) {
      jointTypes.push({ label: first, ...readRollupCells(cells.slice(1)) })
      continue
    }
    if (/^project totals$/i.test(first)) {
      projectTotals = { label: 'Project Totals', ...readRollupCells(cells.slice(1)) }
      continue
    }
    // A welder row: a name in the first cell and a weld count somewhere.
    // Header rows and the empty template rows below the roster fail this
    // because they carry no name or no count.
    if (!/^[A-Z][A-Za-z.'\- ]+$/.test(first) || first.length < 3) continue
    if (/^(welder|stamp|expires|submitted|user input|seal)/i.test(first)) continue

    const rest = cells.slice(1)
    const counts = rest.filter((c) => asInt(c) != null)
    if (counts.length === 0) continue

    const dateCell = rest.find((c) => asDate(c) != null)
    const pcts = rest.map(asPct).filter((n): n is number => n != null)
    // The stamp is the cell before the date, or before "Submitted" where
    // no date was recorded — which is the case this sheet actually
    // contains and the reason nothing here counts columns.
    const anchorIdx = rest.findIndex(
      (c) => asDate(c) != null || /^submitted$/i.test(c),
    )
    const stamp = anchorIdx > 0 ? rest[anchorIdx - 1]!.trim() : ''
    const trailing = rest.filter((c) => asInt(c) != null)

    welders.push({
      name: first,
      stamp,
      wpqExpires: dateCell ? asDate(dateCell) : null,
      wpqSubmitted: rest.some((c) => /^submitted$/i.test(c)),
      weldCount: asInt(trailing[0] ?? ''),
      visualPct: pcts[0] ?? null,
      ndtPct: pcts[1] ?? null,
      failedVisuals: rest.some(isDash) ? null : asInt(trailing[1] ?? ''),
      failedNdt: asInt(trailing[trailing.length - 1] ?? ''),
    })
  }

  // -- the CWI / NDT block on the right --------------------------------
  const inspectors: OverviewInspector[] = []
  for (const line of page.lines) {
    const cells = right(line).map((r) => r.text.trim()).filter(Boolean)
    if (cells.length < 2) continue
    const [name, qualification, submitted] = cells
    if (!name || !qualification) continue
    if (!/^(CWI|NDT|RT|UT|MT|PT)$/i.test(qualification)) continue
    inspectors.push({
      name,
      qualification: qualification.toUpperCase(),
      documentationSubmitted: /^submitted$/i.test(submitted ?? ''),
    })
  }

  // -- procedures ------------------------------------------------------
  //
  // Two side-by-side tables, WPS and PQR, each "Document Name/Number" over
  // its value. The header row gives both column positions; the first row
  // beneath it gives the values. Reading the header row itself as the
  // value is the easy mistake here, and it produces a WPS reference of
  // "WPS Document Name/Number Applicable Code(s)".
  let wpsReference: string | null = null
  let pqrReference: string | null = null
  const headerIdx = page.lines.findIndex(
    (l) => /WPS Document Name/i.test(l.text) && /PQR Document Name/i.test(l.text),
  )
  if (headerIdx >= 0) {
    const headerRuns = page.lines[headerIdx]!.runs
    const wpsX = headerRuns.find((r) => /WPS Document Name/i.test(r.text))?.x ?? 0
    const pqrX = headerRuns.find((r) => /PQR Document Name/i.test(r.text))?.x ?? Infinity
    const value = page.lines
      .slice(headerIdx + 1)
      .find((l) => l.runs.some((r) => !/^submitted\??$/i.test(r.text.trim())))
    if (value) {
      const pick = (lo: number, hi: number) =>
        value.runs
          .filter((r) => r.x >= lo - 10 && r.x < hi - 10)
          .map((r) => r.text.trim())
          .filter((x) => x && !/^submitted\??$/i.test(x))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim() || null
      wpsReference = pick(wpsX, pqrX)
      pqrReference = pick(pqrX, Infinity)
    }
  }

  if (welders.length === 0) {
    issues.push('No welder rows could be read from this sheet.')
  }
  if (!projectTotals) {
    issues.push('No Project Totals row was found, so the sheet cannot be cross-checked against itself.')
  }

  return {
    header, requirement, welders, inspectors, jointTypes, projectTotals,
    wpsReference, pqrReference, parseIssues: issues,
  }
}

/** Convenience: bytes in, parsed sheet out. */
export function parseWeldLogOverviewPdf(buf: Buffer | Uint8Array): WeldLogOverview {
  return parseWeldLogOverview(extractPdfText(buf))
}

// =====================================================================
// Cross-checks
// =====================================================================

/**
 * What the sheet says about itself, checked against itself.
 *
 * An overview sheet carries the same quantity three times — once per
 * welder, once per joint type, once as a project total — and the operator
 * reads all three. When they disagree, the disagreement IS the finding,
 * and it is usually the only trace left of something that went missing
 * upstream. On DP-318 the two rollups differ by three welds, and those
 * three welds are why the project's visual inspection coverage prints as
 * 100.2%: a percentage over 100 is not a rounding artefact, it is more
 * inspections than there are welds.
 *
 * These checks run on the parsed sheet alone. They need no other section
 * and no database, which means a tech gets them in the upload preview,
 * before the file is committed to the book.
 */
export interface OverviewFinding {
  ruleId: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  /** Where on the sheet, for the preview to point at. */
  subject?: string
}

export interface OverviewCheckContext {
  /** The work window, for judging a qualification that expires mid-job. */
  constructionStart?: IsoDate | null
  constructionEnd?: IsoDate | null
  /** The operator the job book records as governing, so a sheet still
   *  branded to a previous one is visible. */
  recordedOperator?: string | null
}

export function checkWeldLogOverview(
  o: WeldLogOverview,
  ctx: OverviewCheckContext = {},
): OverviewFinding[] {
  const out: OverviewFinding[] = []
  const sum = (xs: (number | null)[]) =>
    xs.reduce<number>((a, x) => a + (x ?? 0), 0)

  const welderTotal = sum(o.welders.map((w) => w.weldCount))
  const jointTotal = sum(o.jointTypes.map((j) => j.weldCount))
  const stated = o.projectTotals?.weldCount ?? null

  // -- the two rollups must agree ---------------------------------------
  if (welderTotal > 0 && jointTotal > 0 && welderTotal !== jointTotal) {
    const gap = jointTotal - welderTotal
    out.push({
      ruleId: 'overview.rollups_disagree',
      severity: 'critical',
      title:
        gap > 0
          ? `${gap} weld${gap === 1 ? '' : 's'} on this sheet ${gap === 1 ? 'is' : 'are'} attributed to no welder`
          : `${-gap} more welds are attributed to welders than exist by joint type`,
      detail:
        `The joint-type rollup totals ${jointTotal} welds and the welder rollup totals ` +
        `${welderTotal}. The same welds counted two ways should give the same number. ` +
        (gap > 0
          ? `The ${gap} in the difference appear in the joint-type table but carry no welder ` +
            `stamp, which FDS-JBMP-001 §11.1 makes a Critical finding: with no attribution, ` +
            `neither the welder's qualification nor the weld's inspection adequacy can be verified.`
          : `Welds counted against welders that do not appear by joint type cannot be traced ` +
            `to a joint, so their inspection requirement cannot be computed.`),
      subject: 'Project Totals',
    })
  }

  // -- a percentage over 100 --------------------------------------------
  for (const row of [...o.jointTypes, ...(o.projectTotals ? [o.projectTotals] : [])]) {
    for (const [what, pct] of [['visual', row.visualPct], ['NDE', row.ndtPct]] as const) {
      if (pct == null || pct <= 100) continue
      const implied = row.weldCount != null
        ? Math.round((pct / 100) * row.weldCount)
        : null
      out.push({
        ruleId: 'overview.coverage_above_100',
        severity: 'critical',
        title: `${row.label} reports ${pct}% ${what} coverage`,
        detail:
          `Coverage cannot exceed 100%: it is inspections divided by welds. ` +
          (implied != null && row.weldCount != null
            ? `${pct}% of ${row.weldCount} welds implies ${implied} ${what} inspections, ` +
              `which is ${implied - row.weldCount} more than there are welds. ` +
              `The usual cause is the numerator and the denominator being taken from ` +
              `different tables on this sheet.`
            : `The numerator and denominator are not drawn from the same population.`),
        subject: row.label,
      })
    }
  }

  // -- the stated total must match the rollups --------------------------
  if (stated != null && welderTotal > 0 && stated !== welderTotal && stated !== jointTotal) {
    out.push({
      ruleId: 'overview.total_matches_neither',
      severity: 'critical',
      title: `The stated project total of ${stated} welds matches neither rollup`,
      detail:
        `The welder rollup gives ${welderTotal} and the joint-type rollup gives ${jointTotal}. ` +
        `A total that agrees with neither is a third figure, and the sheet gives no way to tell ` +
        `which of the three an operator should believe.`,
      subject: 'Project Totals',
    })
  }

  // -- welders --------------------------------------------------------
  for (const w of o.welders) {
    if (!w.wpqExpires) {
      out.push({
        ruleId: 'overview.welder_without_wpq_expiry',
        severity: 'critical',
        title: `${w.name} has ${w.weldCount ?? 'an unstated number of'} welds and no WPQ expiry on the sheet`,
        detail:
          `The Date WPQ Expires cell is blank for this welder. Without it there is no way to ` +
          `establish that the qualification was current on the date of any weld, which ` +
          `§11.1 makes a Critical finding for every weld attributed to them.`,
        subject: `${w.name} (${w.stamp || 'no stamp'})`,
      })
    }

    // §11.1: a stamp shared between two welders makes per-weld
    // attribution impossible in both directions.
    if (/\s/.test(w.stamp.trim()) || /\b(and|&|\/|\+)\b/i.test(w.stamp)) {
      out.push({
        ruleId: 'overview.combined_stamp',
        severity: 'critical',
        title: `"${w.stamp}" is a combined stamp covering more than one welder`,
        detail:
          `The row is recorded against "${w.name}" with stamp "${w.stamp}", which names more ` +
          `than one person. ${w.weldCount ?? 'These'} welds cannot be attributed to an ` +
          `individual, so neither welder's qualification can be checked against them and ` +
          `neither one's inspection percentage is computable.`,
        subject: `${w.name} (${w.stamp})`,
      })
    }

    // A qualification that lapses inside the work window. §7 Gate 2 asks
    // for exactly this forecast.
    const end = ctx.constructionEnd
    if (w.wpqExpires && end && w.wpqExpires < end) {
      out.push({
        ruleId: 'overview.wpq_expires_in_window',
        severity: 'warning',
        title: `${w.name}'s WPQ expires ${w.wpqExpires}, before the work window closes`,
        detail:
          `Construction runs to ${end}. Any weld this welder makes after ${w.wpqExpires} is a ` +
          `Critical finding under §11.1 unless a requalification is on file. §7 Gate 2 requires ` +
          `this forecast to be reviewed with a requalification plan for each.`,
        subject: `${w.name} (${w.stamp})`,
      })
    }
  }

  // -- coverage against the sheet's own stated requirement --------------
  const required = o.requirement.ndePct
  if (required != null) {
    for (const row of [...o.jointTypes, ...o.welders.map((w) => ({
      label: `${w.name} (${w.stamp})`, weldCount: w.weldCount, ndtPct: w.ndtPct,
    }))]) {
      if (row.ndtPct == null || row.weldCount == null || row.weldCount === 0) continue
      if (row.ndtPct >= required) continue
      const done = Math.round((row.ndtPct / 100) * row.weldCount)
      const owed = Math.ceil((required / 100) * row.weldCount)
      out.push({
        ruleId: 'overview.nde_below_requirement',
        severity: 'critical',
        title: `${row.label} is at ${row.ndtPct}% NDE against a stated ${required}% requirement`,
        detail:
          `${done} of ${row.weldCount} welds examined; ${owed} are required. ` +
          `A shortfall here is not closed by the project average: the requirement applies to ` +
          `the population, and ${owed - done} further examination${owed - done === 1 ? '' : 's'} ` +
          `${owed - done === 1 ? 'is' : 'are'} owed.`,
        subject: row.label,
      })
    }
  }

  // -- operator branding ------------------------------------------------
  if (
    o.header.operatorLabel && ctx.recordedOperator &&
    !o.header.operatorLabel.toLowerCase().includes(ctx.recordedOperator.toLowerCase()) &&
    !ctx.recordedOperator.toLowerCase().includes(o.header.operatorLabel.toLowerCase())
  ) {
    out.push({
      ruleId: 'overview.operator_branding_stale',
      severity: 'warning',
      title: `This sheet is branded to ${o.header.operatorLabel}, but the book records ${ctx.recordedOperator}`,
      detail:
        `The sheet's own field reads "${o.header.operatorLabel} PIC". §3 of the program names ` +
        `exactly this — a governing form still branded to a previous operator — as a finding ` +
        `waiting to happen, because the checklist an operator audits against is the one named ` +
        `on the form.`,
      subject: `${o.header.operatorLabel} PIC`,
    })
  }

  // -- inspectors -------------------------------------------------------
  for (const i of o.inspectors) {
    if (i.documentationSubmitted) continue
    out.push({
      ruleId: 'overview.inspector_documentation_missing',
      severity: 'warning',
      title: `No qualification documentation recorded for ${i.name} (${i.qualification})`,
      detail:
        `The sheet lists this inspector but its documentation column is blank. §8.2 precondition ` +
        `3: no inspector inspects without current credentials on file in this job book.`,
      subject: i.name,
    })
  }

  return out
}
