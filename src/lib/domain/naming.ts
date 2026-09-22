/**
 * The file naming convention, FDS-JBMP-001 Appendix B.
 *
 *   [SS]-[TYPE]-[IDENTIFIER]-[DESCRIPTOR]-[YYYYMMDD]-R[n].[ext]
 *   15-MTR-SU78500-3in-SCH40-PIPE-20260114-R0.pdf
 *
 * Three of those six elements cannot honestly be derived from whatever a
 * vendor happened to call the file, and §9.1 of the program says identity
 * must never be inferred from a filename in the first place — the baseline
 * review found one welder under four spellings and one wrench under two
 * filename prefixes, which is exactly what filename-derived identity
 * produces.
 *
 * So this module builds the name from facts the application actually
 * holds: the section being uploaded to, a register key the tech picked,
 * and the date carried by the document. What it cannot know, it reports as
 * missing rather than guessing. A guessed heat number in a filename is
 * worse than an obviously incomplete one, because it looks right.
 */
import type { IsoDate } from './types'

/** Appendix B document type codes, verbatim. */
export const TYPE_CODES = {
  CHK: 'Checklist',
  OVW: 'Overview drawing',
  SPC: 'Specification',
  WPS: 'Welding Procedure Specification',
  PQR: 'Procedure Qualification Record',
  WPQ: 'Welder Performance Qualification',
  CWI: 'CWI credential',
  NDT: 'NDT technician certification',
  MTR: 'Material Test Report',
  CAL: 'Calibration certificate',
  TQL: 'Torque Log',
  WLG: 'Weld Log',
  RPT: 'NDE Report',
  PRC: 'NDT / test procedure',
  COC: 'Certificate of Conformance',
  PTR: 'Pressure Test Result',
  PTC: 'Pressure Test Chart',
  CPT: 'Cathodic Protection Test',
  UTB: 'Ultrasonic Baseline',
  PID: 'As-Built P&ID',
  ISO: 'Isometric drawing',
  MRK: 'Marked up isometric',
  DFR: 'Daily Field Report',
  CTG: 'Coating inspection',
} as const

export type TypeCode = keyof typeof TYPE_CODES

/**
 * The type a section's documents usually are.
 *
 * A default, not a rule: section 17 holds both results (PTR) and charts
 * (PTC), and a tech who knows which is which may say so. Offering the
 * likely answer is the difference between a field that gets filled in
 * correctly and one that gets whatever is first in the list.
 */
export const DEFAULT_TYPE_BY_SECTION: Record<string, TypeCode> = {
  '1': 'CHK', '2': 'OVW', '3': 'SPC', '4': 'WPS', '5': 'PQR',
  '6': 'WPQ', '7': 'CWI', '8': 'NDT', '9': 'PRC', '10': 'RPT',
  '11': 'WLG', '12': 'WLG', '13': 'CAL', '14': 'TQL', '15': 'MTR',
  '16': 'PRC', '17': 'PTR', '18': 'CPT', '19': 'UTB', '20': 'PID',
  '21': 'MRK', '22': 'MRK', '23': 'CTG',
  // Flowline delivers 19 through 22 combined.
  '19-22': 'MRK',
  S1: 'DFR',
}

/** What register the IDENTIFIER for a section should be picked from. §9.1. */
export const REGISTER_BY_SECTION: Record<string, string> = {
  '6': 'welder', '7': 'cwi', '8': 'ndt_technician',
  '10': 'nde_report', '12': 'weld_line', '13': 'torque_wrench',
  '14': 'isometric', '15': 'material_heat', '17': 'pressure_test',
  '18': 'cp_test_point', '19': 'ut_reading',
  '21': 'isometric', '22': 'isometric', '19-22': 'isometric',
  '23': 'construction_area',
}

/** Two digits, as Appendix B requires — except a range like `19-22`, which
 *  is already the section's own identity on the flowline checklist. */
export function sectionPrefix(sectionNumber: string): string {
  const n = sectionNumber.trim()
  return /^\d+$/.test(n) ? n.padStart(2, '0') : n.toUpperCase()
}

/**
 * Characters Appendix B forbids, and the status words §9.2 forbids.
 *
 * The words matter as much as the characters. The baseline review found a
 * folder whose name carried a check mark and a foreman's first name —
 * status encoded in a filename because there was nowhere else to put it.
 * There is somewhere else now.
 */
