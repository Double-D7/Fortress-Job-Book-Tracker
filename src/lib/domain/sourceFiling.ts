/**
 * Keeping the file an import was made from.
 *
 * Every importer in this application reads an original — a vendor's NDE
 * report, a signed weld log, a calibration certificate — turns it into
 * rows, and until now dropped the file on the floor. The rows are what
 * the screens read, so nothing looked wrong. What was missing only shows
 * up when somebody asks to see the document the numbers came from.
 *
 * For a job book that gets submitted, that is the whole ballgame. The
 * rows are this application's reading of a document; the document is the
 * record. An auditor does not accept "our system says the technician
 * examined weld 12" — they ask for the report with the vendor's letterhead
 * and the technician's signature on it. §15 retention is a promise about
 * the original, and a parsed copy of its contents does not discharge it.
 *
 * It also had a second, quieter cost. The nightly backup copies rows from
 * `document`, so a file that was never filed was never backed up either.
 * The archive could not have contained an NDE report, because nothing in
 * the application had one.
 *
 * ## What this module decides, and what it does not
 *
 * It decides where a source file belongs and whether the book already
 * holds it. The writing — bytes to the bucket, row to the table — stays
 * in the provider, because that is where the transaction and the failure
 * handling live. Keeping the decisions here means they can be tested
 * without a database, and means the section a file lands in is stated
 * once rather than spelled out at six call sites that would drift.
 */

/**
 * The kinds of original this application reads.
 *
 * Named for the document rather than the importer, because two importers
 * can consume the same kind of paper and the filing follows the paper.
 */
export type SourceKind =
  | 'nde_report'
  | 'weld_log_overview'
  | 'weld_log'
  | 'calibration_certificate'
  | 'pressure_recorder_certificate'
  | 'torque_log'
  | 'pressure_test'
  // The two personnel credentials. Filed by hand rather than parsed: a
  // CWI card and an ASNT card are a photograph of a wallet card more
  // often than a document, and guessing a certification date off one
  // would be guessing about whether somebody was qualified.
  | 'cwi_certificate'
  | 'ndt_certificate'

/**
 * Where each original is filed, by the book's own section numbering.
 *
 * These are the sections the standard puts them in, not a convenience
 * grouping. A calibration certificate for a torque wrench belongs in 13
 * and the same certificate for a pressure recorder belongs in 17, because
 * that is where somebody auditing a pressure test will look for it.
 */
export const SOURCE_SECTION: Record<SourceKind, string> = {
  nde_report: '10',
  weld_log_overview: '11',
  weld_log: '12',
  calibration_certificate: '13',
  torque_log: '14',
  pressure_test: '17',
  pressure_recorder_certificate: '17',
  cwi_certificate: '7',
  ndt_certificate: '8',
}

export function sourceSection(kind: SourceKind): string {
  return SOURCE_SECTION[kind]
}

/**
 * Where the bytes go in the bucket.
 *
 * Content-addressed, matching what the manual upload path does: the same
 * bytes land on the same path, so a retry after a half-finished request
 * overwrites rather than orphaning.
 */
export function sourceStoragePath(
  jobBookId: string, sectionNumber: string, sha256: string,
): string {
  return `${jobBookId}/${sectionNumber}/${sha256}`
}

/**
 * What the file is, for the stored object.
 *
 * Set explicitly rather than left to the storage layer to guess, because
 * it decides whether a browser opens the document or downloads a blob
 * named after a hash — and, once the backup has copied it, whether
 * SharePoint previews it in place. `application/octet-stream` is the
 * honest answer for anything unrecognised; a wrong specific type is worse
 * than an unspecific one.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
}

export function sourceMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

/** The parts of a document this module needs to recognise one. */export interface FiledDocument {
  id: string
  sha256: string
  sectionId?: string | null
}

/**
 * The document already holding these bytes, if the book has one.
 *
 * Importing the same file twice is ordinary — somebody re-runs a report
 * after fixing a weld number, or two people import the same PDF — and it
 * must not file a second copy. Matched on the hash rather than the
 * filename, because the same document arrives under different names and
 * two genuinely different documents can share one.
 *
 * Superseded documents count. The bytes are still held and still
 * retained; filing a fresh copy of something the book already has would
 * make the retention folder keep two of it.
 */
export function alreadyFiled(
  documents: readonly FiledDocument[], sha256: string,
): FiledDocument | null {
  if (!sha256) return null
  return documents.find((d) => d.sha256 === sha256) ?? null
}

/**
 * Why a source file could not be filed, in words that name the fix.
 *
 * A book missing the section its originals belong in is a scaffolding
 * problem, not something the person importing can do anything about from
 * the import screen — so it says which section, rather than failing with
 * a generic refusal.
 */
export function missingSectionMessage(kind: SourceKind, sectionNumber: string): string {
  return `This book has no section ${sectionNumber}, which is where a ` +
    `${kind.replace(/_/g, ' ')} is filed. The import read the file but ` +
    `could not keep it, so nothing was written.`
}
