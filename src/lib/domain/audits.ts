/**
 * FDS-JBMP-001 §10 — Three-Tier Verification.
 *
 * Three tiers, doing three different jobs:
 *
 *   Tier 1  The Custodian checks their own book, on a schedule. Counted,
 *           not scored, because a self-assessment's number means only as
 *           much as the person writing it wants it to.
 *   Tier 2  A different Custodian at JB-3 or above samples and scores the
 *           book out of 100. The independence is the control.
 *   Tier 3  The QA/QC Manager verifies at Gate 4. A signature, not a
 *           score.
 *
 * Everything here is deliberately pure: the sample size for a lot, the
 * score for a set of findings, the schedule a book owes. The database
 * stores what was done; this decides what should have been.
 */
import type {
  AuditFinding, AuditTier, FindingClass, IsoDate, JobBookAudit, JobBookBundle,
} from './types'
import { businessDaysBetween } from './timeliness'

// ---------------------------------------------------------------------
// Sampling — ANSI/ASQ Z1.4, General Inspection Level II, single
// sampling, normal inspection.
//
// §10.2 samples rather than reading everything. Reading 1,256 welds
// twice is not a control; it is a second chance to make the same mistake
// while tired. The published table is used rather than a rule of thumb
// so the number survives the question a client auditor will eventually
// ask, which is "why 32 and not 30".
// ---------------------------------------------------------------------

/** Lot-size ranges to code letter, Level II. Upper bound inclusive. */
const CODE_LETTERS: ReadonlyArray<{ upTo: number; letter: string }> = [
  { upTo: 8, letter: 'A' },
  { upTo: 15, letter: 'B' },
  { upTo: 25, letter: 'C' },
  { upTo: 50, letter: 'D' },
  { upTo: 90, letter: 'E' },
  { upTo: 150, letter: 'F' },
  { upTo: 280, letter: 'G' },
  { upTo: 500, letter: 'H' },
  { upTo: 1200, letter: 'J' },
  { upTo: 3200, letter: 'K' },
  { upTo: 10_000, letter: 'L' },
  { upTo: 35_000, letter: 'M' },
  { upTo: 150_000, letter: 'N' },
  { upTo: 500_000, letter: 'P' },
  { upTo: Number.POSITIVE_INFINITY, letter: 'Q' },
]

const SAMPLE_FOR_LETTER: Readonly<Record<string, number>> = {
  A: 2, B: 3, C: 5, D: 8, E: 13, F: 20, G: 32, H: 50,
  J: 80, K: 125, L: 200, M: 315, N: 500, P: 800, Q: 1250,
}

export interface SamplePlan {
  lotSize: number
  sampleSize: number
  codeLetter: string
  /** The sentence that goes in `sample_plan`, so the basis travels with
   *  the number rather than living in someone's memory. */
  description: string
  doubled: boolean
}

/**
 * The sample to draw from a lot of `lotSize` records.
 *
 * A lot smaller than the table's sample size is read in full — you
 * cannot sample 13 items out of 9, and the standard's answer there is to
 * inspect the lot. A lot of zero needs no sample and gets none.
 *
 * `doubled` is Gate 4's "double sample size", applied after the table
 * and then capped at the lot, for the same reason.
 */
export function samplePlan(lotSize: number, doubled = false): SamplePlan {
  const lot = Math.max(0, Math.floor(lotSize))
  if (lot === 0) {
    return {
      lotSize: 0, sampleSize: 0, codeLetter: '—', doubled,
      description: 'No records in the lot; nothing to sample.',
    }
  }
  const letter = CODE_LETTERS.find((c) => lot <= c.upTo)!.letter
  const fromTable = SAMPLE_FOR_LETTER[letter]!
  const wanted = doubled ? fromTable * 2 : fromTable
  // Cannot draw more than exists. At that point the audit is a full read,
  // which is a stronger result than the plan asked for, not a weaker one.
  const sampleSize = Math.min(wanted, lot)
  const full = sampleSize === lot && lot <= wanted

  return {
    lotSize: lot,
    sampleSize,
    codeLetter: letter,
    doubled,
    description:
      `ANSI/ASQ Z1.4 Level II normal, single sampling, code letter ${letter}` +
      (doubled ? `, doubled for Gate 4` : '') +
      `: ${sampleSize} of ${lot.toLocaleString()}` +
      (full ? ' (lot smaller than the plan, read in full)' : ''),
  }
}

