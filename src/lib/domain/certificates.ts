/**
 * Certificate validity.
 *
 * One rule governs every certificate in the book, whatever its subject:
 * validity is evaluated against the date the work was performed, not
 * against today. A technician whose card expired last month is fine for
 * reports written while it was live; a report dated after expiry is a
 * finding even if the card is renewed by the time an auditor looks.
 */
import type { Certificate, IsoDate } from './types'
import { addDays, isWithin, today } from './dates'

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
        isWithin(workDate, c.issueDate, c.expiryDate ?? null),
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
