/**
 * Isometric drawings.
 *
 * The isometric number is the join key for the whole book: it appears in
 * the weld log, in the torque log, and in every drawing filename. Sections
 * 21 and 22 are scored against it, so parsing it out of a filename
 * reliably is what makes those two sections measurable at all.
 *
 * The folder and file names also encode a two-stage markup sign-off as
 * checkmark characters. That is a real workflow state living in a
 * filename, and it is converted to fields here rather than preserved as
 * decoration — a checkmark cannot be queried, reported, or attributed.
 */

export interface IsometricDrawing {
  id: string
  jobBookId: string
  /** Line number parsed from the filename, e.g. `4-CO-31050-ACM`. */
  isometricNumber: string
  constructionArea: string | null
  equipmentTag: string | null
  /** Which checklist section the drawing was filed under: 21 or 22. */
  sectionNumber: '21' | '22'
  /** Section 21's single checkmark: X-ray markup done. */
  xrayMarkupComplete: boolean
  /** Section 22's double checkmark: heat number and torque markup done. */
  heatTorqueMarkupComplete: boolean
  /** Filed under a `Stamped` subfolder — the final stamped drawing. */
  stamped: boolean
  /** Captured from a folder name such as `Construction Area 7200 ✔︎MIKE`. */
  signedOffBy: string | null
  revision: string | null
  originalFilename: string
  storagePath: string
}

const CHECK = /[✔✓]︎?|✔︎?/g

/**
 * Strip the decoration a real drawing filename accumulates: `FLG ` prefixes,
 * `(THRD)` suffixes, `- Copy`, `UPDATED`, doubled periods, checkmarks and
 * trailing underscores. What is left is the line number.
 */
export function parseIsometricNumber(filename: string): string | null {
  let s = filename
    .replace(/\.[A-Za-z0-9]+$/, '')       // extension
    .replace(/\.+$/, '')                   // the doubled-period case (`..pdf`)
    .replace(CHECK, ' ')
    .replace(/\bFLG\b/gi, ' ')
    .replace(/\(THRD\)/gi, ' ')
    .replace(/-\s*Copy\b/gi, ' ')
    .replace(/\bUPDATED\b/gi, ' ')
    .replace(/_Rev\s*\d+/gi, ' ')
    .replace(/\bRev\s*\d+/gi, ' ')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // SIZE-SERVICE-LINENO-SPEC, where size may be fractional (`1-1/2`) and
  // the spec may carry a trailing letter (`BCMB`).
  const m = s.match(
    /\b(\d+(?:-\d+\/\d+)?)-([A-Z]{2})-([A-Z0-9]+)-([A-Z]{3}[A-Z]?)\b/i,
  )
  if (m) return `${m[1]}-${m[2]!.toUpperCase()}-${m[3]!.toUpperCase()}-${m[4]!.toUpperCase()}`
  return null
}

export function parseRevision(filename: string): string | null {
  const m = filename.match(/\bRev\s*(\d+)/i)
  return m ? m[1]! : null
}

export interface MarkupState {
  xrayMarkupComplete: boolean
  heatTorqueMarkupComplete: boolean
  stamped: boolean
  signedOffBy: string | null
  areaCompleted: boolean
  threaded: boolean
}

/**
 * Read the sign-off state out of a path.
 *
 * One checkmark in a section 21 path means the X-ray markup is done; two
 * in a section 22 path mean the heat number and torque markup is done. The
 * count is what carries the meaning, so it is counted rather than tested
 * for presence.
 */
export function parseMarkupState(path: string, sectionNumber: '21' | '22'): MarkupState {
  const checks = (path.match(CHECK) ?? []).length
  const stamped = /(^|\/)Stamped(\/|$)/i.test(path)
  const areaCompleted = /\bCOMPLETED\b/i.test(path)
  const threaded = /\(THRD\)/i.test(path)

  // `Construction Area 7200 ✔︎MIKE` — a name attached to a checkmark.
  const owner = path.match(/[✔✓]︎?\s*([A-Z][A-Za-z]{1,20})\b/)
  const signedOffBy = owner && !/^(COMPLETED|Stamped|THRD)$/i.test(owner[1]!)
    ? owner[1]!
    : null

  return {
    xrayMarkupComplete: sectionNumber === '21' && checks >= 1,
    heatTorqueMarkupComplete: sectionNumber === '22' && checks >= 2,
    stamped,
    signedOffBy,
    areaCompleted,
    threaded,
  }
}

export interface IsometricCoverage {
  /** Every isometric either log references. */
  referenced: string[]
  fromWeldLog: string[]
  fromTorqueLog: string[]
  /** Isometrics a section actually has a drawing for. */
  drawn: string[]
  missing: string[]
  coveragePct: number
}

export function isometricCoverage(
  referencedByWelds: string[],
  referencedByTorque: string[],
  drawings: { isometricNumber: string }[],
): IsometricCoverage {
  const norm = (s: string) => s.trim().toUpperCase()
  const fromWeldLog = [...new Set(referencedByWelds.map(norm).filter(Boolean))].sort()
  const fromTorqueLog = [...new Set(referencedByTorque.map(norm).filter(Boolean))].sort()
  const referenced = [...new Set([...fromWeldLog, ...fromTorqueLog])].sort()
  const drawn = [...new Set(drawings.map((d) => norm(d.isometricNumber)))].sort()
  const drawnSet = new Set(drawn)
  const missing = referenced.filter((i) => !drawnSet.has(i))
  return {
    referenced, fromWeldLog, fromTorqueLog, drawn, missing,
    coveragePct: referenced.length
      ? ((referenced.length - missing.length) / referenced.length) * 100
      : 0,
  }
}

/** Construction area, with its equipment tags. */
export interface WorkUnit {
  area: string
  equipmentTags: string[]
  /** `(THRD)` on the folder — threaded rather than welded construction. */
  threaded: boolean
  completed: boolean
}

/** Work units read from the DP-318 section 21 and 22 folder trees. */
export const DP318_WORK_UNITS: WorkUnit[] = [
  { area: '2100', equipmentTags: ['1101A', '1101B', '1102A', '1102B', '1103A', '1103B'], threaded: false, completed: true },
  { area: '2200', equipmentTags: ['V-2202', 'V-2203'], threaded: false, completed: false },
  { area: '2400', equipmentTags: [], threaded: true, completed: false },
  { area: '3100', equipmentTags: [], threaded: false, completed: false },
  { area: '3400', equipmentTags: ['C-3401', 'C-3403'], threaded: false, completed: false },
  { area: '4100', equipmentTags: [], threaded: false, completed: false },
  { area: '7200', equipmentTags: ['C-6303', 'C-6305', 'V-7001', 'Water Lact'], threaded: false, completed: false },
  { area: '8000', equipmentTags: [], threaded: false, completed: false },
  { area: '8400', equipmentTags: [], threaded: false, completed: false },
  { area: '9070', equipmentTags: [], threaded: false, completed: true },
  { area: '9400', equipmentTags: [], threaded: true, completed: false },
  { area: '9500', equipmentTags: [], threaded: false, completed: true },
  { area: '9600', equipmentTags: [], threaded: false, completed: false },
  { area: 'REDLINE', equipmentTags: ['RED LINE HEATER T V-2202'], threaded: false, completed: false },
]
