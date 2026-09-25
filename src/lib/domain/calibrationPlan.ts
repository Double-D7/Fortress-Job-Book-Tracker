/**
 * Filing a torque-wrench calibration certificate.
 *
 * Every piece of this existed except the middle. The certificate reader
 * parses the page, the schema holds every field it yields, and four flag
 * rules in section 13 are written against those fields — and there has
 * never been a way for a person to put a certificate into the book. The
 * reader was reachable only from its own test. So the rules ran against
 * columns nothing could fill, and `torque.certificate_unread` reported,
 * accurately and permanently, that this application had not read a page
 * it had no means of being given.
 *
 * ## What filing a certificate does
 *
 * It changes the verdict on work already recorded. A connection torqued
 * with wrench 5155 reads `certificate_unread` today; once the certificate
 * is filed it reads `valid`, or `expired`, or — the case this application
 * exists to catch — `not_yet_issued`, because the calibration postdates
 * the work it is supposed to certify. That retroactive effect is the
 * whole point and it is what the preview shows: how many findings this
 * page answers, and how many it raises.
 *
 * Raising findings is not a reason to hold the import. A wrench whose
 * calibration had lapsed torqued those flanges whether or not the
 * certificate is on file; filing it is what lets the book say so.
 *
 * ## What is refused
 *
 * A certificate is not written as a calibration window when the page does
 * not support one:
 *
 *   · no calibration date read — the page is filed and marked unread,
 *     which is the honest record and what §13 already reports,
 *   · the lab failed the wrench — a failure is not a calibration, and
 *     writing its dates as a window would certify work with equipment
 *     that did not pass,
 *   · the due date precedes the calibration date — a transcription error
 *     the database would reject anyway,
 *   · an older certificate than the one already on file, or than another
 *     in the same batch — filing yesterday's page over today's would
 *     silently roll a wrench's calibration backwards.
 *
 * Each of those is reported against the file that caused it. Nothing is
 * dropped quietly; a certificate that cannot be written is a certificate
 * somebody has to look at.
 */
import type { IsoDate, TorqueConnection, TorqueWrench } from './types'
import type { ParsedCalibrationCertificate } from '@/lib/import/calibrationCertificate'
import { checkWrenchCalibration } from './torque'

/** Which wrench, if any, this certificate belongs to. */
export type CertMatch =
  /** Exactly one managed wrench carries this serial's last four. */
  | 'matched'
  /** No wrench record, but connections in this book name that wrench. */
  | 'new_wrench'
  /** A real certificate for a wrench this book never used. */
  | 'unused'
  /** Two managed wrenches share the last four. Never guessed. */
  | 'ambiguous'
  /** The page yielded no serial number to match on. */
  | 'no_serial'

/** What this certificate can be recorded as. */
export type CertDisposition =
  /** A calibration window: dates read, wrench passed, order sane. */
  | 'calibration'
  /** Filed, but its dates could not be read. Recorded as on file. */
  | 'unread'
  /** The lab failed the wrench. Recorded, never as a window. */
  | 'failed'
  /** Due date precedes the calibration date. */
  | 'window_reversed'
  /** An older certificate than one already on file or in this batch. */
  | 'superseded'

/**
 * How the book's own findings move if this certificate is filed.
 *
 * Counted over the connections this book torqued with the wrench, by
 * running the same calibration check before and after.
 */
export interface CalibrationEffect {
  /** Connections in this book torqued with this wrench. */
  connections: number
  /** Connections whose calibration currently cannot be checked and which
   *  the certificate settles as valid. Findings this page answers. */
  resolved: number
  /**
   * Connections this certificate leaves uncertified. Findings it raises.
   *
   * Torqued outside the calibration window, or — for a wrench the
   * laboratory failed — every connection it touched, since a failed
   * wrench has no window for any of them to fall inside.
   */
  exposed: number
}

export interface CalibrationRow {
  filename: string
  serialNumber: string | null
  /** Trailing four digits — how the torque log names the wrench. */
  wrenchId: string | null
  match: CertMatch
  /** The matched wrench's record id, where there is a record. */
  matchedWrenchId: string | null
  disposition: CertDisposition
  /** Whether committing this import writes anything for this file. */
  writable: boolean
  dateCalibrated: IsoDate | null
  calibrationDueDate: IsoDate | null
  /**
   * The roster's claim where it contradicts the certificate.
   *
   * Kept beside the certificate rather than instead of it. On the Greeley
   * book one roster line transcribes the date the wrench went into
   * service as its calibration date.
   */
  rosterDisagrees: { claimed: IsoDate; certificate: IsoDate } | null
  effect: CalibrationEffect
  /** Everything a person needs to act on, in their own language. */
  notes: string[]
  parsed: ParsedCalibrationCertificate
}

export interface CalibrationPlan {
  rows: CalibrationRow[]
}

export interface CalibrationCounts {
  files: number
  /** Files that write anything at all — what the button files. */
  writes: number
  /** Files that will write a calibration window. */
  calibrations: number
  /** Files recorded as on file but unread. */
  unread: number
  /** Files that write nothing and need a person. */
  held: number
  wrenchesCreated: number
  connectionsResolved: number
  connectionsExposed: number
}

