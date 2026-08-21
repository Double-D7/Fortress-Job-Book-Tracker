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
import {
  checkFlatRule, creditedWelders, isCountable, isXrayed, qualifiedOn, rollupByWelder,
} from './welders'
import { computeSmys, tierRequiresNde, type TierRule } from './engineering'
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
  /** Per-job inspection tier rules; defaults to the built-in table. */
  tierRules?: TierRule[]
}

const fp = (...parts: (string | number | null | undefined)[]) =>
  parts.filter((p) => p != null && p !== '').join('|')

/**
 * Is this section's content still unread?
 *
 * Every rule that reasons about what a section contains has to ask this
 * first. A rule firing against unread data does not report a problem with
 * the job — it reports a problem with the import, in language that accuses
 * the job. "22 pressure tests have no recorder calibration" is a serious
 * allegation, and on DP-318 it was false: every test pack holds the
 * recorder certificate, and nothing had opened them.
 */
function sectionIsUnread(b: JobBookBundle, sectionNumber: string): boolean {
  const def = b.sectionDefinitions.find((d) => d.sectionNumber === sectionNumber)
  if (!def) return false
  const section = b.sections.find((x) => x.sectionDefinitionId === def.id)
  return section?.ingestionStatus === 'not_imported'
}

/**
 * Findings used to be capped per rule, with the overflow thrown away. That
 * was the wrong answer to volume: a book with 278 future-dated connections
 * does not have 278 problems, it has one problem 278 times, and a queue
 * that lists them individually is a queue nobody reads. Rules now return
 * every occurrence and `aggregateFindings` collapses them into one entry
 * per rule with the count on the face and the records on drill-down.
 */
const cap = <T>(_ruleId: string, findings: T[]): T[] => findings

/** How many individual records travel with an aggregated finding. Bounds
 *  the payload without discarding the count. */
