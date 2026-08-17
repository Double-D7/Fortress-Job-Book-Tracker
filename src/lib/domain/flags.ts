/**
 * Automated compliance flags (§6).
 *
 * Every rule is a pure function from a bundle to a list of findings, so the
 * whole rule set can be re-evaluated on demand, in a test, or inside the
 * import preview before a single row is committed.
 *
 * Each finding carries a `fingerprint` that is stable across runs and
 * derived from the rule and the offending entity — never from a timestamp
 * or an array index. That is what lets a manager resolve a flag once and
 * have it stay resolved, while a genuinely new occurrence still appears.
 */
import type {
  ComplianceFlag, FlagSeverity, IsoDate, JobBookBundle, Weld,
} from './types'
import { today } from './dates'
import { certValidOn, evaluateCert } from './certificates'
import { checkWrenchCalibration, isInspected, reconcileWrenches, suggestWrenchTypo, torqueTotals, torqueWithinTolerance } from './torque'
import { creditedWelders, isCountable, isXrayed, qualifiedOn, rollupByWelder } from './welders'
import { reconcileCp, reconcileHeats } from './reconcile'

export interface Finding {
  ruleId: string
  severity: FlagSeverity
  title: string
  detail: string
  entityType?: string
  entityId?: string
  sectionNumber?: string
  fingerprint: string
}

export interface FlagContext {
  /** Evaluation date. Injectable so tests are not time-dependent. */
  asOf?: IsoDate
}

const fp = (...parts: (string | number | null | undefined)[]) =>
  parts.filter((p) => p != null && p !== '').join('|')

/** Findings are capped per rule so one systemic problem cannot bury the
 *  rest of the queue; the count of suppressed items is reported instead. */
const MAX_PER_RULE = 50

function cap(ruleId: string, findings: Finding[]): Finding[] {
  if (findings.length <= MAX_PER_RULE) return findings
  const shown = findings.slice(0, MAX_PER_RULE)
  const first = findings[0]!
  shown.push({
    ruleId: `${ruleId}.truncated`,
    severity: first.severity,
    title: `${findings.length - MAX_PER_RULE} further occurrences not listed individually`,
    detail: `Rule ${ruleId} matched ${findings.length} records. The first ${MAX_PER_RULE} are listed; ` +
      `use the record grid filtered to this condition to see the rest.`,
    fingerprint: fp(ruleId, 'truncated'),
  })
  return shown
}

// ---------------------------------------------------------------------
// Critical rules
// ---------------------------------------------------------------------

/** A weld performed on a date when the welder held no active qualification. */
export function ruleWelderNotQualified(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const w of b.welds) {
    if (!isCountable(w) || !w.weldDate) continue
    for (const welderId of creditedWelders(w)) {
      if (qualifiedOn(welderId, w.weldDate, b.welderQualifications)) continue
      const welder = b.welders.find((x) => x.id === welderId)
      out.push({
        ruleId: 'welder.not_qualified_on_weld_date',
        severity: 'critical',
        title: `Welder ${welder?.initials ?? welderId} had no valid qualification on ${w.weldDate}`,
        detail: `Weld ${w.weldNumber} was performed on ${w.weldDate}. No welder performance ` +
          `qualification for ${welder?.fullName ?? welderId} covers that date.`,
        entityType: 'weld', entityId: w.id, sectionNumber: '6',
        fingerprint: fp('welder.not_qualified_on_weld_date', w.id, welderId),
      })
    }
  }
  return cap('welder.not_qualified_on_weld_date', out)
}

/**
 * A wrench whose calibration was expired, missing, or — the case this
 * application exists to catch — not yet issued on the date of the work.
 */
