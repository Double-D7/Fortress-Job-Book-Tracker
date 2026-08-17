/**
 * Import preview and validation.
 *
 * Nothing is committed until a human has seen the per-row report. An import
 * that silently drops a malformed row is worse than one that refuses: this
 * is a compliance record, and a missing weld is a missing weld whether it
 * was never typed or was eaten by a parser.
 */
export type IssueSeverity = 'error' | 'warning' | 'info'

export interface RowIssue {
  severity: IssueSeverity
  /** Sheet name as it appears in the workbook. */
  sheet: string
  /** 1-based row number in the sheet, so it matches what the user sees. */
  row: number
  column?: string
  message: string
}

export interface ImportPreview<T> {
  /** Rows that parsed cleanly enough to commit. */
  rows: T[]
  issues: RowIssue[]
  /** Rows that will not be committed because they carry a blocking error. */
  rejectedCount: number
  sheetsParsed: string[]
  /** New entities the import would create, for a human to confirm before
   *  they exist — a mistyped welder must not silently become a new person. */
  proposedWelders: { nameOrInitials: string; occurrences: number }[]
  proposedWrenches: { wrenchId: string; occurrences: number }[]
  proposedHeats: string[]
}

export const errorsOnly = (issues: RowIssue[]) => issues.filter((i) => i.severity === 'error')
export const canCommit = (preview: ImportPreview<unknown>) => preview.rows.length > 0
