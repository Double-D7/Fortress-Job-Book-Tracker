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
  Certificate, ComplianceFlag, FlagSeverity, IsoDate, JobBookBundle, Weld,
} from './types'
import { today } from './dates'
import { certValidOn, evaluateCert } from './certificates'
import { checkWrenchCalibration, isInspected, reconcileWrenches, suggestWrenchTypo, torqueTotals, torqueWithinTolerance } from './torque'
import {
  checkFlatRule, creditedWelders, isCountable, isXrayed, qualificationOn, qualifiedOn,
  rollupByWelder,
} from './welders'
import { computeSmys, tierRequiresNde, type TierRule } from './engineering'
import { ndeCoverage } from './ndeCoverage'
import { isometricSectionCoverage } from './isometrics'
import { reconcileCp, reconcileHeats } from './reconcile'
import { entryTimeliness, TIMELINESS_TARGET_PCT } from './timeliness'

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

/**
 * A weld performed on a date the welder's qualification did not cover.
 *
 * Split three ways, because "not qualified" and "cannot be shown to be
 * qualified" are different accusations and only one of them is a §11.1
 * Critical.
 *
 * The distinction is not academic. Importing the Weld Log Overview Sheet
 * populates the register with an expiry and no qualification date — that
 * is all the sheet carries — and a rule that reads a missing start as a
 * missing qualification raises a Critical against every weld in the book.
 * On DP-318 that is 1,256 findings, each asserting that no qualification
 * covers a date whose expiry plainly covers it. The real findings would be
 * somewhere in there, unfindable.
 */
export function ruleWelderNotQualified(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const w of b.welds) {
    if (!isCountable(w) || !w.weldDate) continue
    for (const welderId of creditedWelders(w)) {
      const { verdict, qualification } = qualificationOn(
        welderId, w.weldDate, b.welderQualifications,
      )
      if (verdict === 'qualified') continue
      const welder = b.welders.find((x) => x.id === welderId)
      const who = welder?.initials ?? welderId
      const name = welder?.fullName ?? welderId

      if (verdict === 'unverifiable') {
        // Warning, not Critical: the evidence gap is in Fortress's own
        // records, not in the welder's competence, and the fix is filing
        // the WPQ rather than stopping the work.
        out.push({
          ruleId: 'welder.qualification_currency_unverifiable',
          severity: 'warning',
          title: `${who}'s qualification currency cannot be confirmed for ${w.weldDate}`,
          detail:
            `Weld ${w.weldNumber} was performed on ${w.weldDate}. The register holds a ` +
            `qualification for ${name} expiring ${qualification?.expiryDate ?? 'on an unrecorded date'}, ` +
            `but not the date it was granted — which is all the overview sheet records. The ` +
            `expiry has not passed, so this is not an expired qualification; it is a ` +
            `qualification whose window cannot be closed. Filing the WPQ itself in section 6 ` +
            `resolves it.`,
          entityType: 'weld', entityId: w.id, sectionNumber: '6',
          fingerprint: fp('welder.qualification_currency_unverifiable', w.id, welderId),
        })
        continue
      }

      out.push({
        ruleId: 'welder.not_qualified_on_weld_date',
        severity: 'critical',
        title:
          verdict === 'no_record'
            ? `${who} has no qualification on file, and welded on ${w.weldDate}`
            : verdict === 'not_yet'
              ? `${who} was not yet qualified on ${w.weldDate}`
              : `${who}'s qualification had expired on ${w.weldDate}`,
        detail:
          verdict === 'no_record'
            ? `Weld ${w.weldNumber} was performed on ${w.weldDate}. No welder performance ` +
              `qualification for ${name} is on file at all.`
            : verdict === 'not_yet'
              ? `Weld ${w.weldNumber} was performed on ${w.weldDate}, before ${name}'s ` +
                `qualification was granted on ${qualification?.qualificationDate}.`
              : `Weld ${w.weldNumber} was performed on ${w.weldDate}. ${name}'s qualification ` +
                `expired ${qualification?.expiryDate}.`,
        entityType: 'weld', entityId: w.id, sectionNumber: '6',
        fingerprint: fp('welder.not_qualified_on_weld_date', w.id, welderId),
      })
    }
  }
  return cap('welder.not_qualified_on_weld_date', out)
}