export function ruleWrenchCalibrationInvalid(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const c of b.torqueConnections) {
    const check = checkWrenchCalibration(c, b.torqueWrenches)
    if (check.verdict === 'valid' || check.verdict === 'no_torque_date') continue

    const label = c.wrenchIdRaw ?? 'unrecorded'
    let title: string
    let detail: string
    switch (check.verdict) {
      case 'not_yet_issued':
        title = `Wrench ${label} calibration postdates the work it certifies`
        detail = `Connection ${c.isoFlangeNumber} was torqued on ${check.torqueDate}, but wrench ` +
          `${label}'s calibration is dated ${check.calibrationFrom} — after the work. Either the ` +
          `torque date or the calibration date is wrong; the record cannot stand as written.`
        break
      case 'expired':
        title = `Wrench ${label} calibration had expired on the torque date`
        detail = `Connection ${c.isoFlangeNumber} was torqued on ${check.torqueDate}; wrench ${label}'s ` +
          `calibration ran ${check.calibrationFrom} to ${check.calibrationTo}.`
        break
      case 'unknown_wrench': {
        const suggestion = suggestWrenchTypo(label, b.torqueWrenches.map((w) => w.wrenchId))
        title = `Wrench ${label} appears on no roster and no certificate`
        detail = `Connection ${c.isoFlangeNumber} records wrench ${label}, which matches no managed ` +
          `wrench.` + (suggestion ? ` It differs from ${suggestion} by one character — likely a ` +
          `transcription error, but confirm before correcting.` : '')
        break
      }
      case 'no_certificate':
        title = `Wrench ${label} has no calibration certificate on file`
        detail = `Connection ${c.isoFlangeNumber} was torqued with wrench ${label}; no calibration ` +
          `certificate has been uploaded for it.`
        break
      default:
        title = `Connection ${c.isoFlangeNumber} records no wrench`
        detail = 'A torque connection must identify the wrench used.'
    }
    out.push({
      ruleId: `torque.wrench_${check.verdict}`,
      severity: 'critical',
      title, detail,
      entityType: 'torque_connection', entityId: c.id, sectionNumber: '13',
      fingerprint: fp(`torque.wrench_${check.verdict}`, c.id, label),
    })
  }
  return cap('torque.wrench_calibration', out)
}

/** An NDE report written by a technician whose certification did not cover
 *  the report date. */
export function ruleNdeTechnicianNotCertified(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const r of b.ndeReports) {
    if (r.isSuperseded || !r.technicianId) continue
    if (certValidOn(b.certificates, 'ndt_technician', r.technicianId, r.reportDate)) continue
    const tech = b.ndtTechnicians.find((t) => t.id === r.technicianId)
    out.push({
      ruleId: 'nde.technician_not_certified_on_report_date',
      severity: 'critical',
      title: `NDT technician ${tech?.fullName ?? r.technicianId} was not certified on ${r.reportDate}`,
      detail: `Report ${r.reportNumber ?? r.id} is dated ${r.reportDate}. No certification for ` +
        `${tech?.fullName ?? 'this technician'} covers that date.`,
      entityType: 'nde_report', entityId: r.id, sectionNumber: '8',
      fingerprint: fp('nde.technician_not_certified_on_report_date', r.id),
    })
  }
  return cap('nde.technician_not_certified_on_report_date', out)
}

/** A weld referencing a heat number with no MTR on file. */
export function ruleHeatWithoutMtr(b: JobBookBundle): Finding[] {
  const rec = reconcileHeats(b.welds, b.materialHeats)
  return cap('material.heat_without_mtr', rec.heatsWithoutMtr.map((h) => ({
    ruleId: 'material.heat_without_mtr',
    severity: 'critical' as const,
    title: `Heat ${h.heatNumber} has no MTR on file`,
    detail: `${h.weldCount} weld(s) reference heat ${h.heatNumber}. ` +
      (h.hasRecord
        ? 'A material record exists but no material test report is attached.'
        : 'No material record exists for this heat at all.'),
    entityType: 'material_heat', entityId: undefined, sectionNumber: '15',
    fingerprint: fp('material.heat_without_mtr', h.heatNumber),
  })))
}

/** A pressure test with no recorder calibration certificate valid on the
 *  test date. */
