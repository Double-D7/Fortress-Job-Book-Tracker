/**
 * Controlled vocabularies, seeded from the DP-318 weld log's
 * `Data Validation` sheet.
 *
 * Cell addresses are recorded so the sheet can be re-read when it changes.
 * Values that do not appear in this job are seeded anyway: a vocabulary
 * exists to constrain what may be entered next, not to describe what has
 * been entered so far.
 */

/** `Data Validation` D5:D9. Only Butt, O-Let and Socket occur in DP-318. */
export const WELD_TYPES = ['Butt', 'O-Let', 'Socket', 'Seal', 'Fillet'] as const
export type WeldType = (typeof WELD_TYPES)[number]

/** `Data Validation` F5:F6. */
export const PASS_FAIL_VALUES = ['Pass', 'Fail'] as const

/** `Data Validation` H5:H7. */
export const PIPE_GRADES = ['Gr. B', 'X42', 'X52'] as const

/**
 * `Data Validation` J5:J7.
 *
 * Present in the workbook, used by no weld log column. Seeded so a job
 * specified on the tiered rule has somewhere to point; not evidence that
 * any job is.
 */
export const INSPECTION_REQUIREMENTS = [
  'Random Visual', '100% Visual', '100% Visual and 15% NDT',
] as const

/** Isometric service codes observed across the DP-318 drawing set. */
export const SERVICE_CODES = [
  'CO', 'FG', 'IA', 'PF', 'PG', 'PO', 'PW', 'VG', 'CD', 'HL',
] as const

/** Line specification classes observed across the same set. */
export const SPEC_CLASSES = ['ACM', 'ACL', 'BCM', 'BCL', 'DCN', 'DCL'] as const

/** Pressure test spec classes used by the section 17 packages. */
export const TEST_SPEC_CLASSES = ['A', 'B', 'D'] as const

export function normalizeWeldType(v: string | null | undefined): WeldType | null {
  if (!v) return null
  const s = v.trim().toLowerCase().replace(/[^a-z]/g, '')
  const match: Record<string, WeldType> = {
    butt: 'Butt', olet: 'O-Let', socket: 'Socket', sock: 'Socket',
    seal: 'Seal', fillet: 'Fillet',
  }
  return match[s] ?? null
}
