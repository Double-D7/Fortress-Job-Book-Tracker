/**
 * Certificate validity.
 *
 * One rule governs every certificate in the book, whatever its subject:
 * validity is evaluated against the date the work was performed, not
 * against today. A technician whose card expired last month is fine for
 * reports written while it was live; a report dated after expiry is a
 * finding even if the card is renewed by the time an auditor looks.
 */
import type { Certificate, CertSubjectType, IsoDate } from './types'
import { addDays, isWithin, today } from './dates'

/**
 * How long a calibration stands when the certificate does not say.
 *
 * Fortress recalibrates on a twelve-month cycle unless a client requires
 * shorter — some require six — so the interval belongs to the job book
 * and this is only the fallback.
 */
export const DEFAULT_CALIBRATION_INTERVAL_MONTHS = 12

/**
 * Subjects whose certificate is a calibration.
 *
 * The distinction decides whether a blank expiry may be filled in. A
 * calibration has an interval by its nature: an instrument drifts, and a
 * laboratory that states no due date has not certified it for ever. A
 * person's certification states its own validity — a CWI card carries an
 * expiry, and a welder's qualification runs on continuity rather than on
 * a date — so inventing one for them would raise findings out of thin
 * air.
 */
const CALIBRATION_SUBJECTS: ReadonlySet<CertSubjectType> =
  new Set<CertSubjectType>(['torque_wrench', 'pressure_recorder'])

export function isCalibration(subjectType: CertSubjectType): boolean {
  return CALIBRATION_SUBJECTS.has(subjectType)
}

/** `2025-04-23` plus twelve months is `2026-04-23`. */
export function addMonths(d: IsoDate, months: number): IsoDate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1 + months, 1))
  // Clamp to the end of the target month: 31 August plus six months is
  // 28 February, not 3 March.
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate()
  dt.setUTCDate(Math.min(day, lastDay))
  return dt.toISOString().slice(0, 10)
}

/**
 * The date a certificate stops covering work.
 *
 * The date the laboratory printed, where it printed one. Otherwise, for a
 * calibration, the issue date plus the job's interval — because the two
 * instrument certificates this was built against print none at all. The
 * Crystal nVision states a calibration date of 23 April 2025 and no
 * expiry, and treating that as unbounded certified a pressure test ten
 * years later.
 *
 * Null means genuinely open-ended: a person's certificate with no printed
 * expiry, or a calibration whose issue date has not been read.
 */
export function effectiveExpiry(
  cert: Pick<Certificate, 'subjectType' | 'issueDate' | 'expiryDate'>,
  intervalMonths: number = DEFAULT_CALIBRATION_INTERVAL_MONTHS,
): IsoDate | null {
  if (cert.expiryDate) return cert.expiryDate
  if (!cert.issueDate || !isCalibration(cert.subjectType)) return null
  return addMonths(cert.issueDate, intervalMonths)
}

/** Whether the expiry was printed on the page or derived from the job's
 *  interval — a person reading the screen should be told which. */
export function expiryIsDerived(
  cert: Pick<Certificate, 'subjectType' | 'issueDate' | 'expiryDate'>,
): boolean {
  return !cert.expiryDate && !!cert.issueDate && isCalibration(cert.subjectType)
}

export type CertStatus = 'valid' | 'expiring_soon' | 'expired' | 'missing'

export interface CertEvaluation {
  status: CertStatus
  certificate: Certificate | null
  expiresOn: IsoDate | null
  daysUntilExpiry: number | null
}

/** Status as of a reference date — how the certificate looks *now*. */
export function evaluateCert(
  cert: Certificate | null,
  warningDays: number,
  asOf: IsoDate = today(),
): CertEvaluation {
  if (!cert) return { status: 'missing', certificate: null, expiresOn: null, daysUntilExpiry: null }
  const expires = cert.expiryDate ?? null
  if (!expires) {
    return { status: 'valid', certificate: cert, expiresOn: null, daysUntilExpiry: null }
  }
  const days = Math.round(
    (Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000,
  )
  const status: CertStatus =
    days < 0 ? 'expired' : days <= warningDays ? 'expiring_soon' : 'valid'
  return { status, certificate: cert, expiresOn: expires, daysUntilExpiry: days }
}

/**
 * Was any certificate of this type valid on the date the work happened?
 * This — not `evaluateCert` — is the question that produces audit findings.
 */
export function certValidOn(
  certs: Certificate[],
  subjectType: Certificate['subjectType'],
  subjectId: string,
  workDate: IsoDate,
  certType?: string,
  intervalMonths: number = DEFAULT_CALIBRATION_INTERVAL_MONTHS,
): Certificate | null {
  return (
    certs.find(
      (c) =>
        c.subjectType === subjectType &&
        c.subjectId === subjectId &&
        (!certType || c.certType === certType) &&
        // No issue date means the certificate has not been read. An
        // unbounded window would make every unread page certify every
        // date, which is exactly backwards.
        !!c.issueDate &&
        isWithin(workDate, c.issueDate, effectiveExpiry(c, intervalMonths)),
    ) ?? null
  )
}

/** Full cert history for a subject, newest first. Some welders hold an
 *  original plus a requalification; the history is the record, not just the
 *  current card. */
export function certHistory(
  certs: Certificate[],
  subjectType: Certificate['subjectType'],
  subjectId: string,
): Certificate[] {
  return certs
    .filter((c) => c.subjectType === subjectType && c.subjectId === subjectId)
    // Unread certificates sort last: they carry no date to order by.
    .sort((a, b) => (a.issueDate ?? '') < (b.issueDate ?? '') ? 1 : -1)
}

export interface UpcomingExpiry {
  certificate: Certificate
  expiresOn: IsoDate
  daysUntilExpiry: number
}

/** Certificates lapsing inside the window, for the expiry calendar. */
export function upcomingExpiries(
  certs: Certificate[],
  withinDays: number,
  asOf: IsoDate = today(),
): UpcomingExpiry[] {
  const horizon = addDays(asOf, withinDays)
  return certs
    .filter((c) => c.expiryDate && c.expiryDate >= asOf && c.expiryDate <= horizon)
    .map((c) => ({
      certificate: c,
      expiresOn: c.expiryDate!,
      daysUntilExpiry: Math.round(
        (Date.parse(`${c.expiryDate!}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000,
      ),
    }))
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry)
}