export function rulePressureTestNoRecorderCert(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const t of b.pressureTests) {
    const cert = b.certificates.find((c) => c.id === t.recorderCertId)
    const valid = cert && t.testDate
      ? t.testDate >= cert.issueDate && (!cert.expiryDate || t.testDate <= cert.expiryDate)
      : false
    if (valid) continue
    out.push({
      ruleId: 'pressure.no_valid_recorder_cert',
      severity: 'critical',
      title: `Pressure test ${t.testIdentifier} has no valid recorder calibration certificate`,
      detail: cert
        ? `Recorder ${t.recorderSerial ?? ''} certificate runs ${cert.issueDate} to ` +
          `${cert.expiryDate ?? 'open'}, which does not cover the test date ${t.testDate}.`
        : `No recorder calibration certificate is linked to this test.`,
      entityType: 'pressure_test', entityId: t.id, sectionNumber: '17',
      fingerprint: fp('pressure.no_valid_recorder_cert', t.id),
    })
  }
  return cap('pressure.no_valid_recorder_cert', out)
}

/**
 * A document belonging to a different job or pad, filed into this book.
 * Compares the facility and pad printed on the report against the book's
 * own, and also scans the filename for a foreign job number.
 */
export function ruleWrongJobDocument(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  const bookPad = b.book.drillPadName?.trim().toUpperCase() ?? ''
  const bookJob = b.book.jobNumber.trim().toUpperCase()
  const norm = (s?: string | null) => (s ?? '').trim().toUpperCase()

  for (const r of b.ndeReports) {
    const refPad = norm(r.referencedPad)
    const refFacility = norm(r.referencedFacility)
    const mismatch =
      (refPad && bookPad && refPad !== bookPad) ||
      (refFacility && bookJob && refFacility !== bookJob && /^[A-Z]{2}\d{3}$/.test(refFacility))
    if (!mismatch) continue
    out.push({
      ruleId: 'document.wrong_job',
      severity: 'critical',
      title: `Report references ${r.referencedFacility ?? r.referencedPad}, not ${b.book.jobNumber}`,
      detail: `NDE report dated ${r.reportDate} is filed in job book ${b.book.jobNumber} ` +
        `(pad ${b.book.drillPadName ?? 'n/a'}) but names ` +
        `${r.referencedFacility ?? ''} ${r.referencedPad ?? ''}`.trim() +
        `. A document from another job must not be delivered inside this turnover package.`,
      entityType: 'nde_report', entityId: r.id, sectionNumber: '10',
      fingerprint: fp('document.wrong_job', r.id),
    })
  }

  // Filenames carrying a job number that is not this book's.
  const jobPattern = /\b([A-Z]{2}\d{3})\b/g
  for (const d of b.documents) {
    if (d.deletedAt) continue
    const names = `${d.originalFilename} ${d.normalizedFilename}`.toUpperCase()
    const found = new Set<string>()
    let m: RegExpExecArray | null
    jobPattern.lastIndex = 0
    while ((m = jobPattern.exec(names))) if (m[1] !== bookJob) found.add(m[1]!)
    if (!found.size) continue
    out.push({
      ruleId: 'document.wrong_job_filename',
      severity: 'critical',
      title: `${d.originalFilename} names job ${[...found].join(', ')}, not ${b.book.jobNumber}`,
      detail: `This file is filed in ${b.book.jobNumber} but its name references ` +
        `${[...found].join(', ')}. Verify it belongs here before turnover.`,
      entityType: 'document', entityId: d.id,
      fingerprint: fp('document.wrong_job_filename', d.id),
    })
  }
  return cap('document.wrong_job', out)
}