/**
 * A roster line that disagrees with the certificate it summarises.
 *
 * Torque logs carry a typed wrench roster in their header block, and it is
 * a summary of the certificates filed in section 13 — not a second source.
 * Where the two disagree, the certificate is the record and the roster line
 * is a transcription error, which is worth surfacing precisely because it
 * is invisible: the log looks internally consistent, and nothing downstream
 * of it can tell that a date was copied off the wrong line.
 *
 * The Greeley book carries exactly one. Wrench 0808's roster line reads
 * 2/4/25; the certificate is calibrated 2025-01-10 and carries a
 * handwritten "DATE WRENCH PUT IN SERVICE: 2/4/25". Someone read the
 * handwriting instead of the printed field.
 */
export function ruleRosterContradictsCertificate(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const w of b.torqueWrenches) {
    const claimed = w.rosterClaimedCalibrationDate ?? null
    const actual = w.lastCalibrationDate ?? null
    if (!claimed || !actual || claimed === actual) continue
    const used = b.torqueConnections.filter(
      (c) => c.wrenchId === w.id || c.wrenchIdRaw === w.wrenchId,
    ).length
    out.push({
      ruleId: 'torque.roster_contradicts_certificate',
      severity: 'warning',
      title: `Wrench ${w.wrenchId}: the log's roster date is not the certificate's`,
      detail: `The torque log's roster block records wrench ${w.wrenchId} as last calibrated ` +
        `${claimed}. Its certificate on file is dated ${actual}. The certificate is the ` +
        `calibration record and is what this book scores against; the roster line is a ` +
        `transcription and should be corrected. ${used} connection${used === 1 ? '' : 's'} ` +
        `were torqued with this wrench.`,
      entityType: 'torque_wrench', entityId: w.id, sectionNumber: '13',
      fingerprint: fp('torque.roster_contradicts_certificate', w.id, claimed, actual),
    })
  }
  return cap('torque.roster_contradicts_certificate', out)
}

/**
 * A certificate that is filed but that this application has not read.
 *
 * Informational, and deliberately so. The book is not deficient — the page
 * is in section 13 and ships with the turnover package. What is missing is
 * our parse of it, which means the calibration window cannot be checked
 * against the dates of the work. That is a gap in this application's
 * coverage and it is reported as one, in our own name.
 */
export function ruleCalibrationCertificateUnread(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const w of b.torqueWrenches) {
    if (!w.certOnFile || w.lastCalibrationDate) continue
    const used = b.torqueConnections.filter(
      (c) => c.wrenchId === w.id || c.wrenchIdRaw === w.wrenchId,
    ).length
    out.push({
      ruleId: 'torque.certificate_unread',
      severity: 'info',
      title: `Wrench ${w.wrenchId}'s calibration certificate is on file but has not been read`,
      detail: `The certificate is filed in section 13 and counts toward that section. Its ` +
        `dates have not been loaded into this book, so the calibration window cannot be ` +
        `checked against the ${used} connection${used === 1 ? '' : 's'} torqued with it. ` +
        `This is an ingestion gap, not a deficiency in the book — the usual cause is a ` +
        `photographed or unscanned page with no text to read.`,
      entityType: 'torque_wrench', entityId: w.id, sectionNumber: '13',
      fingerprint: fp('torque.certificate_unread', w.id),
    })
  }
  return cap('torque.certificate_unread', out)
}

/**
 * A wrench the calibration laboratory failed.
 *
 * A failure is not a calibration. The certificate reader has always
 * captured the lab's own verdict and nothing has ever asked about it,
 * because until certificates could be filed there was no verdict to ask
 * about. Now that there is, a wrench that did not pass is a critical
 * finding against every connection it torqued: the tool was out of
 * tolerance, and the torque values it produced cannot be relied on.
 *
 * Distinct from an expired calibration, which says the window lapsed. A
 * failure says the wrench was wrong while the window was open.
 */