const MAX_RECORDS_PER_GROUP = 200

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
      case 'no_calibration_date':
        title = `Wrench ${label}'s certificate carries no recorded calibration date`
        detail = `Connection ${c.isoFlangeNumber} was torqued with wrench ${label}. Its certificate ` +
          `is on file, but no calibration date has been entered, so validity on the day of the ` +
          `work cannot be checked.`
        break
      default:
        title = `Connection ${c.isoFlangeNumber} records no wrench`
        detail = 'A torque connection must identify the wrench used.'
    }
    out.push({
      ruleId: `torque.wrench_${check.verdict}`,
      severity: check.verdict === 'no_calibration_date' ? 'warning' : 'critical',
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
  if (sectionIsUnread(b, '15')) return []
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
  // The recorder certificates live inside the section 17 test packs. Until
  // those are read, "no valid certificate" means "not looked at yet".
  if (sectionIsUnread(b, '17')) return []
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
  // A book carrying an explicit inspection rule is checked by that rule
  // instead, so the two never both fire on the same welder.
  if (b.book.inspectionRule) return []
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

/**
 * A weld whose inspection tier requires NDE that it never received.
 *
 * This is the facility equivalent of the flowline X-ray percentage rule,
 * and it is stricter: the obligation is per weld and derived from the pipe,
 * so it cannot be satisfied by averaging across a job.
 */
export function ruleTierNotMet(b: JobBookBundle, rules?: TierRule[]): Finding[] {
  // Only a book actually governed by the tiered rule can fail it. DP-318
  // states a flat "100% visual & 10% NDE" requirement on its own face;
  // reading a tier obligation into it produced 90 findings against welds
  // that owed nothing, which is worse than missing a real one — it sends a
  // crew to X-ray pipe that was never required to be X-rayed.
  if (b.book.inspectionRule && b.book.inspectionRule.kind !== 'tiered') return []
  if (!rules?.length) return []

  const out: Finding[] = []
  for (const w of b.welds) {
    if (!isCountable(w)) continue
    const smys = computeSmys({
      pipeSizeSchedule: w.pipeSizeSchedule,
      pipeGrade: w.pipeGrade,
      designPressurePsi: w.designPressurePsi ?? b.book.defaultDesignPressurePsi ?? null,
    }, rules)
    if (!tierRequiresNde(smys)) continue
    if (w.ndtMethod) continue
    out.push({
      ruleId: 'weld.tier_not_met',
      severity: 'critical',
      title: `Weld ${w.weldNumber} is at ${((smys.pctSmys ?? 0) * 100).toFixed(1)}% SMYS and has no NDE`,
      detail: `${w.pipeSizeSchedule ?? 'pipe'} ${w.pipeGrade ?? ''} at ` +
        `${w.designPressurePsi ?? b.book.defaultDesignPressurePsi} psi gives a hoop stress of ` +
        `${Math.round(smys.hoopStressPsi ?? 0).toLocaleString()} psi, ` +
        `${((smys.pctSmys ?? 0) * 100).toFixed(2)}% of SMYS. Its tier requires ` +
        `"${smys.tier}", and no examination is recorded.`,
      entityType: 'weld', entityId: w.id, sectionNumber: '12',
      fingerprint: fp('weld.tier_not_met', w.id),
    })
  }
  return out
}

/**
 * A welder below the job's flat NDE requirement.
 *
 * The facility equivalent of the flowline X-ray percentage rule, reading
 * the threshold from the job rather than assuming one. Every DP-318 welder
 * clears its 10%; the lowest is the MR LC crew stamp at 11.1%.
 */
export function ruleFlatRuleNotMet(b: JobBookBundle): Finding[] {
  const rule = b.book.inspectionRule
  if (!rule || rule.kind !== 'flat') return []
  const { perWelder } = checkFlatRule(b.welds, b.welders, rule)
  return perWelder
    .filter((p) => p.welds > 0 && !p.meetsNde)
    .map((p) => ({
      ruleId: 'welder.below_job_nde_requirement',
      severity: 'critical' as const,
      title: `${p.initials} is at ${p.ndePct.toFixed(1)}% NDE, below the job's ${rule.requiredNdePct}%`,
      detail: `${p.welds} welds with ${p.nde} examinations (${p.ndePct.toFixed(1)}%). This job's ` +
        `stated requirement is ${rule.requiredVisualPct}% visual and ${rule.requiredNdePct}% NDE` +
        (rule.statedAs ? ` — "${rule.statedAs}".` : '.'),
      entityType: 'welder', entityId: p.welderId, sectionNumber: '12',
      fingerprint: fp('welder.below_job_nde_requirement', p.welderId),
    }))
}

/** A weld lacking the pipe data its inspection obligation depends on. */
export function ruleSmysUncomputable(b: JobBookBundle, rules?: TierRule[]): Finding[] {
  const out: Finding[] = []
  for (const w of b.welds) {
    if (!isCountable(w)) continue
    // Only meaningful on books that carry pipe engineering at all.
    if (!w.pipeSizeSchedule && !w.pipeGrade && w.designPressurePsi == null) continue
    const smys = computeSmys({
      pipeSizeSchedule: w.pipeSizeSchedule,
      pipeGrade: w.pipeGrade,
      designPressurePsi: w.designPressurePsi ?? b.book.defaultDesignPressurePsi ?? null,
    }, rules)
    if (!smys.uncomputableReason) continue
    out.push({
      ruleId: 'weld.smys_uncomputable',
      severity: 'critical',
      title: `Weld ${w.weldNumber}: % of SMYS cannot be computed`,
      detail: `${smys.uncomputableReason}. Without it the weld's required inspection tier is ` +
        `unknown, so the book cannot show whether it was inspected enough.`,
      entityType: 'weld', entityId: w.id, sectionNumber: '12',
      fingerprint: fp('weld.smys_uncomputable', w.id),
    })
  }
  return out
}

/**
 * Welds recorded against a combined crew stamp.
 *
 * Not a defect in the work — two men on one weld is normal — but it means
 * those welds cannot be attributed to an individual, so they sit outside
 * every per-welder percentage the operator audits.
 */
export function ruleCombinedStampAttribution(b: JobBookBundle): Finding[] {
  const combined = b.welders.filter((w) => w.combinedOf?.length)
  const out: Finding[] = []
  for (const w of combined) {
    const n = b.welds.filter((x) => isCountable(x) && x.welderId === w.id).length
    if (n === 0) continue
    out.push({
      ruleId: 'welder.combined_stamp',
      severity: 'info',
      title: `${n} weld${n === 1 ? '' : 's'} are stamped to the combined crew ${w.initials}`,
      detail: `${w.fullName} is a crew stamp covering ${w.combinedOf!.length} welders. Welds under ` +
        `it cannot be attributed to an individual, so they fall outside each man's inspection ` +
        `percentage even though both are qualified.`,
      entityType: 'welder', entityId: w.id, sectionNumber: '12',
      fingerprint: fp('welder.combined_stamp', w.id),
    })
  }
  return out
}

/** A weld with no welder stamp cannot be attributed or checked. */
export function ruleWeldWithoutStamp(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const w of b.welds) {
    if (!isCountable(w)) continue
    if (creditedWelders(w).length > 0 || w.welderStamp) continue
    out.push({
      ruleId: 'weld.no_welder_stamp',
      severity: 'critical',
      title: `Weld ${w.weldNumber} has no welder stamp`,
      detail: `No welder is recorded against this weld, so it cannot be attributed, checked ` +
        `against a qualification, or counted in any welder's inspection percentage.`,
      entityType: 'weld', entityId: w.id, sectionNumber: '12',
      fingerprint: fp('weld.no_welder_stamp', w.id),
    })
  }
  return out
}

/**
 * A required section with nothing in it.
 *
 * Previously this only surfaced as a zero score on the overview. An empty
 * required section is a finding in its own right — it is the single most
 * common reason a turnover package is rejected.
 */
export function ruleEmptyRequiredSection(b: JobBookBundle): Finding[] {
  const defsById = new Map(b.sectionDefinitions.map((d) => [d.id, d]))
  const out: Finding[] = []
  for (const s of b.sections) {
    if (s.status === 'na') continue
    // Empty means we looked. An unread section is reported by the section
    // list as unread, and accusing it of being empty here would put ten
    // false criticals on a book that merely has not finished importing.
    if (s.ingestionStatus === 'not_imported') continue
    const def = defsById.get(s.sectionDefinitionId)
    if (!def || def.weight <= 0 || !def.isRequired) continue
    const docs = b.documents.filter((d) => d.sectionId === s.id && !d.deletedAt)
    if (docs.length > 0) continue
    // Record-backed sections are empty only if they also carry no records.
    const recordCounts: Record<string, number> = {
      weld: b.welds.length,
      torque_connection: b.torqueConnections.length,
      material_heat: b.materialHeats.length,
      nde_report: b.ndeReports.length,
      pressure_test: b.pressureTests.length,
      cp_test_point: b.cpTestPoints.length,
      ut_reading: b.utReadings.length,
      coating_inspection: (b.coatingInspections ?? []).length,
    }
    if (def.linkedRecordType && (recordCounts[def.linkedRecordType] ?? 0) > 0) continue
    out.push({
      ruleId: 'section.empty_required',
      severity: 'critical',
      title: `Section ${def.sectionNumber} · ${def.title} is empty`,
      detail: `This section is required by the governing checklist and holds no documents or ` +
        `records. It carries ${def.weight} weight point${def.weight === 1 ? '' : 's'}, and the ` +
        `book cannot be turned over without it.`,
      entityType: 'job_book_section', entityId: s.id, sectionNumber: def.sectionNumber,
      fingerprint: fp('section.empty_required', def.sectionNumber),
    })
  }
  return out
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
      title: `Connection ${c.isoFlangeNumber} torqued to ${c.actualTorqueFtLb} ft-lb, ` +
        `outside ${c.requiredTorqueMinFtLb != null && c.requiredTorqueMaxFtLb != null &&
          c.requiredTorqueMaxFtLb > c.requiredTorqueMinFtLb
            ? `${c.requiredTorqueMinFtLb}-${c.requiredTorqueMaxFtLb}`
            : String(c.requiredTorqueFtLb)}`,
      detail: c.requiredTorqueMaxFtLb != null && c.requiredTorqueMinFtLb != null &&
        c.requiredTorqueMaxFtLb > c.requiredTorqueMinFtLb
          ? `The required torque is a range and the recorded actual falls outside it.`
          : `Actual torque deviates from required by more than the job's ` +
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
  if (sectionIsUnread(b, '18')) return []
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
  if (sectionIsUnread(b, '10') || sectionIsUnread(b, '12')) return []
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
    // A wrench in service that the log's own roster does not list is a
    // control failure, not an untidiness: nothing establishes what it is,
    // who owns it, or when it was last calibrated.
    severity: 'critical' as const,
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
  if (sectionIsUnread(b, '15')) return []
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

/**
 * A document filed under a section its own content contradicts.
 *
 * Two shapes, both real in DP-318: an As-Built section holding a drawing
 * stamped IFR, and a PQR section holding a byte-identical copy of the WPS.
 * Neither is a missing file, which is why neither shows up as one — the
 * section looks populated and is not.
 */
export function ruleWrongDocumentForSection(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  const defsById = new Map(b.sectionDefinitions.map((d) => [d.id, d]))
  const sectionOf = new Map(b.sections.map((s) => [s.id, defsById.get(s.sectionDefinitionId)]))

  // An As-Built section holding a drawing stamped for review.
  for (const d of b.documents) {
    if (d.deletedAt || !d.sectionId) continue
    const def = sectionOf.get(d.sectionId)
    if (!def || !/as-built/i.test(def.title)) continue
    if (!/\bIFR\b|issued\s*for\s*review/i.test(d.originalFilename)) continue
    out.push({
      ruleId: 'document.ifr_in_as_built',
      severity: 'warning',
      title: `${d.originalFilename} is stamped IFR in an As-Built section`,
      detail: `Section ${def.sectionNumber} must hold as-built drawings. An Issued For Review ` +
        `drawing records what was planned, not what was installed, so this section is populated ` +
        `but not satisfied.`,
      entityType: 'document', entityId: d.id, sectionNumber: def.sectionNumber,
      fingerprint: fp('document.ifr_in_as_built', d.id),
    })
  }

  // Two sections whose only file is the same file.
  const byHash = new Map<string, { doc: (typeof b.documents)[number]; section: string }[]>()
  for (const d of b.documents) {
    if (d.deletedAt || !d.sectionId) continue
    const def = sectionOf.get(d.sectionId)
    if (!def) continue
    const list = byHash.get(d.sha256) ?? []
    list.push({ doc: d, section: def.sectionNumber })
    byHash.set(d.sha256, list)
  }
  for (const [hash, copies] of byHash) {
    const sections = [...new Set(copies.map((c) => c.section))]
    if (sections.length < 2) continue
    out.push({
      ruleId: 'document.same_file_in_two_sections',
      severity: 'warning',
      title: `Sections ${sections.join(' and ')} hold the same file`,
      detail: `${copies[0]!.doc.originalFilename} is byte-identical across sections ` +
        `${sections.join(', ')} (SHA-256 ${hash.slice(0, 12)}…). One of those sections is ` +
        `evidenced by a document that belongs to the other.`,
      entityType: 'document', entityId: copies[0]!.doc.id, sectionNumber: sections[0],
      fingerprint: fp('document.same_file_in_two_sections', hash),
    })
  }
  return out
}

/**
 * A certificate that expires inside the job's own working window.
 *
 * Different from the generic expiry warning, which asks whether a cert is
 * lapsing soon relative to today. This asks whether it lapses before the
 * work is finished — which is knowable the day the job starts.
 */
export function ruleCertExpiresDuringJob(b: JobBookBundle): Finding[] {
  const end = b.book.constructionEnd
  if (!end) return []
  const out: Finding[] = []
  for (const c of b.certificates) {
    if (!c.expiryDate || c.expiryDate >= end) continue
    if (b.book.constructionStart && c.expiryDate < b.book.constructionStart) continue
    const welder = b.welders.find((w) => w.id === c.subjectId)
    const subject = welder?.fullName ?? c.subjectId
    // Whether it actually bit is a separate question from whether it will.
    const workAfter = b.welds.filter(
      (w) => w.weldDate && w.weldDate > c.expiryDate! && creditedWelders(w).includes(c.subjectId),
    ).length
    out.push({
      ruleId: 'certificate.expires_during_job',
      severity: workAfter > 0 ? 'critical' : 'warning',
      title: `${subject}'s ${c.certType} expires ${c.expiryDate}, before the job ends ${end}`,
      detail: workAfter > 0
        ? `${workAfter} weld(s) are recorded after that date and are not covered.`
        : `No work is recorded after that date yet, so nothing is uncovered — but any further ` +
          `work on this job would be.`,
      entityType: 'certificate', entityId: c.id, sectionNumber: '6',
      fingerprint: fp('certificate.expires_during_job', c.id),
    })
  }
  return out
}

/** A section whose only file is an editor lock file rather than a document. */
export function ruleOrphanedLockFile(b: JobBookBundle): Finding[] {
  const defsById = new Map(b.sectionDefinitions.map((d) => [d.id, d]))
  const out: Finding[] = []
  for (const s of b.sections) {
    const def = defsById.get(s.sectionDefinitionId)
    if (!def || def.weight <= 0) continue
    const docs = b.documents.filter((d) => d.sectionId === s.id && !d.deletedAt)
    if (!docs.length) continue
    if (!docs.every((d) => /^~\$/.test(d.originalFilename))) continue
    out.push({
      ruleId: 'document.only_lock_file',
      severity: 'warning',
      title: `Section ${def.sectionNumber} holds only an editor lock file`,
      detail: `${docs[0]!.originalFilename} is a Word lock file left behind by an open document, ` +
        `not a deliverable. The section reads as populated in a folder listing and is empty.`,
      entityType: 'job_book_section', entityId: s.id, sectionNumber: def.sectionNumber,
      fingerprint: fp('document.only_lock_file', s.id),
    })
  }
  return out
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
    ...ruleTierNotMet(b, ctx.tierRules),
    ...ruleFlatRuleNotMet(b),
    ...ruleSmysUncomputable(b, ctx.tierRules),
    ...ruleWeldWithoutStamp(b),
    ...ruleEmptyRequiredSection(b),
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
    ...ruleWrongDocumentForSection(b),
    ...ruleCertExpiresDuringJob(b),
    ...ruleOrphanedLockFile(b),
    ...ruleCombinedStampAttribution(b),
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

export interface FlagCounts {
  critical: number
  warning: number
  info: number
  total: number
  /** Individual records behind those findings. A book can have 4 critical
   *  findings covering 300 records; both numbers are worth showing, but
   *  the first is the one a manager acts on. */
  criticalRecords: number
  totalRecords: number
}

export function countBySeverity(findings: (Finding | AggregatedFinding)[]): FlagCounts {
  const c: FlagCounts = {
    critical: 0, warning: 0, info: 0, total: findings.length,
    criticalRecords: 0, totalRecords: 0,
  }
  for (const f of findings) {
    c[f.severity]++
    const n = 'occurrences' in f ? f.occurrences : 1
    c.totalRecords += n
    if (f.severity === 'critical') c.criticalRecords += n
  }
  return c
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

export interface FindingRecord {
  entityType?: string
  entityId?: string
  title: string
  detail: string
  fingerprint: string
}

export interface AggregatedFinding {
  ruleId: string
  severity: FlagSeverity
  /** Reads as one actionable statement — "90 welds at or above 20% SMYS
   *  have not received their required NDE" — rather than as the first of
   *  ninety identical lines. */
  title: string
  detail: string
  occurrences: number
  sectionNumber?: string
  fingerprint: string
  records: FindingRecord[]
  /** True when `records` holds fewer than `occurrences`. */
  recordsTruncated: boolean
}

/**
 * One-line summaries per rule. Written here rather than at each `push`
 * so the queue's wording lives in one readable place, and so a rule that
 * fires once and a rule that fires three hundred times read the same way.
 */
const RULE_SUMMARIES: Record<string, (n: number, sample: Finding) => string> = {
  'welder.not_qualified_on_weld_date': (n) =>
    `${n} weld${n === 1 ? '' : 's'} performed on a date the welder held no valid qualification`,
  'torque.wrench_not_yet_issued': (n) =>
    `${n} connection${n === 1 ? '' : 's'} torqued with a wrench whose calibration postdates the work`,
  'torque.wrench_expired': (n) =>
    `${n} connection${n === 1 ? '' : 's'} torqued with a wrench whose calibration had expired`,
  'torque.wrench_no_certificate': (n) =>
    `${n} connection${n === 1 ? '' : 's'} torqued with a wrench that has no calibration certificate`,
  'torque.wrench_unknown_wrench': (n) =>
    `${n} connection${n === 1 ? '' : 's'} record a wrench that appears on no roster`,
  'torque.wrench_no_wrench_recorded': (n) =>
    `${n} connection${n === 1 ? '' : 's'} record no wrench at all`,
  'torque.wrench_no_calibration_date': (n) =>
    `${n} connection${n === 1 ? '' : 's'} used a wrench whose certificate carries no calibration date`,
  'torque.out_of_range': (n) =>
    `${n} connection${n === 1 ? '' : 's'} were torqued outside their required range`,
  'nde.technician_not_certified_on_report_date': (n) =>
    `${n} NDE report${n === 1 ? '' : 's'} signed by a technician whose certification did not cover the date`,
  'material.heat_without_mtr': (n) =>
    `${n} heat number${n === 1 ? '' : 's'} referenced by welds have no MTR on file`,
  'pressure.no_valid_recorder_cert': (n) =>
    `${n} pressure test${n === 1 ? '' : 's'} have no recorder calibration valid on the test date`,
  'document.wrong_job': (n) =>
    `${n} document${n === 1 ? '' : 's'} reference a different job`,
  'document.wrong_job_filename': (n) =>
    `${n} filename${n === 1 ? '' : 's'} name a job other than this one`,
  'welder.below_xray_minimum': (n) =>
    `${n} welder${n === 1 ? '' : 's'} are below the job's required X-ray percentage`,
  'record.future_dated': (n) =>
    `${n} record${n === 1 ? '' : 's'} are dated after the log's as-of date`,
  'weld.tier_not_met': (n) =>
    `${n} weld${n === 1 ? '' : 's'} have not received the NDE their inspection tier requires`,
  'welder.below_job_nde_requirement': (n) =>
    `${n} welder${n === 1 ? '' : 's'} are below the job's stated NDE requirement`,
  'torque.wrench_not_on_roster': (n) =>
    `${n} wrench${n === 1 ? '' : 'es'} in use appear on no roster row`,
  'weld.smys_uncomputable': (n) =>
    `${n} weld${n === 1 ? '' : 's'} lack the pipe data needed to compute % of SMYS`,
  'weld.no_welder_stamp': (n) =>
    `${n} weld${n === 1 ? '' : 's'} carry no welder stamp`,
  'torque.out_of_tolerance': (n) =>
    `${n} connection${n === 1 ? '' : 's'} were torqued outside the required value`,
  'document.duplicate': (n) =>
    `${n} set${n === 1 ? '' : 's'} of files share identical content`,
  'certificate.expiring_soon': (n) =>
    `${n} certificate${n === 1 ? '' : 's'} expire within the warning window`,
  'cp.flange_without_test_point': (n) =>
    `${n} flange${n === 1 ? '' : 's'} marked CP TEST = Y have no test point on file`,
  'weld.nde_without_report': (n) =>
    `${n} weld${n === 1 ? '' : 's'} record an examination with no report on file`,
  'nde.outside_construction_window': (n) =>
    `${n} NDE report${n === 1 ? '' : 's'} fall outside the construction window`,
  'material.mtr_not_referenced': (n) =>
    `${n} MTR${n === 1 ? '' : 's'} on file are referenced by no weld`,
  'document.filename_normalized': (n) =>
    `${n} file${n === 1 ? '' : 's'} were renamed to the book's filing convention`,
  'document.archive_uploaded': (n) =>
    `${n} archive${n === 1 ? '' : 's'} were uploaded and their contents are not indexed`,
  'section.empty_required': (n) =>
    `${n} required section${n === 1 ? '' : 's'} are empty`,
  'document.same_file_in_two_sections': (n) =>
    `${n} file${n === 1 ? '' : 's'} are filed under two sections at once`,
  'certificate.expires_during_job': (n) =>
    `${n} certificate${n === 1 ? '' : 's'} expire before this job ends`,
}

/**
 * Collapse per-record findings into one entry per rule.
 *
 * A rule that fires once keeps its own wording, since "Wrench 1304's
 * calibration postdates the work" is already the whole story. A rule that
 * fires many times gets a count-led summary and carries its records for
 * drill-down.
 */
export function aggregateFindings(findings: Finding[]): AggregatedFinding[] {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    const list = groups.get(f.ruleId) ?? []
    list.push(f)
    groups.set(f.ruleId, list)
  }

  const out: AggregatedFinding[] = []
  for (const [ruleId, items] of groups) {
    const sample = items[0]!
    const n = items.length
    const summarize = RULE_SUMMARIES[ruleId]
    out.push({
      ruleId,
      severity: sample.severity,
      title: n === 1 || !summarize ? sample.title : summarize(n, sample),
      detail: n === 1
        ? sample.detail
        : `${sample.detail} This is the first of ${n}; open the finding for the full list.`,
      occurrences: n,
      sectionNumber: sample.sectionNumber,
      fingerprint: n === 1 ? sample.fingerprint : fp(ruleId, 'group'),
      records: items.slice(0, MAX_RECORDS_PER_GROUP).map((f) => ({
        entityType: f.entityType,
        entityId: f.entityId,
        title: f.title,
        detail: f.detail,
        fingerprint: f.fingerprint,
      })),
      recordsTruncated: n > MAX_RECORDS_PER_GROUP,
    })
  }

  return out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.occurrences - a.occurrences,
  )
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