/** A welder below the job's required minimum X-ray percentage. */
export function ruleWelderBelowXrayMinimum(b: JobBookBundle): Finding[] {
  const rollups = rollupByWelder(b.welds, b.welders, b.book)
  return rollups
    .filter((r) => r.totalWelds > 0 && !r.meetsRequirement)
    .map((r) => ({
      ruleId: 'welder.below_xray_minimum',
      severity: 'critical' as const,
      title: `${r.initials} is at ${r.xrayPct.toFixed(1)}% X-ray, below the ${b.book.requiredXrayPct}% minimum`,
      detail: `${r.fullName} welded ${r.totalWelds} joints on this job with ${r.totalXrays} ` +
        `radiographic examinations (${r.xrayPct.toFixed(1)}%). The job requires ` +
        `${b.book.requiredXrayPct}%.`,
      entityType: 'welder', entityId: r.welderId, sectionNumber: '11',
      fingerprint: fp('welder.below_xray_minimum', r.welderId),
    }))
}

/**
 * Any record dated in the future.
 *
 * "Future" is measured against the log's own as-of date where the book has
 * one, and against today otherwise — a December weld recorded as next
 * December is wrong the moment it is typed, not merely once the calendar
 * catches up. This is the most common transcription error in these logs.
 */
export function ruleFutureDatedRecords(b: JobBookBundle, ctx: FlagContext = {}): Finding[] {
  const now = ctx.asOf ?? today()
  const horizon = b.book.dataAsOfDate && b.book.dataAsOfDate < now ? b.book.dataAsOfDate : now
  const out: Finding[] = []
  const push = (
    entityType: string, id: string, label: string, field: string, date: IsoDate, section?: string,
  ) => {
    out.push({
      ruleId: 'record.future_dated',
      severity: 'critical',
      title: `${label} is dated ${date}, after the log as-of date ${horizon}`,
      detail: `The ${field} on ${label} is ${date}. The field logs for this book were closed as of ` +
        `${horizon}, so this record is dated in the future relative to the log that reports it.`,
      entityType, entityId: id, sectionNumber: section,
      fingerprint: fp('record.future_dated', entityType, id, field),
    })
  }

  for (const w of b.welds) {
    if (w.weldDate && w.weldDate > horizon) push('weld', w.id, `Weld ${w.weldNumber}`, 'weld date', w.weldDate, '12')
  }
  for (const c of b.torqueConnections) {
    if (c.torqueDate && c.torqueDate > horizon) {
      push('torque_connection', c.id, `Connection ${c.isoFlangeNumber}`, 'torque date', c.torqueDate, '14')
    }
  }
  for (const r of b.ndeReports) {
    if (r.reportDate > horizon) {
      push('nde_report', r.id, `NDE report ${r.reportNumber ?? r.id.slice(0, 8)}`, 'report date', r.reportDate, '10')
    }
  }
  for (const w of b.torqueWrenches) {
    if (w.lastCalibrationDate && w.lastCalibrationDate > horizon) {
      push('torque_wrench', w.id, `Wrench ${w.wrenchId}`, 'calibration date', w.lastCalibrationDate, '13')
    }
  }
  return cap('record.future_dated', out)
}

// ---------------------------------------------------------------------
// Warning rules
// ---------------------------------------------------------------------

export function ruleInspectionPctBelowMinimum(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  const t = torqueTotals(b.torqueConnections, b.book)
  if (t.totalConnections > 0 && !t.meetsRequirement) {
    out.push({
      ruleId: 'torque.inspection_below_minimum',
      severity: 'warning',
      title: `Torque inspection is at ${t.inspectionPct.toFixed(2)}%, below the ${b.book.requiredTorqueInspectPct}% minimum`,
      detail: `${t.inspectedConnections} of ${t.totalConnections} connections have been inspected ` +
        `(${t.inspectionPct.toFixed(2)}%).`,
      sectionNumber: '14',
      fingerprint: fp('torque.inspection_below_minimum'),
    })
  }
  return out
}