/**
 * The lot a peer audit draws from, for a given book.
 *
 * "The book" is not one population — a §12 weld log and a §13 wrench
 * register are different kinds of thing — so the auditable lot is the
 * count of individually checkable records the book holds. Documents
 * count, because a document filed under the wrong section is exactly the
 * sort of defect a peer audit is looking for.
 */
export function auditableLotSize(b: JobBookBundle): number {
  // Soft-deleted rows never reach a bundle — the provider filters them on
  // the way in — so these counts are already of live records. Documents
  // are the exception: a superseded revision is still in the bundle
  // because the audit trail needs it, and auditing a revision somebody
  // has already replaced would be checking history, not the book.
  const documents = (b.documents ?? []).filter(
    (d) => !d.deletedAt && !d.isSuperseded,
  ).length
  return (
    (b.welds?.length ?? 0) +
    (b.torqueConnections?.length ?? 0) +
    documents +
    (b.pressureTests?.length ?? 0) +
    (b.ndeReports?.length ?? 0) +
    (b.materialHeats?.length ?? 0) +
    (b.certificates?.length ?? 0)
  )
}

// ---------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------

/**
 * Deductions per finding, §11's three classes.
 *
 * A Critical's deduction is almost beside the point — §10.3 fails the
 * audit outright on any Critical regardless of score — but it is carried
 * so a report showing the arithmetic does not have to explain why one
 * finding cost nothing.
 */
export const DEDUCTION: Readonly<Record<FindingClass, number>> = {
  critical: 25,
  major: 10,
  minor: 2,
}

/** §7: a peer audit must reach 90 at Gates 1–3, and 95 at Gate 4. */
export const PEER_AUDIT_PASS = 90
export const PEER_AUDIT_PASS_G4 = 95

export interface AuditScore {
  score: number
  criticals: number
  majors: number
  minors: number
  /** False whenever a Critical was raised, whatever the score. */
  passes: boolean
  /** Why, in a sentence, for the audit report. */
  explanation: string
}

/**
 * Score an audit out of 100 from its findings.
 *
 * Two results, not one, and the caller must read both. §10.3: "Any
 * Critical finding fails the audit outright regardless of score." A 98
 * with one Critical is a fail; a 91 with none is a pass. Collapsing that
 * into a single number would make the two indistinguishable at exactly
 * the moment the difference matters.
 */
export function scoreAudit(
  findings: readonly Pick<AuditFinding, 'classification'>[],
  minScore: number = PEER_AUDIT_PASS,
): AuditScore {
  const count = (c: FindingClass) =>
    findings.filter((f) => f.classification === c).length
  const criticals = count('critical')
  const majors = count('major')
  const minors = count('minor')

  const deducted =
    criticals * DEDUCTION.critical +
    majors * DEDUCTION.major +
    minors * DEDUCTION.minor
  // Floored at zero. A negative score is not more informative than a
  // zero, and it renders badly next to a threshold.
  const score = Math.max(0, 100 - deducted)

  const parts = [
    criticals ? `${criticals} Critical` : '',
    majors ? `${majors} Major` : '',
    minors ? `${minors} Minor` : '',
  ].filter(Boolean)
  const raised = parts.length ? parts.join(', ') : 'no findings'

  if (criticals > 0) {
    return {
      score, criticals, majors, minors, passes: false,
      explanation:
        `Scored ${score} with ${raised}. §10.3 fails the audit outright on ` +
        `any Critical finding regardless of score.`,
    }
  }
  return {
    score, criticals, majors, minors,
    passes: score >= minScore,
    explanation:
      `Scored ${score} with ${raised}, against a pass mark of ${minScore}.`,
  }
}

// ---------------------------------------------------------------------
// The Tier 1 schedule
// ---------------------------------------------------------------------

/**
 * §10.1 puts a self audit on the Custodian every ten working days.
 *
 * Working days rather than calendar, and the book's own work week,
 * because a six-day crew and a five-day crew do not accrue obligations
 * at the same rate — the same reason §8 measures entry timeliness that
 * way.
 */