const FORBIDDEN_CHARS = /['&/,()]|[✓✔✅❌]/
const STATUS_WORDS = [
  'COMPLETED', 'COMPLETE', 'FINAL', 'COPY', 'UPDATED', 'REVISED',
  'NEW', 'OLD', 'LATEST', 'CURRENT', 'DRAFT', 'DONE',
]

/** Trim a human phrase into a DESCRIPTOR: hyphens, no forbidden characters,
 *  no status words. */
export function toDescriptor(raw: string): string {
  const stripped = raw
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    // Dates first, while they are still one token. `2-13-2025` splits into
    // three harmless-looking numbers the moment the string is broken on
    // hyphens, and they then survive into the descriptor beside the real
    // date element — which is how a name ends up carrying two dates that
    // disagree.
    .replace(/\b\d{1,4}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/g, ' ')
    .replace(/\b\d{8}\b/g, ' ')
    .replace(FORBIDDEN_CHARS, ' ')
    .replace(/[^A-Za-z0-9. -]/g, ' ')

  const words = stripped
    .split(/[\s_-]+/)
    .filter(Boolean)
    .filter((w) => !STATUS_WORDS.includes(w.toUpperCase()))
    // A bare date in the source name is dropped: the date element is
    // carried separately and from the document itself, not from whatever
    // the file was called.
    .filter((w) => !/^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{2,4}$/.test(w))
    .filter((w) => !/^\d{8}$/.test(w))

  return words.join('-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
}

export interface NameParts {
  sectionNumber: string
  typeCode: TypeCode
  /** The controlled register key. Null when the tech has not picked one. */
  identifier: string | null
  descriptor: string
  /** The date the DOCUMENT carries, not the date it was uploaded. */
  documentDate: IsoDate | null
  revision: number
  extension: string
}

export interface ConformingName {
  filename: string
  /** Elements Appendix B requires that are not yet known. A name missing
   *  any of these is a Minor finding under §11.3 — recorded and corrected
   *  before the next gate, never a reason to stop a tech working. */
  missing: ('identifier' | 'documentDate')[]
  conforming: boolean
}

export function buildFilename(parts: NameParts): ConformingName {
  const missing: ConformingName['missing'] = []
  if (!parts.identifier?.trim()) missing.push('identifier')
  if (!parts.documentDate) missing.push('documentDate')

  const segments = [
    sectionPrefix(parts.sectionNumber),
    parts.typeCode,
    // A placeholder that reads as a gap rather than as a value. Anyone
    // scanning a folder sees immediately that it is unfinished.
    parts.identifier?.trim() ? toDescriptor(parts.identifier) : 'NOID',
    parts.descriptor,
    parts.documentDate ? parts.documentDate.replace(/-/g, '') : 'NODATE',
    `R${Math.max(0, parts.revision)}`,
  ].filter(Boolean)

  const ext = parts.extension.replace(/^\./, '').toLowerCase()
  return {
    filename: `${segments.join('-')}${ext ? `.${ext}` : ''}`,
    missing,
    conforming: missing.length === 0,
  }
}

export interface NameIssue {
  code: 'spaces' | 'forbidden_character' | 'status_word' | 'no_section_prefix'
      | 'unknown_type' | 'date_not_iso' | 'no_revision'
  message: string
}

/**
 * Check a name that already exists against the convention.
 *
 * Used on documents that arrived before the convention, and on anything a
 * person typed by hand. Reports every rule it breaks rather than the first,
 * because a Custodian fixing a backlog wants the whole list.
 */
export function checkFilename(filename: string): NameIssue[] {
  const issues: NameIssue[] = []
  const stem = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '')

  if (/\s/.test(filename)) {
    issues.push({ code: 'spaces',
      message: 'Appendix B forbids spaces. Use hyphens between words.' })
  }
  const bad = FORBIDDEN_CHARS.exec(filename)
  if (bad) {
    issues.push({ code: 'forbidden_character',
      message: `"${bad[0]}" is not permitted in a filename. ` +
        'Apostrophes, ampersands, slashes, commas, parentheses and status ' +
        'characters are all forbidden.' })
  }
  const word = STATUS_WORDS.find((w) =>
    new RegExp(`(^|[\\s_-])${w}([\\s_-]|$)`, 'i').test(stem))
  if (word) {
    issues.push({ code: 'status_word',
      message: `"${word}" describes status, which belongs in a recorded ` +
        'field with an owner and a date, not in a filename.' })
  }

  const segments = stem.split('-')
  if (!/^(\d{2}|\d{1,2}-\d{1,2}|S\d)$/i.test(segments[0] ?? '')) {
    issues.push({ code: 'no_section_prefix',
      message: 'The name must start with its two-digit section number, so ' +
        'the file sorts into its section.' })
  }
  const typeSegment = segments[1]?.toUpperCase() ?? ''
  if (!Object.prototype.hasOwnProperty.call(TYPE_CODES, typeSegment)) {
    issues.push({ code: 'unknown_type',
      message: 'The second element must be an Appendix B document type code ' +
        `(${Object.keys(TYPE_CODES).slice(0, 6).join(', ')}, …).` })
  }
  if (!/(^|-)\d{8}(-|$)/.test(stem)) {
    issues.push({ code: 'date_not_iso',
      message: 'The name must carry the date the document itself bears, as ' +
        'YYYYMMDD, so files sort chronologically.' })
  }
  if (!/-R\d+$/i.test(stem)) {
    issues.push({ code: 'no_revision',
      message: 'The name must end with a revision, R0 for first issue.' })
  }
  return issues
}