export function ruleWrenchFailedCalibration(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const w of b.torqueWrenches) {
    if (w.calibrationStatus !== 'fail') continue
    const used = b.torqueConnections.filter(
      (c) => c.wrenchId === w.id || c.wrenchIdRaw === w.wrenchId,
    )
    out.push({
      ruleId: 'torque.wrench_failed_calibration',
      severity: 'critical',
      title: `Wrench ${w.wrenchId} failed its calibration`,
      detail: `The calibration certificate on file for wrench ${w.wrenchId} records the ` +
        `laboratory's verdict as a failure. A failed wrench has no calibration window, and ` +
        `the ${used.length} connection${used.length === 1 ? '' : 's'} torqued with it ` +
        `cannot be certified against it. Either an earlier certificate covers the work and ` +
        `should be filed, or those connections need re-torquing with a calibrated wrench.`,
      entityType: 'torque_wrench', entityId: w.id, sectionNumber: '13',
      fingerprint: fp('torque.wrench_failed_calibration', w.id),
    })
  }
  return cap('torque.wrench_failed_calibration', out)
}

/**
 * A wrench whose calibration was expired, missing, or — the case this
 * application exists to catch — not yet issued on the date of the work.
 */
export function ruleWrenchCalibrationInvalid(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const c of b.torqueConnections) {
    const check = checkWrenchCalibration(c, b.torqueWrenches)
    // `certificate_unread` is not a finding against the book. The
    // certificate is on file — it is the calibration record — and the only
    // thing absent is this application's parse of it. Raising it as a
    // deficiency invented 18 findings against wrench 9125 on the Greeley
    // book, whose certificate is filed in section 13 and has been all
    // along. It surfaces as an ingestion gap on the section instead.
    if (check.verdict === 'valid' || check.verdict === 'no_torque_date' ||
        check.verdict === 'certificate_unread') continue

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


/**
 * An NDE report whose source file did not give up everything it holds.
 *
 * A job book with missing data is incomplete, and the missing data here
 * is of a particular kind: it demonstrably exists — it is on a page of a
 * PDF somebody uploaded — and the application could not read it. That is
 * not the same as a document nobody has filed yet, and it is worse,
 * because the folder looks full.
 *
 * So each critical gap the importer recorded becomes a finding against
 * section 10, carrying the page number where there is one, so the person
 * clearing it can open that page and enter what it says. A warning-level
 * gap — a missing technician name, say — is left alone: it is expected
 * and its absence is not evidence that the examination was wrong.
 *
 * Nothing here re-reads the PDF. The gap was decided when the file was
 * imported, by the same parser the person confirmed; re-deriving it would
 * be a second opinion that could differ from what they saw.
 */
export function ruleNdeImportGap(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const r of b.ndeReports) {
    if (r.isSuperseded) continue
    for (const gap of r.importGaps ?? []) {
      if (gap.severity !== 'critical') continue
      const where = gap.page ? ` (page ${gap.page})` : ''
      const source = r.sourceFilename ? ` in ${r.sourceFilename}` : ''
      out.push({
        ruleId: 'nde.import_gap',
        severity: 'critical',
        title: `Part of an inspection report could not be read${where}`,
        detail: `${gap.detail} Report ${r.reportNumber ?? r.id}${source}. ` +
          'The examination it records is not evidenced in this book until ' +
          'somebody enters it or replaces the file.',
        entityType: 'nde_report',
        entityId: r.id,
        sectionNumber: '10',
        // One finding per report and gap, so re-running evaluation does
        // not duplicate it and clearing one does not clear the others.
        fingerprint: fp('nde.import_gap', `${r.id}:${gap.kind}:${gap.page ?? ''}`),
      })
    }
  }
  return cap('nde.import_gap', out)
}