export function ruleTorqueOutOfTolerance(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const c of b.torqueConnections) {
    const ok = torqueWithinTolerance(c, b.book.torqueTolerancePct)
    if (ok !== false) continue
    out.push({
      ruleId: 'torque.out_of_tolerance',
      severity: 'warning',
      title: `Connection ${c.isoFlangeNumber} torqued to ${c.actualTorqueFtLb} against ${c.requiredTorqueFtLb} ft-lb`,
      detail: `Actual torque deviates from required by more than the job's ` +
        `${b.book.torqueTolerancePct}% tolerance.`,
      entityType: 'torque_connection', entityId: c.id, sectionNumber: '14',
      fingerprint: fp('torque.out_of_tolerance', c.id),
    })
  }
  return cap('torque.out_of_tolerance', out)
}

/**
 * Hand-recorded field data that matches its target exactly, every time, is
 * itself worth surfacing. This is not a defect in any single row — it is a
 * pattern that suggests the log was filled from the spec rather than from
 * the wrench, and an auditor will ask about it.
 */
export function ruleTorqueImplausiblyExact(b: JobBookBundle): Finding[] {
  const measured = b.torqueConnections.filter(
    (c) => c.requiredTorqueFtLb != null && c.actualTorqueFtLb != null,
  )
  if (measured.length < 25) return []
  const exact = measured.filter((c) => c.actualTorqueFtLb === c.requiredTorqueFtLb)
  if (exact.length !== measured.length) return []
  return [{
    ruleId: 'torque.implausibly_exact',
    severity: 'warning',
    title: `All ${measured.length} connections record actual torque exactly equal to required`,
    detail: `Every one of ${measured.length} hand-recorded connections matches its required torque ` +
      `to the foot-pound. Real wrench readings scatter. Confirm the log was recorded from the ` +
      `wrench and not transcribed from the specification.`,
    sectionNumber: '14',
    fingerprint: fp('torque.implausibly_exact'),
  }]
}

/** Identical file content uploaded more than once. */
export function ruleDuplicateDocuments(b: JobBookBundle): Finding[] {
  const byHash = new Map<string, typeof b.documents>()
  for (const d of b.documents) {
    if (d.deletedAt) continue
    const list = byHash.get(d.sha256) ?? []
    list.push(d)
    byHash.set(d.sha256, list)
  }
  const out: Finding[] = []
  for (const [hash, docs] of byHash) {
    if (docs.length < 2) continue
    out.push({
      ruleId: 'document.duplicate',
      severity: 'warning',
      title: `${docs.length} copies of identical content: ${docs[0]!.originalFilename}`,
      detail: `These files share SHA-256 ${hash.slice(0, 12)}…: ` +
        docs.map((d) => d.originalFilename).join(', ') +
        `. Keep one and supersede the rest so the turnover package does not ship the same ` +
        `document several times.`,
      entityType: 'document', entityId: docs[0]!.id,
      fingerprint: fp('document.duplicate', hash),
    })
  }
  return cap('document.duplicate', out)
}

/** A superseded document with nothing marked as its successor — the
 *  "- Corrected" case, where the reader cannot tell which version governs. */
export function ruleSupersededWithoutSuccessor(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  const successorOf = new Set(
    b.documents.map((d) => d.supersedesDocumentId).filter((x): x is string => !!x),
  )
  for (const d of b.documents) {
    if (d.deletedAt || !d.isSuperseded || successorOf.has(d.id)) continue
    out.push({
      ruleId: 'document.superseded_without_successor',
      severity: 'warning',
      title: `${d.originalFilename} is marked superseded but nothing supersedes it`,
      detail: `A reader of this book cannot tell which version governs. Link the replacing document ` +
        `or clear the superseded mark.`,
      entityType: 'document', entityId: d.id,
      fingerprint: fp('document.superseded_without_successor', d.id),
    })
  }

  // The same problem on reports: two revisions of one examination, both live.
  const byDateMethod = new Map<string, typeof b.ndeReports>()
  for (const r of b.ndeReports) {
    if (r.isSuperseded) continue
    const key = `${r.reportDate}|${r.method}|${r.ndtCompany ?? ''}`
    const list = byDateMethod.get(key) ?? []
    list.push(r)
    byDateMethod.set(key, list)
  }
  for (const [key, reports] of byDateMethod) {
    if (reports.length < 2) continue
    out.push({
      ruleId: 'nde.same_day_reports_unresolved',
      severity: 'warning',
      title: `${reports.length} live ${reports[0]!.method} reports share ${reports[0]!.reportDate}`,
      detail: `Several reports for the same date, method and vendor are all marked current. If one ` +
        `corrects another, mark the superseded one so the governing version is unambiguous.`,
      entityType: 'nde_report', entityId: reports[0]!.id, sectionNumber: '10',
      fingerprint: fp('nde.same_day_reports_unresolved', key),
    })
  }
  return cap('document.superseded_without_successor', out)
}

