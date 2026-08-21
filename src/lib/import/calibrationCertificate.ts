/**
 * Torque-wrench calibration certificate reader.
 *
 * The certificate *is* the calibration record. Section 13 of a Greeley-style
 * facility book holds one scanned certificate per wrench, and every fact this
 * application needs about a wrench's calibration window is printed on that
 * page — serial number, date calibrated, due date, range, pass/fail. Treating
 * a filed certificate as "no calibration on record" because nobody had keyed
 * a date into a spreadsheet was a defect in this application, not in the book.
 *
 * The certificates come from two labs in a shared layout (HYTORC wrenches
 * calibrated by UNEX, Gearwrench by the same house), so one parser covers
 * both. Some pages are photographs of paper and some are text PDFs; this
 * module parses whatever text layer exists and reports honestly when a page
 * yields nothing, so an unreadable scan is recorded as unread rather than
 * silently becoming an absence.
 */
import { parseLooseDate } from '@/lib/domain/dates'

export type CertificateReadStatus =
  /** A text layer was present and the required fields were found. */
  | 'parsed'
  /** Text was present but the calibration date was not among it. */
  | 'partial'
  /** No text layer at all — a scan awaiting OCR or manual entry. */
  | 'no_text_layer'

export interface ParsedCalibrationCertificate {
  status: CertificateReadStatus
  /** Full serial as printed, e.g. `0125115155`. */
  serialNumber: string | null
  /** Trailing four digits, which is how the torque log names the wrench. */
  wrenchId: string | null
  certificateNumber: string | null
  manufacturer: string | null
  model: string | null
  /** As printed, e.g. `30-250 Lb.ft`. */
  rangeLabel: string | null
  rangeMinFtLb: number | null
  rangeMaxFtLb: number | null
  dateCalibrated: string | null
  calibrationDueDate: string | null
  /** As printed: `1 Year`, `n/a`, … */
  calibrationFrequency: string | null
  finalStatus: 'pass' | 'fail' | null
  /** Handwritten annotations that are *not* the calibration date. Kept
   *  because one of them was mistaken for one. */
  annotations: string[]
  warnings: string[]
}

const EMPTY: ParsedCalibrationCertificate = {
  status: 'no_text_layer',
  serialNumber: null, wrenchId: null, certificateNumber: null,
  manufacturer: null, model: null, rangeLabel: null,
  rangeMinFtLb: null, rangeMaxFtLb: null,
  dateCalibrated: null, calibrationDueDate: null,
  calibrationFrequency: null, finalStatus: null,
  annotations: [], warnings: [],
}

/**
 * Does this line open a labelled field of its own?
 *
 * Certificates lay fields out in two columns, so a label's value sometimes
 * sits on the line below it. That fallback has to stop at the next label,
 * or a genuinely blank field silently adopts the following field's value —
 * which is how `Calibration Due Date:` (blank on wrench 0808's page) read
 * as `Calibration Frequency: n/a`, and how a wrench with no stated expiry
 * would have acquired one.
 */
function startsNewField(line: string): boolean {
  return /^[A-Za-z][A-Za-z0-9 .#/&'-]{1,40}\s*[:#]/.test(line)
}

/** Value following a label on the same line, or on the next non-empty one
 *  that is not itself a label. */
function fieldAfter(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const m = label.exec(line)
    if (!m) continue
    const tail = line.slice(m.index + m[0].length).replace(/^[\s:#-]+/, '').trim()
    if (tail) return tail
    for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
      const next = lines[j]?.trim()
      if (!next) continue
      return startsNewField(next) ? null : next
    }
    return null
  }
  return null
}

/** `30-250 Lb.ft`, `200 - 1000 lb-ft`, `30 to 250 ft.lbs`. */
export function parseRangeLabel(
  raw: string | null,
): { min: number | null; max: number | null } {
  if (!raw) return { min: null, max: null }
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d[\d,]*(?:\.\d+)?)/i.exec(raw)
  if (!m || !m[1] || !m[2]) return { min: null, max: null }
  return { min: Number(m[1].replace(/,/g, '')), max: Number(m[2].replace(/,/g, '')) }
}