/**
 * A report signed by a technician this book holds no record for.
 *
 * Section 8 is the NDT technicians' credentials, and its purpose is to
 * evidence that the people who examined this pipe were qualified to. A
 * report naming somebody with no record at all defeats that completely:
 * there is no certificate to check, no level, and nothing to expire.
 *
 * Distinct from `nde.technician_not_certified_on_report_date`, which
 * catches a known technician whose certification did not cover the day.
 * This catches the case that rule cannot see, because it needs a
 * technician id to check and there is none.
 *
 * The name is carried through as printed. Matching is exact by design —
 * attributing a radiograph to the wrong person is worse than admitting
 * the name is unknown — so a spelling difference lands here, and the
 * resolution is to add the record or correct the spelling, both of which
 * a person does knowingly.
 */
export function ruleNdeTechnicianUnknown(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const r of b.ndeReports) {
    if (r.isSuperseded || r.technicianId) continue
    out.push({
      ruleId: 'nde.technician_unknown',
      severity: 'critical',
      title: r.technicianName
        ? `No credentials on file for ${r.technicianName}`
        : 'An inspection report names no technician',
      detail: r.technicianName
        ? `Report ${r.reportNumber ?? r.id} was signed by ${r.technicianName}, who is not ` +
          'among this book\u2019s NDT technicians. Section 8 cannot evidence their ' +
          'qualification until the record exists or the spelling is corrected.'
        : `Report ${r.reportNumber ?? r.id} does not name a technician, so there is ` +
          'nobody whose qualification section 8 can evidence.',
      entityType: 'nde_report', entityId: r.id, sectionNumber: '8',
      fingerprint: fp('nde.technician_unknown', r.id),
    })
  }
  return cap('nde.technician_unknown', out)
}


/**
 * Examinations the weld log claims that no report evidences.
 *
 * The book passes its own arithmetic on the log's number and fails an
 * audit on this one, because an auditor asks for the report. Both facts
 * have been on the NDE screen all along without ever being subtracted.
 *
 * Aggregated rather than one finding per weld: 223 separate findings
 * reading "weld 1130 is examined but not evidenced" is a wall nobody
 * reads, and the actionable statement is the count and the shortfall
 * against the rule.
 */
export function ruleNdeExaminedNotEvidenced(b: JobBookBundle): Finding[] {
  if (sectionIsUnread(b, '10')) return []
  const c = ndeCoverage(b.welds, b.ndeReports, b.book)
  if (c.unevidenced.length === 0) return []

  // Short of the rule on evidence is the serious case: the job owes a
  // percentage it cannot currently show. Above it, the gap is still worth
  // closing but the book is not failing its requirement.
  const short = c.meetsOnEvidenced === false
  const owed = c.requiredWelds !== null
    ? ` The rule requires ${c.requiredWelds} of ${c.countableWelds}; ` +
      `${c.evidenced} are evidenced.`
    : ''

  return [{
    ruleId: 'nde.examined_not_evidenced',
    severity: short ? 'critical' : 'warning',
    title: `${c.unevidenced.length} weld(s) are recorded as examined with no inspection report`,
    detail: `The weld log marks ${c.examined} weld(s) examined (${c.examinedPct}%). ` +
      `Inspection reports on file evidence ${c.evidenced} (${c.evidencedPct}%).` + owed +
      ` First without a report: ${c.unevidenced.slice(0, 10).join(', ')}` +
      (c.unevidenced.length > 10 ? ` and ${c.unevidenced.length - 10} more.` : '.'),
    entityType: 'job_book', entityId: b.book.id, sectionNumber: '10',
    fingerprint: fp('nde.examined_not_evidenced', b.book.id),
  }]
}

/**
 * Isometrics the logs reference that no drawing covers.
 *
 * Sections 21 and 22 are the maps an operator reads the book against: the
 * X-ray map and the heat-number-and-torque map. The logs name every line
 * that was worked, so the drawings owed are not a matter of opinion.
 *
 * Aggregated per section. DP-318's torque log alone references 196
 * isometrics, and 196 findings reading "no drawing for 3-PF-2051101A-BCM"
 * is a wall nobody reads. The actionable statement is the count, the
 * shortfall, and enough of the list to start on.
 */