export function ruleCertificateExpiringSoon(b: JobBookBundle, ctx: FlagContext = {}): Finding[] {
  const asOf = ctx.asOf ?? today()
  const out: Finding[] = []
  for (const c of b.certificates) {
    const e = evaluateCert(c, b.book.certExpiryWarningDays, asOf)
    if (e.status !== 'expiring_soon') continue
    out.push({
      ruleId: 'certificate.expiring_soon',
      severity: 'warning',
      title: `${c.certType} expires in ${e.daysUntilExpiry} days (${c.expiryDate})`,
      detail: `Certificate ${c.certType} for ${c.subjectType} ${c.subjectId} expires ${c.expiryDate}. ` +
        `Work performed after that date will not be covered.`,
      entityType: 'certificate', entityId: c.id,
      fingerprint: fp('certificate.expiring_soon', c.id),
    })
  }
  return cap('certificate.expiring_soon', out)
}

/** `CP TEST ON FLANGE = Y` with no matching cathodic protection test point:
 *  the tie between section 14 and section 18. */
export function ruleCpFlangeWithoutTestPoint(b: JobBookBundle): Finding[] {
  const rec = reconcileCp(b.torqueConnections, b.cpTestPoints)
  return cap('cp.flange_without_test_point', rec.flangesAwaitingCpPoint.map((c) => ({
    ruleId: 'cp.flange_without_test_point',
    severity: 'warning' as const,
    title: `Flange ${c.isoFlangeNumber} is marked CP TEST = Y with no test point on file`,
    detail: `The torque log marks this flange for cathodic protection testing, but section 18 ` +
      `carries no test point for it.`,
    entityType: 'torque_connection', entityId: c.id, sectionNumber: '18',
    fingerprint: fp('cp.flange_without_test_point', c.id),
  })))
}

/** A weld recording an NDE method with no report behind it. */
export function ruleWeldNdeWithoutReport(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const w of b.welds) {
    if (!isCountable(w) || !w.ndtMethod || w.ndtReportId) continue
    out.push({
      ruleId: 'weld.nde_without_report',
      severity: 'warning',
      title: `Weld ${w.weldNumber} records a ${w.ndtMethod} examination with no report on file`,
      detail: `The weld log claims ${w.ndtMethod} ` +
        (w.xrayNumber ? `(X-ray ${w.xrayNumber}) ` : '') +
        `but no NDE report is linked. Either the examination did not happen or the report is missing.`,
      entityType: 'weld', entityId: w.id, sectionNumber: '10',
      fingerprint: fp('weld.nde_without_report', w.id),
    })
  }
  return cap('weld.nde_without_report', out)
}

/** A report dated outside the job's construction window. */
export function ruleReportOutsideConstructionWindow(b: JobBookBundle): Finding[] {
  const { constructionStart, constructionEnd } = b.book
  if (!constructionStart && !constructionEnd) return []
  const out: Finding[] = []
  for (const r of b.ndeReports) {
    const before = constructionStart && r.reportDate < constructionStart
    const after = constructionEnd && r.reportDate > constructionEnd
    if (!before && !after) continue
    out.push({
      ruleId: 'nde.outside_construction_window',
      severity: 'warning',
      title: `NDE report dated ${r.reportDate} falls outside the construction window`,
      detail: `This book's construction ran ${constructionStart ?? 'unbounded'} to ` +
        `${constructionEnd ?? 'unbounded'}. A report dated ${r.reportDate} either belongs to ` +
        `another job or carries a transcription error.`,
      entityType: 'nde_report', entityId: r.id, sectionNumber: '10',
      fingerprint: fp('nde.outside_construction_window', r.id),
    })
  }
  return cap('nde.outside_construction_window', out)
}