const NO_EFFECT: CalibrationEffect = { connections: 0, resolved: 0, exposed: 0 }

/** Connections this book torqued with a given wrench. */
function connectionsFor(
  connections: readonly TorqueConnection[],
  wrench: TorqueWrench | null,
  wrenchId: string | null,
): TorqueConnection[] {
  return connections.filter((c) =>
    (wrench !== null && c.wrenchId === wrench.id) ||
    (wrenchId !== null && c.wrenchIdRaw === wrenchId))
}

/**
 * The verdicts before and after, over the connections that use the wrench.
 *
 * Run through `checkWrenchCalibration` rather than reimplemented, so this
 * preview and the flag queue can never disagree about what a date means.
 */
function effectOf(
  used: TorqueConnection[],
  before: TorqueWrench | null,
  after: TorqueWrench,
): CalibrationEffect {
  let resolved = 0
  let exposed = 0
  for (const c of used) {
    const wasVerdict = before
      ? checkWrenchCalibration(c, [before]).verdict
      : 'unknown_wrench'
    const nowVerdict = checkWrenchCalibration(c, [after]).verdict
    if (nowVerdict === wasVerdict) continue
    if (nowVerdict === 'valid') resolved += 1
    else if (nowVerdict === 'expired' || nowVerdict === 'not_yet_issued') exposed += 1
  }
  return { connections: used.length, resolved, exposed }
}

/** The wrench as it would stand with this certificate filed. */
export function applyCertificate(
  wrench: TorqueWrench | null,
  wrenchId: string,
  cert: ParsedCalibrationCertificate,
  disposition: CertDisposition,
): TorqueWrench {
  const base: TorqueWrench = wrench ?? {
    id: '', wrenchId, certOnFile: false, onRoster: false,
  }
  // Every disposition records that the page is on file — that much is
  // true of an unreadable scan as much as a clean one. Only a readable,
  // passing certificate writes the window.
  const writesWindow = disposition === 'calibration'
  return {
    ...base,
    certOnFile: true,
    certRead: disposition !== 'unread',
    lastCalibrationDate: writesWindow ? cert.dateCalibrated : base.lastCalibrationDate ?? null,
    calibrationDueDate: writesWindow ? cert.calibrationDueDate : base.calibrationDueDate ?? null,
    serialNumber: cert.serialNumber ?? base.serialNumber ?? null,
    manufacturer: cert.manufacturer ?? base.manufacturer ?? null,
    model: cert.model ?? base.model ?? null,
    certificateNumber: cert.certificateNumber ?? base.certificateNumber ?? null,
    calibrationRangeMinFtLb: cert.rangeMinFtLb ?? base.calibrationRangeMinFtLb ?? null,
    calibrationRangeMaxFtLb: cert.rangeMaxFtLb ?? base.calibrationRangeMaxFtLb ?? null,
    calibrationFrequency: cert.calibrationFrequency ?? base.calibrationFrequency ?? null,
    calibrationStatus: cert.finalStatus ?? base.calibrationStatus ?? null,
  }
}

