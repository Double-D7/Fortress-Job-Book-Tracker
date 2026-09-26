/**
 * Which weld log template a workbook is.
 *
 * Fortress builds two kinds of book and they carry two genuinely
 * different weld logs:
 *
 *   facility   One table, whatever number of tabs it is split across.
 *              Welds are numbered once across the book, each row states
 *              its construction area and isometric, and the welder is a
 *              single stamp.
 *
 *   flowline   The Noble template. One sheet per line, the sheet name is
 *              the line code and the only place it appears, each sheet
 *              repeats the job header block above its own column header,
 *              welds are numbered per line — so weld 1 exists on every
 *              sheet — and the welder cell names four passes,
 *              Root/Hot/Fill/Cap.
 *
 * Only the facility template was ever routed anywhere. A flowline log fed
 * to the facility reader reported success: it flattened the sheets, found
 * one header row, read the next sheet's header block as data, threw away
 * every line code, and then collapsed weld 1 of FL-7 with weld 1 of FL-8
 * because the record id was derived from the weld number alone. Nine
 * welds across two lines became one weld, under `ok: true`.
 *
 * So detection has to be structural and explainable rather than a guess
 * at which parser returns more rows. Each template has columns the other
 * does not, and the header row is where they differ.
 */

const normKey = (v: unknown) =>
  (v == null ? '' : String(v)).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:.]+$/, '')

/**
 * Columns only the Noble flowline template has.
 *
 * Heat numbers are the strongest single signal: the facility reader has
 * no heat column at all, and heat-to-MTR traceability is the whole point
 * of a flowline log.
 */
const FLOWLINE_COLUMNS = [
  'welder root/hot/fill/cap', 'welders',
  'heat number', 'heat numbers', 'heat #',
  'ndt company', 'part length', 'part description',
  'x-ray number', 'xray',
]

/** Columns only the facility template has. */
const FACILITY_COLUMNS = [
  'area', 'construction area', 'const area', 'area #',
  'iso', 'iso number', 'iso #', 'isometric', 'isometric number',
  'equipment tag', 'equipment',
  '% smys', 'percent smys', '% of smys', 'smys %',
  'required inspection', 'required inspection tier', 'tier',
  'pressure test', 'pressure test #', 'hydro test',
  'welder stamp', 'stamp', 'welder initials',
]

/** Labels from the Noble job header block, which sits above the columns. */
const FLOWLINE_HEADER_LABELS = [
  /facility name/i, /drill pad/i, /well name/i,
  /noble\s+(energy\s+)?pic/i, /operator pic/i, /welding company/i,
]

export type WeldLogTemplate = 'facility' | 'flowline'

export interface TemplateVerdict {
  template: WeldLogTemplate
  /** Why, in the words a person would use. Surfaced on the preview so a
   *  misrouted workbook is visible rather than merely wrong. */
  reason: string
  flowlineSignals: number
  facilitySignals: number
  /** Sheets that carry a weld-log column header of their own. */
  sheetsWithOwnHeader: number
}

function scoreRow(cells: readonly unknown[]): { flowline: number; facility: number } {
  let flowline = 0
  let facility = 0
  for (const cell of cells) {
    const k = normKey(cell)
    if (!k) continue
    if (FLOWLINE_COLUMNS.includes(k)) flowline += 1
    if (FACILITY_COLUMNS.includes(k)) facility += 1
  }
  return { flowline, facility }
}

/** Does this row look like a weld-log column header at all? */
function isHeaderRow(cells: readonly unknown[]): boolean {
  const keys = cells.map(normKey)
  const hasWeld = keys.some((k) => /^weld( number| no| #| id)?$/.test(k))
  const named = keys.filter(Boolean).length
  return hasWeld && named >= 3
}

export function detectWeldLogTemplate(
  sheets: readonly { name: string; grid: unknown[][] }[],
): TemplateVerdict {
  let flowlineSignals = 0
  let facilitySignals = 0
  let sheetsWithOwnHeader = 0
  let headerBlockSheets = 0

  for (const sheet of sheets) {
    let sawHeader = false
    // The header sits in the first rows; a log with forty rows of preamble
    // is not a template this reads either way.
    for (const row of sheet.grid.slice(0, 40)) {
      const cells = row ?? []
      if (isHeaderRow(cells)) {
        sawHeader = true
        const s = scoreRow(cells)
        flowlineSignals += s.flowline
        facilitySignals += s.facility
      }
      for (const cell of cells) {
        const text = cell == null ? '' : String(cell)
        if (text && FLOWLINE_HEADER_LABELS.some((re) => re.test(text))) {
          headerBlockSheets += 1
          break
        }
      }
    }
    if (sawHeader) sheetsWithOwnHeader += 1
  }

  // Every sheet carrying its own column header is the structural
  // signature of the per-sheet template, whatever the columns say: a
  // facility log split across tabs repeats its header too, but it does
  // not also repeat a job header block above it.
  const perSheet = sheetsWithOwnHeader >= 2 && headerBlockSheets >= 2

  if (flowlineSignals > facilitySignals) {
    return {
      template: 'flowline', flowlineSignals, facilitySignals, sheetsWithOwnHeader,
      reason: perSheet
        ? `Read as a flowline log: ${sheetsWithOwnHeader} sheets each carry their own job ` +
          `header and column header, and the columns are the Noble template's.`
        : `Read as a flowline log: the columns are the Noble template's ` +
          `(${flowlineSignals} of them, against ${facilitySignals} facility columns).`,
    }
  }

  if (perSheet && facilitySignals === 0) {
    return {
      template: 'flowline', flowlineSignals, facilitySignals, sheetsWithOwnHeader,
      reason: `Read as a flowline log: ${sheetsWithOwnHeader} sheets each repeat a job header ` +
        `block above their own column header, which is the per-line template, and no sheet ` +
        `states a construction area.`,
    }
  }

  return {
    template: 'facility', flowlineSignals, facilitySignals, sheetsWithOwnHeader,
    reason: facilitySignals > 0
      ? `Read as a facility log: ${facilitySignals} facility column(s) — area, isometric or ` +
        `tier — and ${flowlineSignals} flowline column(s).`
      : 'Read as a facility log; nothing in it identifies the Noble per-line template.',
  }
}