export function ruleIsometricDrawingMissing(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const number of ['21', '22'] as const) {
    if (sectionIsUnread(b, number)) continue
    const def = b.sectionDefinitions.find((d) => d.sectionNumber === number)
    if (!def) continue
    const section = b.sections.find((s) => s.sectionDefinitionId === def.id)
    if (!section || section.status === 'na') continue

    const cov = isometricSectionCoverage(
      number,
      b.welds.filter(isCountable).map((w) => w.isometricNumber),
      b.torqueConnections.map((c) => c.isoNumber),
      b.documents.filter((d) => d.sectionId === section.id && !d.deletedAt && d.approvedAt),
    )
    if (cov.referenced.length === 0 || cov.missing.length === 0) continue

    out.push({
      ruleId: 'isometric.drawing_missing',
      severity: 'critical',
      title: `${cov.missing.length} isometric(s) worked on this job have no §${number} drawing`,
      detail: `The logs reference ${cov.referenced.length} isometric(s) — ` +
        `${cov.fromWeldLog.length} from the weld log, ${cov.fromTorqueLog.length} from the ` +
        `torque log — and section ${number} (${def.title}) holds an approved drawing for ` +
        `${cov.covered.length}. A drawing is matched to the isometric it covers, so filing ` +
        `the right number of drawings for the wrong lines does not close this. ` +
        `First without one: ${cov.missing.slice(0, 10).join(', ')}` +
        (cov.missing.length > 10 ? ` and ${cov.missing.length - 10} more.` : '.'),
      entityType: 'job_book', entityId: b.book.id, sectionNumber: number,
      fingerprint: fp('isometric.drawing_missing', b.book.id, number),
    })
  }
  return cap('isometric.drawing_missing', out)
}

/**
 * Drawings on file that name no isometric.
 *
 * Not a deficiency in the book — the drawing is filed and ships with the
 * turnover package — but it counts toward nothing, because nothing can
 * say which line it covers. A warning in our own name, resolved by
 * tagging the drawing at upload or renaming it to the line number.
 */