export function planCalibrationImport(
  certificates: readonly { filename: string; parsed: ParsedCalibrationCertificate }[],
  wrenches: readonly TorqueWrench[],
  connections: readonly TorqueConnection[],
): CalibrationPlan {
  // The newest calibration date claimed so far for each wrench, across the
  // batch and the records already on file. A certificate older than this
  // is filed but never written, because rolling a wrench's calibration
  // backwards is not something a person would mean to do.
  const newestOnFile = new Map<string, IsoDate>()
  for (const w of wrenches) {
    if (w.lastCalibrationDate) newestOnFile.set(w.wrenchId, w.lastCalibrationDate)
  }

  const rows: CalibrationRow[] = []

  for (const { filename, parsed } of certificates) {
    const notes: string[] = [...parsed.warnings]
    const wrenchId = parsed.wrenchId

    if (!wrenchId) {
      notes.push(parsed.status === 'no_text_layer'
        ? 'No text could be read from this page at all — a photograph or an unscanned ' +
          'page. It needs OCR, or its dates keying in by hand.'
        : 'No serial number was found on this page, so there is nothing to match a ' +
          'wrench on.')
      rows.push({
        filename, serialNumber: parsed.serialNumber, wrenchId: null,
        match: 'no_serial', matchedWrenchId: null, disposition: 'unread',
        writable: false, dateCalibrated: parsed.dateCalibrated,
        calibrationDueDate: parsed.calibrationDueDate, rosterDisagrees: null,
        effect: NO_EFFECT, notes, parsed,
      })
      continue
    }

    const candidates = wrenches.filter((w) => w.wrenchId === wrenchId)
    const used = connectionsFor(connections, candidates[0] ?? null, wrenchId)

    let match: CertMatch
    if (candidates.length > 1) match = 'ambiguous'
    else if (candidates.length === 1) match = 'matched'
    else if (used.length > 0) match = 'new_wrench'
    else match = 'unused'

    const wrench = candidates.length === 1 ? candidates[0]! : null

    // Disposition, in the order a person would check it. Superseded is
    // tested first because an old page is not worth reporting a due-date
    // problem on — it is not going to be written either way.
    let disposition: CertDisposition
    const priorDate = newestOnFile.get(wrenchId) ?? null
    if (parsed.dateCalibrated && priorDate && parsed.dateCalibrated < priorDate) {
      disposition = 'superseded'
      notes.push(
        `This certificate is dated ${parsed.dateCalibrated}; wrench ${wrenchId} already ` +
        `carries a calibration dated ${priorDate}. The newer one stands. Filing this ` +
        `page would roll the wrench's calibration backwards, so its dates are not written.`)
    } else if (parsed.finalStatus === 'fail') {
      disposition = 'failed'
      notes.push(
        `The laboratory failed wrench ${wrenchId} on this certificate. A failure is not a ` +
        `calibration, so no window is recorded${used.length > 0
          ? `, and the ${used.length} connection${used.length === 1 ? '' : 's'} torqued with ` +
            `this wrench need reviewing against whatever calibration preceded it`
          : ''}.`)
    } else if (!parsed.dateCalibrated) {
      disposition = 'unread'
      notes.push(
        'The certificate is recorded as on file, but no calibration date could be read ' +
        'from it, so the calibration window stays unknown. Section 13 reports this as an ' +
        'ingestion gap rather than as a missing certificate.')
    } else if (
      parsed.calibrationDueDate && parsed.calibrationDueDate < parsed.dateCalibrated
    ) {
      disposition = 'window_reversed'
      notes.push(
        `This page reads calibrated ${parsed.dateCalibrated} and due ` +
        `${parsed.calibrationDueDate} — the window closes before it opens. One of the two ` +
        `dates is a transcription error and the page needs checking by eye.`)
    } else {
      disposition = 'calibration'
    }

    // Ambiguity overrides everything: a certificate written onto the wrong
    // wrench certifies work it never touched, which is worse than a
    // certificate left unfiled.
    if (match === 'ambiguous') {
      notes.push(
        `${candidates.length} managed wrenches end in ${wrenchId}, so this certificate ` +
        `cannot be attributed to one of them. Give the wrenches their full serials, or ` +
        `file this page against the right wrench by hand.`)
    }
    if (match === 'unused') {
      notes.push(
        `No connection in this book was torqued with wrench ${wrenchId}, and no wrench ` +
        `record carries that number. The certificate is genuine but belongs to another ` +
        `job, so nothing here is written.`)
    }

    const writable =
      (match === 'matched' || match === 'new_wrench') &&
      disposition !== 'superseded' &&
      disposition !== 'window_reversed'

    const after = applyCertificate(wrench, wrenchId, parsed, disposition)
    // A failed wrench exposes everything it touched. Reporting nothing
    // there would be the worst reading on this screen: filing the page
    // that proves the tool was out of tolerance, under a headline saying
    // it raises no findings.
    const effect = !writable
      ? { ...NO_EFFECT, connections: used.length }
      : disposition === 'calibration'
        ? effectOf(used, wrench, after)
        : disposition === 'failed'
          ? {
              connections: used.length, resolved: 0,
              exposed: used.filter((c) => c.torqueDate).length,
            }
          : { ...NO_EFFECT, connections: used.length }

    const claimed = wrench?.rosterClaimedCalibrationDate ?? null
    const rosterDisagrees =
      claimed && parsed.dateCalibrated && claimed !== parsed.dateCalibrated
        ? { claimed, certificate: parsed.dateCalibrated }
        : null
    if (rosterDisagrees) {
      notes.push(
        `The torque log's roster records this wrench as last calibrated ` +
        `${rosterDisagrees.claimed}; the certificate is dated ` +
        `${rosterDisagrees.certificate}. The certificate is the calibration record and is ` +
        `what the book scores against. Both are kept so the disagreement stays visible.`)
    }

    if (writable && disposition === 'calibration' && parsed.dateCalibrated) {
      newestOnFile.set(wrenchId, parsed.dateCalibrated)
    }

    rows.push({
      filename,
      serialNumber: parsed.serialNumber,
      wrenchId,
      match,
      matchedWrenchId: wrench?.id ?? null,
      disposition,
      writable,
      dateCalibrated: parsed.dateCalibrated,
      calibrationDueDate: parsed.calibrationDueDate,
      rosterDisagrees,
      effect,
      notes,
      parsed,
    })
  }

  return { rows }
}

export function countCalibrationPlan(plan: CalibrationPlan): CalibrationCounts {
  const w = plan.rows.filter((r) => r.writable)
  return {
    files: plan.rows.length,
    writes: w.length,
    calibrations: w.filter((r) => r.disposition === 'calibration').length,
    unread: w.filter((r) => r.disposition === 'unread').length,
    held: plan.rows.filter((r) => !r.writable).length,
    wrenchesCreated: new Set(
      w.filter((r) => r.match === 'new_wrench').map((r) => r.wrenchId),
    ).size,
    connectionsResolved: w.reduce((s, r) => s + r.effect.resolved, 0),
    connectionsExposed: w.reduce((s, r) => s + r.effect.exposed, 0),
  }
}