/** Wrenches recorded on connections but absent from the log's roster. */
export function ruleWrenchNotOnRoster(b: JobBookBundle): Finding[] {
  const rec = reconcileWrenches(b.torqueConnections, b.torqueWrenches)
  return rec.usedNotOnRoster.map((id) => ({
    ruleId: 'torque.wrench_not_on_roster',
    severity: 'warning' as const,
    title: `Wrench ${id} is used on ${rec.usageCounts[id] ?? 0} connections but absent from the roster`,
    detail: `The torque log's roster header does not list wrench ${id}, yet it appears on ` +
      `${rec.usageCounts[id] ?? 0} connection row(s).` +
      (suggestWrenchTypo(id, rec.onRoster)
        ? ` It differs from rostered wrench ${suggestWrenchTypo(id, rec.onRoster)} by one character.`
        : ''),
    entityType: 'torque_wrench', sectionNumber: '13',
    fingerprint: fp('torque.wrench_not_on_roster', id),
  }))
}

// ---------------------------------------------------------------------
// Info rules
// ---------------------------------------------------------------------

export function ruleMtrNotReferenced(b: JobBookBundle): Finding[] {
  const rec = reconcileHeats(b.welds, b.materialHeats)
  return cap('material.mtr_not_referenced', rec.mtrsWithoutWelds.map((h) => ({
    ruleId: 'material.mtr_not_referenced',
    severity: 'info' as const,
    title: `MTR for heat ${h.heatNumber} is not referenced by any weld`,
    detail: `A material test report is on file for heat ${h.heatNumber}, but no weld in this book ` +
      `references it. Either a weld's heat numbers are missing or this MTR belongs elsewhere.`,
    entityType: 'material_heat', entityId: h.id, sectionNumber: '15',
    fingerprint: fp('material.mtr_not_referenced', h.heatNumber),
  })))
}

export function ruleReadyForReviewWithOpenWarnings(
  b: JobBookBundle, existing: Finding[],
): Finding[] {
  const out: Finding[] = []
  const bySection = new Map<string, number>()
  for (const f of existing) {
    if (!f.sectionNumber || f.severity === 'info') continue
    bySection.set(f.sectionNumber, (bySection.get(f.sectionNumber) ?? 0) + 1)
  }
  const defsById = new Map(b.sectionDefinitions.map((d) => [d.id, d]))
  for (const s of b.sections) {
    if (s.status !== 'ready_for_review') continue
    const def = defsById.get(s.sectionDefinitionId)
    const count = def ? bySection.get(def.sectionNumber) ?? 0 : 0
    if (!count) continue
    out.push({
      ruleId: 'section.ready_with_open_flags',
      severity: 'info',
      title: `Section ${def?.sectionNumber} was marked ready for review with ${count} open flag(s)`,
      detail: `Resolve or acknowledge the open flags before a manager approves this section.`,
      entityType: 'job_book_section', entityId: s.id, sectionNumber: def?.sectionNumber,
      fingerprint: fp('section.ready_with_open_flags', s.id),
    })
  }
  return out
}

export function ruleNonConformingFilename(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const d of b.documents) {
    if (d.deletedAt || d.originalFilename === d.normalizedFilename) continue
    out.push({
      ruleId: 'document.filename_normalized',
      severity: 'info',
      title: `${d.originalFilename} was renamed to ${d.normalizedFilename}`,
      detail: `The uploaded name did not follow the book's filing convention and was normalized. ` +
        `The original name is preserved on the record.`,
      entityType: 'document', entityId: d.id,
      fingerprint: fp('document.filename_normalized', d.id),
    })
  }
  return cap('document.filename_normalized', out)
}

