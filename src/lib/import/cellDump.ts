/**
 * Parser for the Microsoft Graph connector's workbook text extraction.
 *
 * The connector returns a workbook as tab-separated cell rows rather than
 * as bytes, so this is a second front door onto the same importers that
 * SheetJS feeds when a user uploads a file. Both produce `unknown[][]` per
 * sheet; everything downstream is shared, which is what keeps the two
 * paths from drifting into two different definitions of a weld.
 *
 * Format:
 *
 *     Workbook: 2 worksheets. Cell values are tab-separated rows; ...
 *
 *     ## Sheet: Torque Log — 1120 rows × 12 columns (A1:L1120)
 *     <tab-separated row>
 *     [2 empty rows]
 *     ...
 *     Formulas:
 *     ...
 *
 * Runs of blank rows are collapsed to `[N empty rows]`, which must be
 * expanded back out — a header located by row offset would otherwise land
 * on the wrong line.
 */

export interface DumpSheet {
  name: string
  rows: (string | null)[][]
  /** Declared dimensions from the sheet banner, where present. */
  declaredRows?: number
  declaredCols?: number
}

const SHEET_RE = /^##\s+Sheet:\s+(.+?)(?:\s+[—-]\s+(\d+)\s+rows?\s*×\s*(\d+)\s+columns?.*)?$/
const EMPTY_RUN_RE = /^\[(\d+)\s+empty\s+rows?\]$/

export function parseCellDump(text: string): DumpSheet[] {
  const sheets: DumpSheet[] = []
  let current: DumpSheet | null = null
  // Formula listings follow the cell values and are not data.
  let inFormulas = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')

    const sheetMatch = line.match(SHEET_RE)
    if (sheetMatch) {
      current = {
        name: (sheetMatch[1] ?? '').trim().replace(/\s+\(empty\)$/, ''),
        rows: [],
        declaredRows: sheetMatch[2] ? Number(sheetMatch[2]) : undefined,
        declaredCols: sheetMatch[3] ? Number(sheetMatch[3]) : undefined,
      }
      sheets.push(current)
      inFormulas = false
      continue
    }
    if (!current) continue

    if (/^Formulas:/.test(line)) { inFormulas = true; continue }
    if (inFormulas) continue

    const emptyRun = line.match(EMPTY_RUN_RE)
    if (emptyRun) {
      const n = Number(emptyRun[1])
      for (let i = 0; i < n; i++) current.rows.push([])
      continue
    }
    if (line === '') continue

    current.rows.push(line.split('\t').map((c) => {
      const v = c.trim()
      return v === '' ? null : v
    }))
  }

  return sheets
}

export function sheetByName(sheets: DumpSheet[], name: string): DumpSheet | null {
  const needle = name.trim().toLowerCase()
  return sheets.find((s) => s.name.trim().toLowerCase() === needle) ?? null
}