export function ruleDrawingNotAttributable(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const number of ['21', '22'] as const) {
    if (sectionIsUnread(b, number)) continue
    const def = b.sectionDefinitions.find((d) => d.sectionNumber === number)
    if (!def) continue
    const section = b.sections.find((s) => s.sectionDefinitionId === def.id)
    if (!section || section.status === 'na') continue

    const cov = isometricSectionCoverage(
      number,
      b.welds.filter(isCountable).map((w) => w.isometricNumber),
      b.torqueConnections.map((c) => c.isoNumber),
      b.documents.filter((d) => d.sectionId === section.id && !d.deletedAt && d.approvedAt),
    )
    if (cov.unattributable.length === 0) continue

    out.push({
      ruleId: 'isometric.drawing_not_attributable',
      severity: 'warning',
      title: `${cov.unattributable.length} §${number} drawing(s) name no isometric`,
      detail: `These are filed and approved in section ${number} and count toward its score ` +
        `for no isometric, because neither their filename nor an upload tag says which line ` +
        `they cover. Tag them on upload, or rename them to the line number. ` +
        `First: ${cov.unattributable.slice(0, 5).join(', ')}` +
        (cov.unattributable.length > 5 ? ` and ${cov.unattributable.length - 5} more.` : '.'),
      entityType: 'job_book', entityId: b.book.id, sectionNumber: number,
      fingerprint: fp('isometric.drawing_not_attributable', b.book.id, number),
    })
  }
  return cap('isometric.drawing_not_attributable', out)
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
  // The instrument certificates live inside the section 17 test packs.
  // Until those are read, "no valid certificate" means "not looked at yet".
  if (sectionIsUnread(b, '17')) return []

  const out: Finding[] = []
  for (const t of b.pressureTests) {
    // All three, not one. FDS-JBMP-001 §11.1 makes it a Critical finding to
    // accept a test "without gauge, recorder and pressure safety valve
    // certificates valid on the test date". Only the recorder was checked,
    // so two of the three instruments could be uncertified and the book
    // would say nothing.
    const instruments = [
      { label: 'gauge',    serial: t.gaugeSerial,    certId: t.gaugeCertId },
      { label: 'recorder', serial: t.recorderSerial, certId: t.recorderCertId },
      { label: 'PSV',      serial: t.psvSerial,      certId: t.psvCertId },
    ] as const

    const failures: string[] = []
    for (const inst of instruments) {
      const cert = b.certificates.find((c) => c.id === inst.certId)
      if (!cert) { failures.push(`no ${inst.label} certificate is linked`); continue }
      if (!cert.issueDate) {
        failures.push(`the ${inst.label} certificate is on file but has not been read`)
        continue
      }
      if (!t.testDate) { failures.push(`the test carries no date, so the ${inst.label} certificate cannot be checked`); continue }
      if (t.testDate < cert.issueDate) {
        failures.push(`the ${inst.label} certificate is dated ${cert.issueDate}, after the test`)
        continue
      }
      if (cert.expiryDate && t.testDate > cert.expiryDate) {
        failures.push(`the ${inst.label} certificate expired ${cert.expiryDate}, before the test`)
      }
    }

    if (failures.length) {
      out.push({
        ruleId: 'pressure.no_valid_instrument_cert',
        severity: 'critical',
        title: `Pressure test ${t.testIdentifier} was accepted without all three instruments certified`,
        detail: `A test needs gauge, recorder and pressure safety valve certificates valid on ` +
          `the test date${t.testDate ? ` (${t.testDate})` : ''}. For this test: ` +
          `${failures.join('; ')}.`,
        entityType: 'pressure_test', entityId: t.id, sectionNumber: '17',
        fingerprint: fp('pressure.no_valid_instrument_cert', t.id),
      })
    }

    // "No test present as certificates only." Appendix A §17. The baseline
    // review found 13 of 21 facility packages holding instrument
    // certificates and no result document — a test that was performed, or
    // was not, and the book cannot say which.
    if (!t.resultDocumentId && !t.chartDocumentId) {
      out.push({
        ruleId: 'pressure.no_result_document',
        severity: 'critical',
        title: `Pressure test ${t.testIdentifier} has certificates but no result document`,
        detail: 'The package holds instrument certificates and nothing recording what the ' +
          'test actually showed. A test with no result is not evidence that a test passed.',
        entityType: 'pressure_test', entityId: t.id, sectionNumber: '17',
        fingerprint: fp('pressure.no_result_document', t.id),
      })
    }

    // Hold data. Appendix A §17 requires start and end pressure, duration
    // and ambient temperature — a pass with no readings behind it is the
    // "result with no recorded basis" §11.2 calls a Major finding.
    const holdMissing = [
      t.startPressurePsi == null && 'start pressure',
      t.endPressurePsi == null && 'end pressure',
      t.durationMinutes == null && 'hold duration',
      t.ambientTempF == null && 'ambient temperature',
    ].filter((x): x is string => typeof x === 'string')

    if (holdMissing.length && (t.resultDocumentId || t.chartDocumentId)) {
      out.push({
        ruleId: 'pressure.hold_data_incomplete',
        severity: 'warning',
        title: `Pressure test ${t.testIdentifier} is missing hold data`,
        detail: `Recorded without ${holdMissing.join(', ')}. Appendix A §17 requires start and ` +
          'end pressure, duration and ambient temperature, so a result can be checked rather ' +
          'than taken on trust.',
        entityType: 'pressure_test', entityId: t.id, sectionNumber: '17',
        fingerprint: fp('pressure.hold_data_incomplete', t.id),
      })
    }
  }
  return cap('pressure.instrument_certs', out)
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

/**
 * A record entered outside its §8.1 standard.
 *
 * §8.3 is explicit about what happens to a late entry: "A record entered
 * late is entered accurately and flagged late; it is never back dated."
 * So this rule does not block anything and does not accuse anyone of
 * falsification — it makes the lateness visible, which is the only way the
 * Entry Timeliness Rate can be acted on rather than merely reported.
 *
 * Severity is `info` on purpose. A late entry is a §11.3 Minor finding:
 * the record is accurate, the evidence is real, and the problem is a
 * process one. Ranking it alongside an expired welder qualification would
 * bury the qualification.
 */