/** Archives hide their contents from indexing and auditing. */
export function ruleArchiveUploaded(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const d of b.documents) {
    if (d.deletedAt) continue
    if (!/\.(zip|7z|rar|tar|gz)$/i.test(d.originalFilename)) continue
    out.push({
      ruleId: 'document.archive_uploaded',
      severity: 'info',
      title: `${d.originalFilename} is an archive and its contents are not indexed`,
      detail: `An auditor cannot see inside a ZIP, and neither can this application's ` +
        `reconciliation reports. Expand it server-side so each document is filed and hashed ` +
        `individually (${((d.byteSize ?? 0) / 1_048_576).toFixed(1)} MB).`,
      entityType: 'document', entityId: d.id,
      fingerprint: fp('document.archive_uploaded', d.id),
    })
  }
  return cap('document.archive_uploaded', out)
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------

const SEVERITY_ORDER: Record<FlagSeverity, number> = { critical: 0, warning: 1, info: 2 }

/** Evaluate the full rule set. Ordered critical-first so the queue reads
 *  top-down in the order a manager should work it. */
export function evaluateFlags(b: JobBookBundle, ctx: FlagContext = {}): Finding[] {
  const findings: Finding[] = [
    ...ruleWelderNotQualified(b),
    ...ruleWrenchCalibrationInvalid(b),
    ...ruleNdeTechnicianNotCertified(b),
    ...ruleHeatWithoutMtr(b),
    ...rulePressureTestNoRecorderCert(b),
    ...ruleWrongJobDocument(b),
    ...ruleWelderBelowXrayMinimum(b),
    ...ruleFutureDatedRecords(b, ctx),
    ...ruleInspectionPctBelowMinimum(b),
    ...ruleTorqueOutOfTolerance(b),
    ...ruleTorqueImplausiblyExact(b),
    ...ruleDuplicateDocuments(b),
    ...ruleSupersededWithoutSuccessor(b),
    ...ruleCertificateExpiringSoon(b, ctx),
    ...ruleCpFlangeWithoutTestPoint(b),
    ...ruleWeldNdeWithoutReport(b),
    ...ruleReportOutsideConstructionWindow(b),
    ...ruleWrenchNotOnRoster(b),
    ...ruleMtrNotReferenced(b),
    ...ruleNonConformingFilename(b),
    ...ruleArchiveUploaded(b),
  ]
  findings.push(...ruleReadyForReviewWithOpenWarnings(b, findings))

  // Deduplicate on fingerprint: two rules can legitimately reach the same
  // conclusion about the same record, and the queue should show it once.
  const seen = new Set<string>()
  return findings
    .filter((f) => (seen.has(f.fingerprint) ? false : (seen.add(f.fingerprint), true)))
    .sort((a, b2) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b2.severity])
}

export interface FlagCounts { critical: number; warning: number; info: number; total: number }

export function countBySeverity(findings: Finding[]): FlagCounts {
  const c: FlagCounts = { critical: 0, warning: 0, info: 0, total: findings.length }
  for (const f of findings) c[f.severity]++
  return c
}

/** Merge freshly-evaluated findings with the flags already stored, so a
 *  resolution survives re-evaluation and a recurrence is not duplicated. */
export function mergeFindings(
  findings: Finding[], stored: ComplianceFlag[],
): { unchanged: ComplianceFlag[]; newFlags: Finding[]; disappeared: ComplianceFlag[] } {
  const byFingerprint = new Map(stored.map((f) => [f.fingerprint, f]))
  const live = new Set(findings.map((f) => f.fingerprint))
  return {
    unchanged: findings.map((f) => byFingerprint.get(f.fingerprint)).filter((f): f is ComplianceFlag => !!f),
    newFlags: findings.filter((f) => !byFingerprint.has(f.fingerprint)),
    disappeared: stored.filter((f) => !live.has(f.fingerprint) && f.state === 'open'),
  }
}

export { isInspected, isXrayed, type Weld }
