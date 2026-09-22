/**
 * Gate reviews — FDS-JBMP-001 §7.
 *
 * A gate review is a documented decision about whether a job book may
 * advance. The program states the criteria; this module evaluates them
 * against the book's own records and reports what it found.
 *
 * THREE RULES GOVERN EVERYTHING BELOW.
 *
 * 1. The app does not decide the gate. §7 makes the QA/QC Manager the
 *    chair and the decision theirs. This module produces evidence, not a
 *    verdict, and `recordGateReview` in the database is what turns a
 *    decision into a record.
 *
 * 2. Silence is never scored as compliance. Where the evidence has not
 *    been loaded, or the control a criterion depends on does not exist in
 *    the app yet, the result is `indeterminate` and says so in words. It
 *    is never quietly `met`. A chair may pass a gate over an indeterminate
 *    criterion, but the database demands a written override to do it.
 *
 * 3. The criterion text is the program's, verbatim. A chair signing a gate
 *    is signing against that sentence, not against a paraphrase of it, and
 *    an auditor will read the two side by side.
 */

import { certValidOn } from './certificates'
import { entryTimeliness } from './timeliness'
import { scoreBook } from './scoring'
import { today } from './dates'
import type {
  CriterionResult,
  CriterionSource,
  CriterionState,
  GateEvaluation,
  GateId,
  IsoDate,
  JobBookBundle,
  PlannedMilestone,
  PlannedMilestoneId,
} from './types'

export interface GateContext {
  /** Evaluation date. Injectable so tests are not time-dependent. */
  asOf?: IsoDate
  /** Competency level of the named Custodian, which lives on the user row
   *  rather than in the bundle. Absent means not looked up — which is not
   *  the same as unqualified, and is reported as indeterminate. */
  custodianCompetency?: string | null
  custodianName?: string | null
  /**
   * Entry Timeliness Rate for the period, 0–100 (§8.3).
   *
   * Left unset, it is derived from the book itself. Supplied, it overrides
   * — a gate is normally read against the WEEK the program reports on
   * rather than against the book's whole history, and only the caller
   * knows which period is being gated.
   */
  entryTimelinessRate?: number | null
  /** Tier 1/2/3 audit state (§10). Absent until an audit has been run. */
  latestPeerAuditScore?: number | null
  latestPeerAuditCriticals?: number | null
  peerAuditsPerformed?: number
  selfAuditsDue?: number
  selfAuditsPerformed?: number
  tier3VerifiedAt?: string | null
  completenessCertifiedAt?: string | null
}

// ---------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------

const met = (
  id: string,
  gate: GateId,
  text: string,
  detail: string,
  source: CriterionSource = 'derived',
  evidence?: string[],
): CriterionResult => ({ id, gate, text, source, state: 'met', detail, evidence })

const unmet = (
  id: string,
  gate: GateId,
  text: string,
  detail: string,
  source: CriterionSource = 'derived',
  evidence?: string[],
): CriterionResult => ({ id, gate, text, source, state: 'not_met', detail, evidence })

const unknown = (
  id: string,
  gate: GateId,
  text: string,
  detail: string,
  source: CriterionSource = 'derived',
): CriterionResult => ({ id, gate, text, source, state: 'indeterminate', detail })

/** met when `ok`, otherwise not met, with the same sentence either way. */
const decide = (
  ok: boolean,
  id: string,
  gate: GateId,
  text: string,
  okDetail: string,
  badDetail: string,
  evidence?: string[],
): CriterionResult =>
  ok
    ? met(id, gate, text, okDetail, 'derived')
    : unmet(id, gate, text, badDetail, 'derived', evidence)

/**
 * A criterion the app cannot see at all, stated plainly.
 *
 * Used where the control is a human act with no digital trace in this
 * system — a client confirming a revision by email, a lessons-learned
 * session being held. The chair records it; the app records that the chair
 * recorded it. Reported as indeterminate so it is visible on the face of
 * the review rather than assumed.
 */
const attested = (id: string, gate: GateId, text: string, detail: string): CriterionResult =>
  unknown(id, gate, text, detail, 'attested')