export const SELF_AUDIT_INTERVAL_WORKING_DAYS = 10

/**
 * How many Tier 1 audits a book owes by `asOf`.
 *
 * Counted from the start of construction, because a book with no work in
 * it has nothing to audit. Returns null where the start date is unknown:
 * a schedule derived from a date nobody set is a number with no meaning,
 * and the gate criterion reports indeterminate rather than inventing one.
 */
export function selfAuditsDue(
  b: JobBookBundle,
  asOf: IsoDate,
): number | null {
  const start = b.book.constructionStart
  if (!start) return null
  if (asOf < start) return 0
  const worked = businessDaysBetween(start, asOf, b.book.workWeek ?? 'mon_fri')
  return Math.floor(worked / SELF_AUDIT_INTERVAL_WORKING_DAYS)
}

// ---------------------------------------------------------------------
// Reading the audit history
// ---------------------------------------------------------------------

const completed = (a: JobBookAudit) =>
  a.outcome !== 'in_progress' && !!a.completedAt

/** Most recently completed audit of a tier, or null. */
export function latestOfTier(
  audits: readonly JobBookAudit[],
  tier: AuditTier,
): JobBookAudit | null {
  const done = audits.filter((a) => a.tier === tier && completed(a))
  if (!done.length) return null
  return done.reduce((best, a) =>
    (a.completedAt ?? '') > (best.completedAt ?? '') ? a : best)
}

export interface AuditSummary {
  selfAuditsPerformed: number
  peerAuditsPerformed: number
  latestPeerAuditScore: number | null
  latestPeerAuditCriticals: number | null
  latestPeerAuditDoubled: boolean
  tier3VerifiedAt: string | null
}

/**
 * Flatten the audit history into the facts the gate engine asks for.
 *
 * `latestPeerAuditCriticals` is counted from the findings recorded
 * against that audit, not from the book's current flags. An audit's
 * verdict is a statement about a day, and it does not improve because
 * somebody fixed the record afterwards — that is what the re-audit
 * attempt is for.
 */
export function summarizeAudits(
  audits: readonly JobBookAudit[],
  findings: readonly AuditFinding[],
): AuditSummary {
  const peer = latestOfTier(audits, 'tier_2_peer')
  const tier3 = latestOfTier(audits, 'tier_3_manager')
  return {
    selfAuditsPerformed:
      audits.filter((a) => a.tier === 'tier_1_self' && completed(a)).length,
    peerAuditsPerformed:
      audits.filter((a) => a.tier === 'tier_2_peer' && completed(a)).length,
    latestPeerAuditScore: peer?.score ?? null,
    latestPeerAuditCriticals: peer
      ? findings.filter(
          (f) => f.auditId === peer.id && f.classification === 'critical',
        ).length
      : null,
    latestPeerAuditDoubled: peer?.doubleSample ?? false,
    tier3VerifiedAt: tier3?.completedAt ?? null,
  }
}

/**
 * Whether a person may perform a Tier 2 peer audit on this book.
 *
 * Two independent conditions, reported separately, because "you are not
 * senior enough" and "you cannot audit your own book" call for different
 * responses from whoever reads the message.
 */
export function canPeerAudit(
  b: JobBookBundle,
  auditorId: string,
  competency: string | null | undefined,
): { ok: boolean; reason?: string } {
  if (b.book.custodianId && b.book.custodianId === auditorId) {
    return {
      ok: false,
      reason:
        'A Tier 2 peer audit cannot be performed by the book\'s own Custodian. ' +
        '§10.2 puts a second pair of eyes on the work, and this would be the first pair again.',
    }
  }
  // Null is "not assessed", which is not "qualified". Treating an absent
  // assessment as a pass is how an unqualified audit gets a number that
  // the gate engine then believes.
  if (competency !== 'JB-3' && competency !== 'JB-4') {
    return {
      ok: false,
      reason:
        `A Tier 2 peer audit requires competency JB-3 or above; this auditor is ` +
        `${competency ?? 'not assessed'}.`,
    }
  }
  return { ok: true }
}