export function ruleLateEntry(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const a of entryTimeliness(b).late) {
    out.push({
      ruleId: 'timeliness.late_entry',
      severity: 'info',
      title: `${a.recordLabel} was entered ${a.daysLate} business day${a.daysLate === 1 ? '' : 's'} past its standard`,
      detail:
        `Work dated ${a.workDate}, due in the book by ${a.dueBy} under FDS-JBMP-001 §8.1, ` +
        `entered ${a.enteredOn}. The record stands as entered — §8.3 requires a late entry to ` +
        `be accurate and flagged, never back-dated.`,
      entityType: a.standardId,
      entityId: a.recordId,
      sectionNumber: a.sectionNumber,
      fingerprint: fp('timeliness.late_entry', a.standardId, a.recordId),
    })
  }
  return cap('timeliness.late_entry', out)
}

/**
 * A record entered before the work it reports.
 *
 * This is not a timeliness result. §11.1 makes "any record dated in the
 * future" a Critical finding, and a record written down before the work
 * happened is the same defect seen from the other end: at the moment
 * somebody typed it, the thing it asserts had not occurred.
 */
export function ruleEnteredBeforeWork(b: JobBookBundle): Finding[] {
  const out: Finding[] = []
  for (const a of entryTimeliness(b).all) {
    if (a.verdict !== 'entered_before_work') continue
    out.push({
      ruleId: 'timeliness.entered_before_work',
      severity: 'critical',
      title: `${a.recordLabel} was entered before the work it reports`,
      detail:
        `Entered ${a.enteredOn} against a work date of ${a.workDate}. At the moment this record ` +
        `was written the work it asserts had not happened, so the entry cannot be a record of it.`,
      entityType: a.standardId,
      entityId: a.recordId,
      sectionNumber: a.sectionNumber,
      fingerprint: fp('timeliness.entered_before_work', a.standardId, a.recordId),
    })
  }
  return cap('timeliness.entered_before_work', out)
}

/**
 * The book as a whole is filing late.
 *
 * One finding for the book, not one per record — the per-record rule
 * already covers those. This is the number a Project Manager is escalated
 * on under §8.3, and it belongs in the queue as a single management item.
 */