/**
 * Phrases that carry a date but are *not* the calibration date.
 *
 * `DATE WRENCH PUT IN SERVICE` is here because the Greeley torque log's
 * roster block transcribes exactly that field as wrench 0808's calibration
 * date — 2025-02-04 against a certificate calibrated 2025-01-10. Anything
 * matching these is captured as an annotation and never as a calibration.
 */
const NON_CALIBRATION_DATE_LABELS = [
  /DATE\s+WRENCH\s+PUT\s+IN\s+SERVICE/i,
  /RECEIPT\s+DATE/i,
  /DATE\s+RECEIVED/i,
  /SHIP(?:PED)?\s+DATE/i,
]

export function parseCalibrationCertificate(text: string): ParsedCalibrationCertificate {
  const trimmed = text.trim()
  if (!trimmed) return { ...EMPTY }

  const lines = trimmed.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim())
  const warnings: string[] = []
  const annotations: string[] = []

  const serialRaw = fieldAfter(lines, /SERIAL\s*(?:NO\.?|NUMBER|#)?/i)
  const serial = serialRaw ? (/[0-9]{4,}/.exec(serialRaw)?.[0] ?? null) : null

  const dateCalRaw = fieldAfter(lines, /DATE\s+CALIBRATED/i)
  const dueRaw = fieldAfter(lines, /CALIBRATION\s+DUE\s*(?:DATE)?/i)
  const freq = fieldAfter(lines, /(?:CALIBRATION\s+)?FREQUENCY/i)
  const certNo = fieldAfter(lines, /(?:CERTIFICATE|CERT\.?)\s*(?:NO\.?|NUMBER|#)/i)
  const model = fieldAfter(lines, /MODEL\s*(?:NO\.?|NUMBER|#)?/i)
  const mfr = fieldAfter(lines, /(?:MANUFACTURER|MFR\.?)/i)
  const rangeLabel = fieldAfter(lines, /RANGE(?:\s+AND\s+UNITS)?/i)

  for (const line of lines) {
    for (const label of NON_CALIBRATION_DATE_LABELS) {
      if (label.test(line)) annotations.push(line)
    }
  }

  const dateCalibrated = parseLooseDate(dateCalRaw ?? '')
  if (dateCalRaw && !dateCalibrated) {
    warnings.push(`Certificate reads "DATE CALIBRATED: ${dateCalRaw}", which is not a date.`)
  }

  let due = parseLooseDate(dueRaw ?? '')
  if (dueRaw && !due) {
    warnings.push(`Certificate reads "Calibration Due Date: ${dueRaw}", which is not a date.`)
  }
  if (!dueRaw && dateCalibrated) {
    // A blank due date on a page that also says "n/a" frequency is a lab
    // that did not commit to an interval. It is left blank rather than
    // inferred, because inventing a due date invents an expiry.
    warnings.push('Certificate carries a calibration date but no due date; the ' +
      'calibration window has no stated end.')
    due = null
  }

  const statusRaw = fieldAfter(lines, /(?:FINAL\s+)?(?:CALIBRATION\s+)?STATUS/i)
  const finalStatus = statusRaw
    ? /pass/i.test(statusRaw) ? 'pass' as const
      : /fail/i.test(statusRaw) ? 'fail' as const : null
    : null

  const range = parseRangeLabel(rangeLabel)
  const found = [serial, dateCalibrated, certNo].filter(Boolean).length

  return {
    status: dateCalibrated ? 'parsed' : found ? 'partial' : 'partial',
    serialNumber: serial,
    wrenchId: serial ? serial.slice(-4) : null,
    certificateNumber: certNo,
    manufacturer: mfr,
    model,
    rangeLabel,
    rangeMinFtLb: range.min,
    rangeMaxFtLb: range.max,
    dateCalibrated,
    calibrationDueDate: due,
    calibrationFrequency: freq,
    finalStatus,
    annotations,
    warnings,
  }
}