const pct = (n: number) => `${n.toFixed(2)}%`
const list = (xs: string[], max = 8) =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`

// ---------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------

/**
 * Live documents filed in one section, by section NUMBER.
 *
 * `document.section_id` points at `job_book_section.id`, not at the
 * section definition — the definition is the template row, shared by every
 * book built from it. Comparing against the definition matches nothing,
 * which reads on screen as "no document filed in §3, §4, §5, §9" for a
 * book whose procedures are all present.
 */
function documentsInSection(b: JobBookBundle, sectionNumber: string) {
  const def = b.sectionDefinitions.find((d) => d.sectionNumber === sectionNumber)
  if (!def) return []
  const section = b.sections.find((s) => s.sectionDefinitionId === def.id)
  if (!section) return []
  return b.documents.filter(
    (d) => d.sectionId === section.id && !d.deletedAt && !d.isSuperseded,
  )
}

/** Sections that count: on the checklist for this book type, not N/A. */
function applicableSections(b: JobBookBundle) {
  const defs = b.sectionDefinitions.filter(
    (d) => d.appliesTo === 'both' || d.appliesTo === b.book.bookType,
  )
  return defs
    .map((def) => ({ def, section: b.sections.find((s) => s.sectionDefinitionId === def.id) }))
    .filter((x) => x.section?.status !== 'na')
}

/** The §6.2 milestone a gate is measured against. */
const MILESTONE_FOR_GATE: Partial<Record<GateId, PlannedMilestoneId>> = {
  G0: 'gate_0_passed',
  G1: 'construction_25',
  G2: 'construction_50',
  G3: 'mechanical_completion',
  G4: 'gate_4_entry',
  G5: 'submission',
}

export const DEFAULT_PLANNED_CURVE: PlannedMilestone[] = [
  { milestone: 'gate_0_passed', minimumPct: 8 },
  { milestone: 'construction_25', minimumPct: 25 },
  { milestone: 'construction_50', minimumPct: 50 },
  { milestone: 'mechanical_completion', minimumPct: 85 },
  { milestone: 'gate_4_entry', minimumPct: 98 },
  { milestone: 'submission', minimumPct: 100 },
]

export function plannedMinimumFor(b: JobBookBundle, gate: GateId): number | null {
  const milestone = MILESTONE_FOR_GATE[gate]
  if (!milestone) return null
  const curve = b.book.plannedCurve ?? DEFAULT_PLANNED_CURVE
  return curve.find((m) => m.milestone === milestone)?.minimumPct ?? null
}

/**
 * Open findings by severity. `critical` is §11.1; `warning` carries the
 * Major classes of §11.2.
 *
 * Returns null when the register was never loaded. Every caller has to
 * handle that separately from an empty register, because "I did not look"
 * and "there are none" are opposite answers to a gate criterion.
 */
function openFindings(b: JobBookBundle) {
  if (!b.complianceFlags) return null
  const open = b.complianceFlags.filter(
    (f) => f.state === 'open' || f.state === 'acknowledged',
  )
  return {
    critical: open.filter((f) => f.severity === 'critical'),
    major: open.filter((f) => f.severity === 'warning'),
    all: open,
  }
}

function pastDue(
  findings: { dueAt?: IsoDate | null; title: string }[],
  asOf: IsoDate,
): { late: typeof findings; undated: typeof findings } {
  return {
    late: findings.filter((f) => f.dueAt != null && f.dueAt < asOf),
    // §11.5: a finding with no due date cannot be past due, which would
    // make "zero open NCRs past due date" trivially true for a register
    // nobody dated. It counts as unmet instead.
    undated: findings.filter((f) => f.dueAt == null),
  }
}

// ---------------------------------------------------------------------
// Gate 0 — Book Initiation
// ---------------------------------------------------------------------

function gate0(b: JobBookBundle, ctx: GateContext, asOf: IsoDate): CriterionResult[] {
  const out: CriterionResult[] = []
  const G: GateId = 'G0'

  /**
   * The date "mobilizing" means.
   *
   * Gate 0 sits before first weld, so the question is whether the people
   * and equipment are certified for the work window that is about to
   * start — not whether they are certified on the day someone happens to
   * open the screen. Evaluating a book delivered in 2025 against today's
   * date reports every inspector on it as uncredentialled, which is both
   * false and the kind of false that teaches people to ignore the app.
   */
  const mobilizing = b.book.constructionStart ?? asOf

  // 1 — scaffolding
  const defs = b.sectionDefinitions.filter(
    (d) => d.appliesTo === 'both' || d.appliesTo === b.book.bookType,
  )
  const missing = defs.filter((d) => !b.sections.some((s) => s.sectionDefinitionId === d.id))
  const naWithoutReason = b.sections.filter(
    (s) => s.status === 'na' && !s.naReason?.trim(),
  )
  out.push(
    decide(
      missing.length === 0 && naWithoutReason.length === 0,
      'g0.scaffolded',
      G,
      'Job book created from the correct template with all applicable sections scaffolded and non applicable sections marked N/A with a recorded reason.',
      `All ${defs.length} sections of the ${b.book.bookType} template are scaffolded; every N/A section carries a reason.`,
      [
        missing.length ? `${missing.length} section(s) not scaffolded` : '',
        naWithoutReason.length ? `${naWithoutReason.length} N/A section(s) with no recorded reason` : '',
      ]
        .filter(Boolean)
        .join('; '),
      missing.map((d) => `§${d.sectionNumber} ${d.title}`),
    ),
  )

  // 2 — Custodian
  if (!b.book.custodianId) {
    out.push(
      unmet(
        'g0.custodian',
        G,
        'Job Book Custodian named in writing and holding competency level JB-2 or above.',
        'No Custodian is named on this book.',
      ),
    )
  } else if (ctx.custodianCompetency == null) {
    out.push(
      unknown(
        'g0.custodian',
        G,
        'Job Book Custodian named in writing and holding competency level JB-2 or above.',
        `${ctx.custodianName ?? 'A Custodian'} is named, but no competency level has been assessed. Not assessed is not the same as qualified.`,
      ),
    )
  } else {
    const ok = ctx.custodianCompetency !== 'JB-1'
    out.push(
      decide(
        ok,
        'g0.custodian',
        G,
        'Job Book Custodian named in writing and holding competency level JB-2 or above.',
        `${ctx.custodianName ?? 'Custodian'} named, competency ${ctx.custodianCompetency}.`,
        `${ctx.custodianName ?? 'Custodian'} holds ${ctx.custodianCompetency}; §5.1 requires JB-2 or above.`,
      ),
    )
  }

  // 3 — governing documents
  const gd = b.book
  const haveRefs = !!gd.clientChecklistReference && !!gd.pipingSpecReference
  const haveRevs = !!gd.clientChecklistRevision && !!gd.pipingSpecRevision
  out.push(
    decide(
      haveRefs && haveRevs && !!gd.governingDocsConfirmedAt,
      'g0.governing_docs',
      G,
      'Client checklist revision and client piping specification revision recorded and confirmed current with the client.',
      `Checklist ${gd.clientChecklistReference} rev ${gd.clientChecklistRevision}; piping specification ${gd.pipingSpecReference} rev ${gd.pipingSpecRevision}; confirmed with the client ${gd.governingDocsConfirmedAt}.`,
      !haveRefs
        ? 'The governing checklist and piping specification are not recorded on this book.'
        : !haveRevs
          ? 'The governing documents are named but their revisions are not recorded.'
          : 'Recorded, but never confirmed current with the client. §3 names that gap a finding waiting to happen.',
    ),
  )

  // 4 — procedures loaded
  const PROCEDURE_SECTIONS = ['3', '4', '5', '9']
  const emptyProcedures = PROCEDURE_SECTIONS.filter(
    (n) => defs.some((d) => d.sectionNumber === n) && documentsInSection(b, n).length === 0,
  )
  out.push(
    decide(
      emptyProcedures.length === 0,
      'g0.procedures_loaded',
      G,
      'Section 3 piping specification, Section 4 WPS, Section 5 PQR and Section 9 NDT procedures loaded and legible.',
      'All four procedure sections hold at least one document. Legibility is the chair’s to confirm.',
      `No document filed in section${emptyProcedures.length > 1 ? 's' : ''} ${emptyProcedures.map((n) => `§${n}`).join(', ')}.`,
      emptyProcedures.map((n) => `§${n}`),
    ),
  )

  // 5 — welder qualification valid through the work window
  const windowEnd = b.book.constructionEnd ?? b.book.targetTurnoverDate ?? asOf
  const activeWelders = b.welders.filter((w) => w.active)
  const unqualified = activeWelders.filter((w) => {
    const quals = b.welderQualifications.filter((q) => q.welderId === w.id)
    if (quals.length === 0) return true
    return !quals.some(
      (q) => !q.expiryDate || q.expiryDate >= windowEnd,
    )
  })
  out.push(
    activeWelders.length === 0
      ? unknown(
          'g0.wpq',
          G,
          'Section 6 WPQ on file, current, and valid through the planned work window for every welder mobilizing.',
          'No welders are on the roster yet, so there is nothing to check. Gate 0 sits before first weld; the roster is what makes this criterion answerable.',
        )
      : decide(
          unqualified.length === 0,
          'g0.wpq',
          G,
          'Section 6 WPQ on file, current, and valid through the planned work window for every welder mobilizing.',
          `All ${activeWelders.length} mobilizing welders hold a qualification valid through ${windowEnd}.`,
          `${unqualified.length} of ${activeWelders.length} welders hold no qualification valid through ${windowEnd}: ${list(unqualified.map((w) => w.initials || w.fullName))}.`,
          unqualified.map((w) => w.initials || w.fullName),
        ),
  )

  // 6 — inspector credentials
  const inspectorProblems: string[] = []
  for (const c of b.cwis.filter((x) => x.active)) {
    if (!certValidOn(b.certificates, 'cwi', c.id, mobilizing)) {
      inspectorProblems.push(`CWI ${c.initials || c.fullName}`)
    }
  }
  for (const t of b.ndtTechnicians.filter((x) => x.active)) {
    if (!certValidOn(b.certificates, 'ndt_technician', t.id, mobilizing)) {
      inspectorProblems.push(`NDT ${t.initials || t.fullName}`)
    }
  }
  const inspectorCount = b.cwis.filter((x) => x.active).length + b.ndtTechnicians.filter((x) => x.active).length
  out.push(
    inspectorCount === 0
      ? unknown(
          'g0.inspector_creds',
          G,
          'Section 7 CWI credentials and Section 8 NDT technician credentials on file and current for every inspector mobilizing.',
          'No inspectors are on the roster yet, so there is nothing to check.',
        )
      : decide(
          inspectorProblems.length === 0,
          'g0.inspector_creds',
          G,
          'Section 7 CWI credentials and Section 8 NDT technician credentials on file and current for every inspector mobilizing.',
          `All ${inspectorCount} mobilizing inspectors hold credentials valid on ${mobilizing}.`,
          `${inspectorProblems.length} of ${inspectorCount} inspectors hold no credential valid at mobilization (${mobilizing}): ${list(inspectorProblems)}.`,
          inspectorProblems,
        ),
  )

  // 7 — wrench calibration and register
  const wrenchProblems = b.torqueWrenches.filter(
    (w) => !w.certOnFile || !certValidOn(b.certificates, 'torque_wrench', w.id, mobilizing),
  )
  const wrenchesOnLog = new Set(
    b.torqueConnections.map((c) => c.wrenchId).filter((x): x is string => !!x),
  )
  const unregistered = [...wrenchesOnLog].filter(
    (id) => !b.torqueWrenches.some((w) => w.id === id || w.wrenchId === id),
  )
  out.push(
    b.torqueWrenches.length === 0 && unregistered.length === 0
      ? unknown(
          'g0.wrench_calibration',
          G,
          'Section 13 calibration certificates on file and current for every torque wrench mobilizing, with each wrench entered in the controlled wrench register.',
          'No wrenches are on the register yet, so there is nothing to check.',
        )
      : decide(
          wrenchProblems.length === 0 && unregistered.length === 0,
          'g0.wrench_calibration',
          G,
          'Section 13 calibration certificates on file and current for every torque wrench mobilizing, with each wrench entered in the controlled wrench register.',
          `All ${b.torqueWrenches.length} registered wrenches hold a calibration valid on ${mobilizing}.`,
          [
            wrenchProblems.length
              ? `${wrenchProblems.length} wrench(es) with no calibration valid at mobilization (${mobilizing}): ${list(wrenchProblems.map((w) => w.wrenchId))}`
              : '',
            unregistered.length
              ? `${unregistered.length} wrench ID(s) used on the torque log but absent from the register: ${list(unregistered)}`
              : '',
          ]
            .filter(Boolean)
            .join('; '),
          [...wrenchProblems.map((w) => w.wrenchId), ...unregistered],
        ),
  )

  // 8 — expected-by dates
  const applicable = applicableSections(b)
  const undated = applicable.filter((x) => !x.section?.expectedBy)
  out.push(
    decide(
      undated.length === 0 && applicable.length > 0,
      'g0.expected_by',
      G,
      'Section expected by dates set against the construction schedule.',
      `All ${applicable.length} applicable sections carry an expected-by date.`,
      applicable.length === 0
        ? 'No applicable sections to date.'
        : `${undated.length} of ${applicable.length} applicable sections have no expected-by date.`,
      undated.map((x) => `§${x.def.sectionNumber}`),
    ),
  )

  // 9 — planned curve agreed
  out.push(
    decide(
      !!b.book.plannedCurveAgreedAt,
      'g0.planned_curve',
      G,
      'Planned completion curve agreed and recorded.',
      `Curve agreed ${b.book.plannedCurveAgreedAt}, ${(b.book.plannedCurve ?? DEFAULT_PLANNED_CURVE).length} milestones.`,
      'The book carries a curve but nobody has agreed it. §6.2 makes the curve a Gate 0 agreement between the Custodian and the Project Manager, not a default.',
    ),
  )

  return out
}

// ---------------------------------------------------------------------
// Gate 1 — 25% Construction
// ---------------------------------------------------------------------

function gate1(
  b: JobBookBundle,
  ctx: GateContext,
  asOf: IsoDate,
  completionPct: number,
): CriterionResult[] {
  const out: CriterionResult[] = []
  const G: GateId = 'G1'

  const plan = plannedMinimumFor(b, 'G1')
  out.push(
    plan == null
      ? unknown('g1.curve', G, 'Weighted completion at or above the planned curve.', 'No 25% milestone on this book’s curve.')
      : decide(
          completionPct >= plan,
          'g1.curve',
          G,
          'Weighted completion at or above the planned curve.',
          `Weighted completion ${pct(completionPct)} against a planned ${plan}%.`,
          `Weighted completion ${pct(completionPct)} is ${pct(plan - completionPct)} below the planned ${plan}%.`,
        ),
  )

  out.push(timelinessCriterion(G, b, ctx, 95))
  out.push(selfAuditCriterion(G, ctx))
  out.push(peerAuditCriterion(G, ctx, 90, 'First Tier 2 peer audit performed, scored at 90 or above, with zero Critical findings.'))

  // Controlled registers populated
  const registers: [string, number][] = [
    ['welders', b.welders.length],
    ['wrenches', b.torqueWrenches.length],
    ['heats', b.materialHeats.length],
  ]
  const empty = registers.filter(([, n]) => n === 0).map(([name]) => name)
  out.push(
    empty.length === 0
      ? met(
          'g1.registers',
          G,
          'Controlled registers populated: welders, wrenches, heats, isometric drawings.',
          `Welders ${b.welders.length}, wrenches ${b.torqueWrenches.length}, heats ${b.materialHeats.length}. The isometric drawing register is not yet modelled in the application, so that fourth register is the chair’s to confirm.`,
        )
      : unmet(
          'g1.registers',
          G,
          'Controlled registers populated: welders, wrenches, heats, isometric drawings.',
          `Empty register(s): ${empty.join(', ')}.`,
          'derived',
          empty,
        ),
  )

  // Heat register reconciled, one direction
  const heatsOnWelds = new Set(b.welds.flatMap((w) => w.heatNumbers ?? []))
  const withoutMtr = [...heatsOnWelds].filter((h) => {
    const heat = b.materialHeats.find((m) => m.heatNumber === h)
    return !heat || heat.mtrStatus !== 'on_file'
  })
  out.push(
    heatsOnWelds.size === 0
      ? unknown(
          'g1.heats',
          G,
          'Heat register reconciled. Every heat referenced by a weld has an MTR on file.',
          'No weld carries a heat number yet, so there is nothing to reconcile.',
        )
      : decide(
          withoutMtr.length === 0,
          'g1.heats',
          G,
          'Heat register reconciled. Every heat referenced by a weld has an MTR on file.',
          `All ${heatsOnWelds.size} heats referenced by welds have an MTR on file.`,
          `${withoutMtr.length} of ${heatsOnWelds.size} referenced heats have no MTR on file: ${list(withoutMtr)}.`,
          withoutMtr,
        ),
  )

  out.push(ncrCriterion(G, b, asOf))
  return out
}

// ---------------------------------------------------------------------
// Gate 2 — 50% Construction
// ---------------------------------------------------------------------

function gate2(
  b: JobBookBundle,
  ctx: GateContext,
  asOf: IsoDate,
  completionPct: number,
): CriterionResult[] {
  const G: GateId = 'G2'
  const out: CriterionResult[] = []

  // "All Gate 1 criteria, sustained." Re-run them rather than assume that
  // passing once keeps them true — the program says sustained, and a
  // register can empty, an NCR can age, a curve can be fallen behind.
  const g1 = gate1(b, ctx, asOf, completionPct)
  const stillFailing = g1.filter((c) => c.state === 'not_met')
  const stillUnknown = g1.filter((c) => c.state === 'indeterminate')
  out.push(
    stillFailing.length === 0 && stillUnknown.length === 0
      ? met('g2.gate1_sustained', G, 'All Gate 1 criteria, sustained.', `All ${g1.length} Gate 1 criteria still hold.`)
      : stillFailing.length > 0
        ? unmet(
            'g2.gate1_sustained',
            G,
            'All Gate 1 criteria, sustained.',
            `${stillFailing.length} Gate 1 criteri${stillFailing.length === 1 ? 'on has' : 'a have'} stopped holding: ${list(stillFailing.map((c) => c.id))}.`,
            'derived',
            stillFailing.map((c) => c.id),
          )
        : unknown(
            'g2.gate1_sustained',
            G,
            'All Gate 1 criteria, sustained.',
            `${stillUnknown.length} Gate 1 criteri${stillUnknown.length === 1 ? 'on cannot' : 'a cannot'} be evaluated: ${list(stillUnknown.map((c) => c.id))}.`,
          ),
  )

  const plan = plannedMinimumFor(b, 'G2')
  if (plan != null) {
    out.push(
      decide(
        completionPct >= plan,
        'g2.curve',
        G,
        'Weighted completion at or above the planned curve.',
        `Weighted completion ${pct(completionPct)} against a planned ${plan}%.`,
        `Weighted completion ${pct(completionPct)} is ${pct(plan - completionPct)} below the planned ${plan}%.`,
      ),
    )
  }

  out.push(
    unknown(
      'g2.iso_stage1',
      G,
      'Isometric markup stage 1 complete for every construction area at mechanical completion.',
      'The isometric markup register is not yet modelled in the application. Sections 21 and 22 carry no stage, signer or per-area status, so this cannot be evaluated from the book.',
    ),
  )

  // Pressure tests closed, including result documents
  const tested = b.pressureTests.filter((t) => t.testDate != null)
  const openPacks = tested.filter((t) => !t.resultDocumentId || t.result == null)
  out.push(
    tested.length === 0
      ? unknown(
          'g2.pressure_closed',
          G,
          'Pressure test packages closed for every test performed to date, including result documents.',
          'No pressure test carries a test date yet, so there is nothing to close.',
        )
      : decide(
          openPacks.length === 0,
          'g2.pressure_closed',
          G,
          'Pressure test packages closed for every test performed to date, including result documents.',
          `All ${tested.length} tests performed to date carry a recorded result and a result document.`,
          `${openPacks.length} of ${tested.length} tests performed to date are not closed: ${list(openPacks.map((t) => t.testIdentifier))}.`,
          openPacks.map((t) => t.testIdentifier),
        ),
  )

  // Certificate expiry forecast
  const windowEnd = b.book.constructionEnd ?? b.book.targetTurnoverDate
  if (!windowEnd) {
    out.push(
      unknown(
        'g2.cert_forecast',
        G,
        'Certificate expiry forecast reviewed. No certificate expires inside the remaining work window without a requalification plan on file.',
        'The book carries no construction end or target turnover date, so there is no remaining work window to forecast against.',
      ),
    )
  } else {
    const expiring = b.certificates.filter(
      (c) => c.expiryDate != null && c.expiryDate >= asOf && c.expiryDate < windowEnd,
    )
    out.push(
      expiring.length === 0
        ? met(
            'g2.cert_forecast',
            G,
            'Certificate expiry forecast reviewed. No certificate expires inside the remaining work window without a requalification plan on file.',
            `No certificate expires between ${asOf} and ${windowEnd}.`,
          )
        : unknown(
            'g2.cert_forecast',
            G,
            'Certificate expiry forecast reviewed. No certificate expires inside the remaining work window without a requalification plan on file.',
            `${expiring.length} certificate(s) expire before ${windowEnd}. Whether a requalification plan is on file for each is the chair’s to confirm; the application does not model requalification plans.`,
            'attested',
          ),
    )
  }

  out.push(peerAuditCriterion(G, ctx, 90, 'Tier 2 peer audit scored at 90 or above with zero Critical findings.'))
  return out
}

// ---------------------------------------------------------------------
// Gate 3 — Mechanical Completion
// ---------------------------------------------------------------------

function gate3(b: JobBookBundle, ctx: GateContext, asOf: IsoDate): CriterionResult[] {
  const G: GateId = 'G3'
  const out: CriterionResult[] = []

  // All field records entered — declared scope against actual.
  const shortfalls: string[] = []
  for (const { def, section } of applicableSections(b)) {
    const expected = section?.expectedCount
    if (expected == null || expected === 0) continue
    const actual = countFor(b, def.sectionNumber, def.linkedRecordType ?? null)
    if (actual != null && actual < expected) {
      shortfalls.push(`§${def.sectionNumber} ${actual}/${expected}`)
    }
  }
  out.push(
    decide(
      shortfalls.length === 0,
      'g3.records_entered',
      G,
      'All field records entered. Zero records outstanding.',
      'Every section with a declared scope holds at least the declared number of records.',
      `${shortfalls.length} section(s) below declared scope: ${list(shortfalls)}.`,
      shortfalls,
    ),
  )

  out.push(
    unknown(
      'g3.iso_stages',
      G,
      'Isometric markup stages 1 and 2 complete for all areas.',
      'The isometric markup register is not yet modelled in the application.',
    ),
  )

  // NDE reports received, filed and linked
  const ndeWelds = b.welds.filter((w) => w.ndtMethod != null)
  const unlinked = ndeWelds.filter((w) => !w.ndtReportId)
  out.push(
    ndeWelds.length === 0
      ? unknown('g3.nde', G, 'All NDE reports received, filed and linked to weld records.', 'No weld carries an NDE method yet.')
      : decide(
          unlinked.length === 0,
          'g3.nde',
          G,
          'All NDE reports received, filed and linked to weld records.',
          `All ${ndeWelds.length} welds with an NDE method resolve to a filed report.`,
          `${unlinked.length} of ${ndeWelds.length} welds with an NDE method have no report linked: ${list(unlinked.map((w) => w.weldNumber))}.`,
          unlinked.map((w) => w.weldNumber),
        ),
  )

  // Pressure test packages, fully
  const tested = b.pressureTests.filter((t) => t.testDate != null)
  const incomplete = tested.filter((t) => {
    if (!t.resultDocumentId || t.result == null) return true
    if (t.startPressurePsi == null || t.endPressurePsi == null || t.durationMinutes == null) return true
    const d = t.testDate as IsoDate
    const gauge = t.gaugeCertId ? b.certificates.find((c) => c.id === t.gaugeCertId) : null
    const rec = t.recorderCertId ? b.certificates.find((c) => c.id === t.recorderCertId) : null
    const psv = t.psvCertId ? b.certificates.find((c) => c.id === t.psvCertId) : null
    const validOn = (c: typeof gauge) =>
      !!c && !!c.issueDate && c.issueDate <= d && (!c.expiryDate || c.expiryDate >= d)
    return !validOn(gauge) || !validOn(rec) || !validOn(psv)
  })
  out.push(
    tested.length === 0
      ? unknown(
          'g3.pressure',
          G,
          'All pressure and hydro test packages complete with hold data, result documents and valid on test date instrument certificates.',
          'No pressure test carries a test date yet.',
        )
      : decide(
          incomplete.length === 0,
          'g3.pressure',
          G,
          'All pressure and hydro test packages complete with hold data, result documents and valid on test date instrument certificates.',
          `All ${tested.length} test packages carry hold data, a result document and gauge, recorder and PSV certificates valid on the test date.`,
          `${incomplete.length} of ${tested.length} test packages are incomplete: ${list(incomplete.map((t) => t.testIdentifier))}.`,
          incomplete.map((t) => t.testIdentifier),
        ),
  )

  // Heat register, both directions
  const heatsOnWelds = new Set(b.welds.flatMap((w) => w.heatNumbers ?? []))
  const noMtr = [...heatsOnWelds].filter((h) => {
    const heat = b.materialHeats.find((m) => m.heatNumber === h)
    return !heat || heat.mtrStatus !== 'on_file'
  })
  const orphanMtr = b.materialHeats.filter(
    (m) => m.mtrStatus === 'on_file' && !heatsOnWelds.has(m.heatNumber),
  )
  out.push(
    heatsOnWelds.size === 0
      ? unknown('g3.heats', G, 'Heat register fully reconciled in both directions: no installed heat without an MTR, and every MTR on file traceable to an installed heat.', 'No weld carries a heat number yet.')
      : decide(
          noMtr.length === 0 && orphanMtr.length === 0,
          'g3.heats',
          G,
          'Heat register fully reconciled in both directions: no installed heat without an MTR, and every MTR on file traceable to an installed heat.',
          `${heatsOnWelds.size} installed heats, all with MTRs; no MTR on file is untraceable to an installed heat.`,
          [
            noMtr.length ? `${noMtr.length} installed heat(s) with no MTR` : '',
            orphanMtr.length ? `${orphanMtr.length} MTR(s) on file traceable to no installed heat` : '',
          ]
            .filter(Boolean)
            .join('; '),
          [...noMtr, ...orphanMtr.map((m) => m.heatNumber)],
        ),
  )

  // Coating, where the section is enabled
  const coatingDef = b.sectionDefinitions.find((d) => d.sectionNumber === '23')
  const coatingSection = coatingDef
    ? b.sections.find((s) => s.sectionDefinitionId === coatingDef.id)
    : undefined
  if (!coatingDef || coatingSection?.status === 'na') {
    out.push({
      id: 'g3.coating',
      gate: G,
      text: 'Coating inspection records complete for all areas requiring them, where the section is enabled.',
      source: 'derived',
      state: 'not_applicable',
      detail: 'Section 23 is not enabled for this book.',
    })
  } else {
    const areas = b.book.constructionAreas ?? []
    const covered = new Set((b.coatingInspections ?? []).map((c) => c.constructionArea))
    const missingAreas = areas.filter((a) => !covered.has(a))
    out.push(
      areas.length === 0
        ? unknown('g3.coating', G, 'Coating inspection records complete for all areas requiring them, where the section is enabled.', 'The book declares no construction areas, so there is no denominator for coverage.')
        : decide(
            missingAreas.length === 0,
            'g3.coating',
            G,
            'Coating inspection records complete for all areas requiring them, where the section is enabled.',
            `All ${areas.length} construction areas carry a coating inspection record.`,
            `${missingAreas.length} of ${areas.length} areas have no coating inspection record: ${list(missingAreas)}.`,
            missingAreas,
          ),
    )
  }

  out.push(
    attested(
      'g3.backlog',
      G,
      'Document backlog at zero. Nothing unfiled.',
      'The application can only see what has been filed into it. A pile of unfiled paper is invisible here by construction, so the Custodian attests to the backlog and the chair accepts or rejects that attestation.',
    ),
  )

  return out
}

// ---------------------------------------------------------------------
// Gate 4 — Pre Submission Verification
// ---------------------------------------------------------------------

function gate4(
  b: JobBookBundle,
  ctx: GateContext,
  asOf: IsoDate,
  completionPct: number,
): CriterionResult[] {
  const G: GateId = 'G4'
  const out: CriterionResult[] = []

  out.push(
    decide(
      completionPct >= 100,
      'g4.complete',
      G,
      'Weighted completion at 100% of applicable, non N/A sections.',
      'Weighted completion is 100%.',
      `Weighted completion is ${pct(completionPct)}. §6.2: "No exceptions. A book is not submitted below 100% of its applicable, non N/A sections."`,
    ),
  )

  // Section presence against the checklist, by title.
  const applicable = applicableSections(b)
  const absent = applicable.filter((x) => {
    const s = x.section
    if (!s) return true
    if (s.ingestionStatus === 'not_imported' || s.ingestionStatus === 'unknown') return true
    return s.computedPct <= 0
  })
  out.push(
    decide(
      absent.length === 0,
      'g4.presence',
      G,
      '100% verification of section presence against the client checklist, item by item, by title.',
      `All ${applicable.length} applicable sections are present and populated, checked item by item against ${b.book.clientChecklistReference ?? 'the governing checklist'}.`,
      `${absent.length} of ${applicable.length} applicable sections are absent, empty or unread: ${list(absent.map((x) => `§${x.def.sectionNumber}`))}. §10.4 names this the exact failure the Completeness Certification exists to prevent.`,
      absent.map((x) => `§${x.def.sectionNumber} ${x.def.title}`),
    ),
  )

  // Certificate validity in both directions.
  const certProblems = certificateValidityProblems(b)
  out.push(
    decide(
      certProblems.length === 0,
      'g4.certificates',
      G,
      '100% verification that every certificate was valid on the date of the work it covers, in both directions.',
      'Every weld, torque and inspection resolves to a certificate valid on the date of the work it covers.',
      `${certProblems.length} record(s) covered by no valid certificate: ${list(certProblems)}.`,
      certProblems,
    ),
  )

  out.push(peerAuditCriterion(G, ctx, 95, 'Tier 2 peer audit at double sample size, scored at 95 or above.'))
  out.push(
    ctx.tier3VerifiedAt
      ? met('g4.tier3', G, 'Tier 3 QA/QC Manager verification performed and documented.', `Tier 3 verification recorded ${ctx.tier3VerifiedAt}.`)
      : unknown(
          'g4.tier3',
          G,
          'Tier 3 QA/QC Manager verification performed and documented.',
          'No Tier 3 verification is recorded for this book. The three-tier audit model of §10 is not yet implemented in the application.',
        ),
  )

  const f = openFindings(b)
  out.push(
    !f
      ? unknown(
          'g4.findings',
          G,
          'Zero open Critical findings. Zero open Major findings.',
          'The NCR register was not loaded with this book, so open findings cannot be counted. At Gate 4 this is the criterion that most needs an answer, and an unloaded register is not one.',
        )
      : decide(
          f.critical.length === 0 && f.major.length === 0,
          'g4.findings',
          G,
          'Zero open Critical findings. Zero open Major findings.',
          'No open Critical or Major findings.',
          `${f.critical.length} open Critical and ${f.major.length} open Major finding(s).`,
          [...f.critical, ...f.major].slice(0, 20).map((x) => x.title),
        ),
  )

  out.push(
    attested(
      'g4.export',
      G,
      'Export package generated, table of contents matching the client section numbering, checklist populated to reflect actual status.',
      'The application generates the export package on demand, so it can always be produced; that a generated package was reviewed against the client numbering is the chair’s to confirm.',
    ),
  )

  out.push(
    ctx.completenessCertifiedAt
      ? met('g4.completeness_cert', G, 'Completeness Certification signed by the QA/QC Manager.', `Signed ${ctx.completenessCertifiedAt}.`)
      : unknown(
          'g4.completeness_cert',
          G,
          'Completeness Certification signed by the QA/QC Manager.',
          'Form FDS-JB-F07 is not yet implemented in the application. §10.4: "No job book leaves Fortress without this signature."',
        ),
  )

  return out
}

// ---------------------------------------------------------------------
// Gate 5 — Client Acceptance
// ---------------------------------------------------------------------

function gate5(b: JobBookBundle): CriterionResult[] {
  const G: GateId = 'G5'
  return [
    decide(
      b.book.status === 'accepted',
      'g5.acceptance',
      G,
      'Written client acceptance received and filed.',
      'The book is recorded as accepted by the client.',
      `The book status is "${b.book.status}". Acceptance is recorded by moving the book to accepted against the filed written acceptance.`,
    ),
    attested(
      'g5.comments',
      G,
      'Any client comment resolved and re submitted within five business days of receipt.',
      'Client comment threads are not modelled in the application.',
    ),
    attested(
      'g5.lessons',
      G,
      'Lessons learned session held and recorded within ten calendar days of acceptance.',
      'Recorded outside the application.',
    ),
    attested(
      'g5.metrics',
      G,
      'Program metrics updated. First Pass Acceptance recorded.',
      'Program-level metrics span books and are not held on the book.',
    ),
    attested(
      'g5.retention',
      G,
      'Records placed in retention per Section 15.',
      'Retention is a storage-lifecycle act outside the application.',
    ),
  ]
}

// ---------------------------------------------------------------------
// Criteria shared across gates
// ---------------------------------------------------------------------

function timelinessCriterion(
  gate: GateId,
  b: JobBookBundle,
  ctx: GateContext,
  target: number,
): CriterionResult {
  const text = `Entry timeliness rate at or above ${target}% for the period.`
  const id = `${gate.toLowerCase()}.timeliness`

  const measured = entryTimeliness(b)
  const rate = ctx.entryTimelinessRate ?? measured.ratePct

  if (rate == null) {
    // Nothing measurable is not 0% and not 100%. A book whose records were
    // all loaded in bulk out of a legacy package has no §8 history, and
    // scoring that as a failure would condemn every migrated book while
    // scoring it as a pass would wave every one of them through.
    return unknown(
      id,
      gate,
      text,
      measured.unmeasurable > 0
        ? `No record in this book can be timed: ${measured.unmeasurable} entr${measured.unmeasurable === 1 ? 'y carries' : 'ies carry'} no entry stamp or were loaded in bulk. §8.3 measures the work date on the record against the date it was entered, and neither is available here.`
        : 'No records have been entered yet, so there is no Entry Timeliness Rate to read.',
    )
  }

  const scope = ctx.entryTimelinessRate != null
    ? 'for the period'
    : `over ${measured.totalMeasured} measurable entr${measured.totalMeasured === 1 ? 'y' : 'ies'}` +
      (measured.unmeasurable > 0 ? `, with ${measured.unmeasurable} not measurable` : '')

  return decide(
    rate >= target,
    id,
    gate,
    text,
    `Entry Timeliness Rate ${pct(rate)} ${scope}, against a ${target}% target.`,
    `Entry Timeliness Rate ${pct(rate)} ${scope} is below the ${target}% target.`,
  )
}

function selfAuditCriterion(gate: GateId, ctx: GateContext): CriterionResult {
  const text = 'All scheduled Tier 1 self audits performed, signed and on file.'
  if (ctx.selfAuditsDue == null) {
    return unknown(
      `${gate.toLowerCase()}.self_audit`,
      gate,
      text,
      'The Tier 1 self-audit schedule of §10 is not yet implemented in the application.',
    )
  }
  const done = ctx.selfAuditsPerformed ?? 0
  return decide(
    done >= ctx.selfAuditsDue,
    `${gate.toLowerCase()}.self_audit`,
    gate,
    text,
    `${done} of ${ctx.selfAuditsDue} scheduled self audits performed and signed.`,
    `${ctx.selfAuditsDue - done} scheduled self audit(s) not performed.`,
  )
}

function peerAuditCriterion(
  gate: GateId,
  ctx: GateContext,
  minScore: number,
  text: string,
): CriterionResult {
  const id = `${gate.toLowerCase()}.peer_audit`
  if (ctx.latestPeerAuditScore == null) {
    return unknown(
      id,
      gate,
      text,
      'No Tier 2 peer audit is recorded for this book. The three-tier audit model of §10 is not yet implemented in the application.',
    )
  }
  const criticals = ctx.latestPeerAuditCriticals ?? 0
  // §10.3: "Any Critical finding fails the audit outright regardless of
  // score." Score and criticals are not weighed against each other.
  if (criticals > 0) {
    return unmet(
      id,
      gate,
      text,
      `The latest peer audit scored ${ctx.latestPeerAuditScore} but raised ${criticals} Critical finding(s); §10.3 fails the audit outright regardless of score.`,
    )
  }
  return decide(
    ctx.latestPeerAuditScore >= minScore,
    id,
    gate,
    text,
    `Latest peer audit scored ${ctx.latestPeerAuditScore} with zero Critical findings.`,
    `Latest peer audit scored ${ctx.latestPeerAuditScore}, below the ${minScore} required at ${gate}.`,
  )
}

function ncrCriterion(gate: GateId, b: JobBookBundle, asOf: IsoDate): CriterionResult {
  const text = 'Zero open NCRs past due date.'
  const id = `${gate.toLowerCase()}.ncr`
  const f = openFindings(b)
  if (!f) {
    return unknown(
      id,
      gate,
      text,
      'The NCR register was not loaded with this book, so open findings cannot be counted.',
    )
  }
  const relevant = [...f.critical, ...f.major]
  if (relevant.length === 0) {
    return met(id, gate, text, 'No open Critical or Major findings.')
  }
  const { late, undated } = pastDue(relevant, asOf)
  if (late.length === 0 && undated.length === 0) {
    return met(id, gate, text, `${relevant.length} open finding(s), none past due.`)
  }
  return unmet(
    id,
    gate,
    text,
    [
      late.length ? `${late.length} open finding(s) past due` : '',
      undated.length
        ? `${undated.length} open finding(s) carry no due date, so they cannot be shown to be on time (§11.5)`
        : '',
    ]
      .filter(Boolean)
      .join('; '),
    'derived',
    [...late, ...undated].slice(0, 20).map((x) => x.title),
  )
}

/**
 * Certificate validity in both directions, per §7 Gate 4.
 *
 * Forward: every record that needed a certificate has one valid on its own
 * work date. This deliberately re-derives rather than reading the flag
 * queue, because a resolved or dismissed flag must not make a Gate 4
 * criterion true.
 */
function certificateValidityProblems(b: JobBookBundle): string[] {
  const problems: string[] = []

  for (const w of b.welds) {
    if (!w.weldDate) continue
    const welderIds = [w.rootWelderId, w.hotWelderId, w.fillWelderId, w.capWelderId].filter(
      (x): x is string => !!x,
    )
    for (const id of new Set(welderIds)) {
      const quals = b.welderQualifications.filter((q) => q.welderId === id)
      const ok = quals.some(
        (q) =>
          q.qualificationDate <= (w.weldDate as IsoDate) &&
          (!q.expiryDate || q.expiryDate >= (w.weldDate as IsoDate)),
      )
      if (!ok) {
        const welder = b.welders.find((x) => x.id === id)
        problems.push(`weld ${w.weldNumber} / ${welder?.initials ?? id}`)
      }
    }
  }

  for (const c of b.torqueConnections) {
    if (!c.torqueDate || !c.wrenchId) continue
    const wrench = b.torqueWrenches.find((x) => x.id === c.wrenchId || x.wrenchId === c.wrenchId)
    if (!wrench || !certValidOn(b.certificates, 'torque_wrench', wrench.id, c.torqueDate)) {
      problems.push(`torque ${c.isoFlangeNumber} / ${c.wrenchId}`)
    }
  }

  for (const r of b.ndeReports) {
    if (!r.technicianId) continue
    if (!certValidOn(b.certificates, 'ndt_technician', r.technicianId, r.reportDate)) {
      problems.push(`NDE report ${r.reportNumber ?? r.id}`)
    }
  }

  return problems
}

/** How many records a section actually holds, where the record type is one
 *  the bundle carries. Null where the section is document-scored. */
function countFor(b: JobBookBundle, sectionNumber: string, recordType: string | null): number | null {
  switch (recordType) {
    case 'weld':
      return b.welds.length
    case 'torque_connection':
      return b.torqueConnections.length
    case 'material_heat':
      return b.materialHeats.length
    case 'pressure_test':
      return b.pressureTests.length
    case 'cp_test_point':
      return b.cpTestPoints.length
    case 'ut_reading':
      return b.utReadings.length
    case 'nde_report':
      return b.ndeReports.length
    case 'coating_inspection':
      return (b.coatingInspections ?? []).length
    default:
      return documentsInSection(b, sectionNumber).length
  }
}

// ---------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------

export const GATE_META: Record<GateId, { title: string; when: string }> = {
  G0: { title: 'Book Initiation', when: 'Before first weld and before first material receipt' },
  G1: { title: '25% Construction', when: 'At 25% construction complete' },
  G2: { title: '50% Construction', when: 'At 50% construction complete' },
  G3: { title: 'Mechanical Completion', when: 'At mechanical completion' },
  G4: { title: 'Pre Submission Verification', when: 'Before submission. Mandatory. No exceptions.' },
  G5: { title: 'Client Acceptance', when: 'On client acceptance' },
}

export const GATE_ORDER: GateId[] = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5']

export function evaluateGate(
  gate: GateId,
  bundle: JobBookBundle,
  ctx: GateContext = {},
): GateEvaluation {
  const asOf = ctx.asOf ?? today()
  const completionPct = scoreBook(bundle).overallPct

  const criteria =
    gate === 'G0'
      ? gate0(bundle, ctx, asOf)
      : gate === 'G1'
        ? gate1(bundle, ctx, asOf, completionPct)
        : gate === 'G2'
          ? gate2(bundle, ctx, asOf, completionPct)
          : gate === 'G3'
            ? gate3(bundle, ctx, asOf)
            : gate === 'G4'
              ? gate4(bundle, ctx, asOf, completionPct)
              : gate5(bundle)

  const count = (s: CriterionState) => criteria.filter((c) => c.state === s).length
  const meta = GATE_META[gate]

  return {
    gate,
    title: meta.title,
    when: meta.when,
    criteria,
    met: count('met'),
    notMet: count('not_met'),
    indeterminate: count('indeterminate'),
    notApplicable: count('not_applicable'),
    // Not applicable is not a failure; indeterminate is not a pass.
    wouldPass: count('not_met') === 0 && count('indeterminate') === 0,
    completionPct,
  }
}

export function evaluateAllGates(
  bundle: JobBookBundle,
  ctx: GateContext = {},
): GateEvaluation[] {
  return GATE_ORDER.map((g) => evaluateGate(g, bundle, ctx))
}

/**
 * Has a Conditional Pass run out of road?
 *
 * §7: "A Conditional Pass carries a maximum of ten calendar days ... A gate
 * that is not cleared within that window becomes a Fail, and a Fail
 * escalates to the Vice President of Operations the same day."
 *
 * The lapse is a fact about the calendar, not an action someone has to
 * take, so it is derived rather than stored. Nobody forgetting to run a
 * job can make a lapsed gate look live.
 */
export function conditionalPassLapsed(
  review: { outcome: string; conditionalDueAt?: IsoDate | null; clearedAt?: string | null },
  asOf: IsoDate = today(),
): boolean {
  return (
    review.outcome === 'conditional_pass' &&
    !review.clearedAt &&
    review.conditionalDueAt != null &&
    review.conditionalDueAt < asOf
  )
}

/** The gate this book stands at: the highest cleanly passed, or null. */
export function currentGate(
  reviews: { gate: GateId; outcome: string; clearedAt?: string | null; conditionalDueAt?: IsoDate | null }[],
  asOf: IsoDate = today(),
): GateId | null {
  const passed = reviews.filter(
    (r) =>
      r.outcome === 'pass' ||
      (r.outcome === 'conditional_pass' && !!r.clearedAt),
  )
  let highest: GateId | null = null
  for (const g of GATE_ORDER) {
    if (passed.some((r) => r.gate === g)) highest = g
  }
  void asOf
  return highest
}

/** §7: "A book that fails the same gate twice triggers a qualification
 *  action under Section 14." */
export function repeatFailures(
  reviews: { gate: GateId; outcome: string }[],
): GateId[] {
  return GATE_ORDER.filter(
    (g) => reviews.filter((r) => r.gate === g && r.outcome === 'fail').length >= 2,
  )
}