export function ruleTimelinessBelowTarget(b: JobBookBundle): Finding[] {
  const r = entryTimeliness(b)
  if (r.ratePct == null || r.ratePct >= TIMELINESS_TARGET_PCT) return []
  return [{
    ruleId: 'timeliness.below_target',
    severity: r.needsEscalation ? 'warning' : 'info',
    title: `Entry Timeliness Rate is ${r.ratePct}%, below the ${TIMELINESS_TARGET_PCT}% target`,
    detail:
      `${r.withinStandard} of ${r.totalMeasured} measurable entries met their §8.1 standard` +
      (r.unmeasurable > 0 ? `; a further ${r.unmeasurable} could not be measured` : '') +
      `. ` +
      (r.needsEscalation
        ? `§8.3 escalates a book below 90% for two consecutive weeks to the Project Manager and the VP of Operations.`
        : `The target is 95%.`),
    sectionNumber: '12',
    fingerprint: fp('timeliness.below_target'),
  }]
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

/** Human name, work unit and home section for a certificate's subject. A
 *  raw `wrench-dp318-5155` in a finding title tells a reader nothing. */
function subjectOf(
  b: JobBookBundle,
  c: Certificate,
): { name: string; workUnit: string; sectionNumber: string } {
  switch (c.subjectType) {
    case 'welder': {
      const w = b.welders.find((x) => x.id === c.subjectId)
      return { name: w?.fullName ?? c.subjectId, workUnit: 'weld', sectionNumber: '6' }
    }
    case 'cwi': {
      const w = b.cwis.find((x) => x.id === c.subjectId)
      return { name: w?.fullName ?? c.subjectId, workUnit: 'inspection', sectionNumber: '7' }
    }
    case 'ndt_technician': {
      const t = b.ndtTechnicians.find((x) => x.id === c.subjectId)
      return { name: t?.fullName ?? c.subjectId, workUnit: 'NDE report', sectionNumber: '8' }
    }
    case 'torque_wrench': {
      const w = b.torqueWrenches.find((x) => x.id === c.subjectId)
      return {
        name: w ? `Torque wrench ${w.wrenchId}` : c.subjectId,
        workUnit: 'connection', sectionNumber: '13',
      }
    }
    default:
      return { name: c.subjectId, workUnit: 'record', sectionNumber: '13' }
  }
}

/** How much work this certificate was supposed to cover but did not. */
function workRecordedAfter(b: JobBookBundle, c: Certificate, expiry: string): number {
  switch (c.subjectType) {
    case 'welder':
      return b.welds.filter(
        (w) => w.weldDate && w.weldDate > expiry && creditedWelders(w).includes(c.subjectId),
      ).length
    case 'ndt_technician':
      return b.ndeReports.filter(
        (r) => r.technicianId === c.subjectId && r.reportDate > expiry,
      ).length
    case 'torque_wrench': {
      const w = b.torqueWrenches.find((x) => x.id === c.subjectId)
      if (!w) return 0
      return b.torqueConnections.filter(
        (x) => (x.wrenchId === w.id || x.wrenchIdRaw === w.wrenchId) &&
          !!x.torqueDate && x.torqueDate > expiry,
      ).length
    }
    default:
      return 0
  }
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

    // Every certificate subject covers a different kind of work, so "was
    // anything done after it lapsed" is a different count for each — and
    // the finding belongs in the section that holds the certificate, not
    // uniformly in section 6.
    const subject = subjectOf(b, c)
    const workAfter = workRecordedAfter(b, c, c.expiryDate)
    const unit = subject.workUnit
    out.push({
      ruleId: 'certificate.expires_during_job',
      severity: workAfter > 0 ? 'critical' : 'warning',
      title: `${subject.name}'s ${c.certType} expires ${c.expiryDate}, before the job ends ${end}`,
      detail: workAfter > 0
        ? `${workAfter} ${unit}${workAfter === 1 ? ' is' : 's are'} recorded after that date ` +
          `and not covered.`
        : `No work is recorded after that date yet, so nothing is uncovered — but any further ` +
          `${unit} on this job would be.`,
      entityType: 'certificate', entityId: c.id, sectionNumber: subject.sectionNumber,
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
    ...ruleRosterContradictsCertificate(b),
    ...ruleCalibrationCertificateUnread(b),
    ...ruleWrenchFailedCalibration(b),
    ...ruleNdeTechnicianNotCertified(b),
    ...ruleNdeImportGap(b),
    ...ruleNdeTechnicianUnknown(b),
    ...ruleNdeExaminedNotEvidenced(b),
    ...ruleIsometricDrawingMissing(b),
    ...ruleDrawingNotAttributable(b),
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
    ...ruleLateEntry(b),
    ...ruleEnteredBeforeWork(b),
    ...ruleTimelinessBelowTarget(b),
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
  'torque.roster_contradicts_certificate': (n) =>
    `${n} wrench roster line${n === 1 ? '' : 's'} disagree with the certificate on file`,
  'torque.certificate_unread': (n) =>
    `${n} calibration certificate${n === 1 ? '' : 's'} on file have not been read into the book`,
  'torque.out_of_range': (n) =>
    `${n} connection${n === 1 ? '' : 's'} were torqued outside their required range`,
  'nde.technician_not_certified_on_report_date': (n) =>
    `${n} NDE report${n === 1 ? '' : 's'} signed by a technician whose certification did not cover the date`,
  'material.heat_without_mtr': (n) =>
    `${n} heat number${n === 1 ? '' : 's'} referenced by welds have no MTR on file`,
  'pressure.no_valid_instrument_cert': (n) =>
    `${n} pressure test${n === 1 ? '' : 's'} were accepted without gauge, recorder and PSV certificates valid on the test date`,
  'pressure.no_result_document': (n) =>
    `${n} pressure test${n === 1 ? '' : 's'} hold certificates but no result document`,
  'pressure.hold_data_incomplete': (n) =>
    `${n} pressure test${n === 1 ? '' : 's'} are missing start pressure, end pressure, duration or ambient temperature`,
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
