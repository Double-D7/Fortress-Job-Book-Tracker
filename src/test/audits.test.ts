/**
 * FDS-JBMP-001 §10 — Three-Tier Verification.
 *
 * The tests that matter here are the ones about a number's basis. A
 * sample size, an audit score and a self-audit schedule are all figures
 * a client auditor is entitled to challenge, and each of them has to
 * come from somewhere a person can check.
 */
import { describe, expect, it } from 'vitest'
import {
  auditableLotSize, canPeerAudit, DEDUCTION, latestOfTier, PEER_AUDIT_PASS,
  PEER_AUDIT_PASS_G4, samplePlan, scoreAudit, selfAuditsDue, summarizeAudits,
  SELF_AUDIT_INTERVAL_WORKING_DAYS,
} from '@/lib/domain/audits'
import { evaluateGate } from '@/lib/domain/gates'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { AuditFinding, JobBookAudit, JobBookBundle } from '@/lib/domain/types'

const audit = (o: Partial<JobBookAudit> & Pick<JobBookAudit, 'id' | 'tier'>): JobBookAudit => ({
  jobBookId: 'book-dp452',
  attempt: 1,
  outcome: 'pass',
  completedAt: '2026-03-01T12:00:00Z',
  doubleSample: false,
  ...o,
})

const finding = (
  auditId: string,
  classification: AuditFinding['classification'],
  id = `${auditId}-${classification}-${Math.random()}`,
): AuditFinding => ({ id, auditId, classification, summary: 'x' })

describe('§10.2 sampling — ANSI/ASQ Z1.4 Level II', () => {
  it('reproduces the published code letters and sample sizes', () => {
    // Spot-checked against the standard's Level II normal single-sampling
    // table. These are the boundaries, where an off-by-one in the ranges
    // would show up.
    const cases: [number, string, number][] = [
      [2, 'A', 2], [8, 'A', 2],
      [9, 'B', 3], [15, 'B', 3],
      [16, 'C', 5], [25, 'C', 5],
      [26, 'D', 8], [50, 'D', 8],
      [51, 'E', 13], [90, 'E', 13],
      [91, 'F', 20], [150, 'F', 20],
      [151, 'G', 32], [280, 'G', 32],
      [281, 'H', 50], [500, 'H', 50],
      [501, 'J', 80], [1200, 'J', 80],
      [1201, 'K', 125], [3200, 'K', 125],
      [3201, 'L', 200],
    ]
    for (const [lot, letter, size] of cases) {
      const p = samplePlan(lot)
      expect(`${lot}:${p.codeLetter}:${p.sampleSize}`).toBe(`${lot}:${letter}:${size}`)
    }
  })

  it('reads the lot in full when it is smaller than the plan', () => {
    // You cannot draw 13 from 9. The standard inspects the lot, which is a
    // stronger result than the plan asked for, not a weaker one.
    const p = samplePlan(9)
    expect(p.sampleSize).toBe(3)
    const small = samplePlan(2)
    expect(small.sampleSize).toBe(2)
    expect(small.sampleSize).toBeLessThanOrEqual(small.lotSize)
  })

  it('never draws more than the lot holds, at any size', () => {
    for (const lot of [1, 2, 7, 12, 40, 99, 260, 1199, 5000]) {
      for (const doubled of [false, true]) {
        const p = samplePlan(lot, doubled)
        expect(p.sampleSize).toBeLessThanOrEqual(p.lotSize)
      }
    }
  })

  it('doubles for Gate 4, then still caps at the lot', () => {
    expect(samplePlan(200, true).sampleSize).toBe(64) // letter G, 32 → 64
    expect(samplePlan(200, true).description).toMatch(/doubled for Gate 4/)
    // 50 items, letter D → 8, doubled 16, still under the lot.
    expect(samplePlan(50, true).sampleSize).toBe(16)
    // 20 items, letter C → 5, doubled 10, still under the lot.
    expect(samplePlan(20, true).sampleSize).toBe(10)
    // 12 items, letter B → 3, doubled 6, under the lot.
    expect(samplePlan(12, true).sampleSize).toBe(6)
  })

  it('states its own basis, so the number survives being questioned', () => {
    // "Why 32 and not 30" has to have an answer that is not "we picked it".
    const p = samplePlan(200)
    expect(p.description).toMatch(/ANSI\/ASQ Z1\.4/)
    expect(p.description).toMatch(/Level II/)
    expect(p.description).toMatch(/code letter G/)
    expect(p.description).toContain('32 of 200')
  })

  it('asks for no sample from an empty lot', () => {
    const p = samplePlan(0)
    expect(p.sampleSize).toBe(0)
    expect(p.description).toMatch(/nothing to sample/i)
  })

  it('draws the lot from the book\'s own records', () => {
    const b = buildDp452Bundle()
    const lot = auditableLotSize(b)
    expect(lot).toBeGreaterThan(0)
    expect(lot).toBe(
      b.welds.length + b.torqueConnections.length + b.documents.length +
      b.pressureTests.length + b.ndeReports.length + b.materialHeats.length +
      b.certificates.length,
    )
  })

  it('leaves superseded and deleted documents out of the lot', () => {
    // A superseded revision is history, not the book. Auditing a document
    // somebody has already replaced checks the wrong thing, and counting
    // it inflates the lot — which inflates the sample, which makes the
    // audit look more thorough than it was.
    const b = buildDp452Bundle()
    const before = auditableLotSize(b)
    const [first, second, ...rest] = b.documents
    const withHistory: JobBookBundle = {
      ...b,
      documents: [
        { ...first!, isSuperseded: true },
        { ...second!, deletedAt: '2026-02-01T00:00:00Z' },
        ...rest,
      ],
    }
    expect(auditableLotSize(withHistory)).toBe(before - 2)
  })
})

describe('§10.3 scoring — a Critical fails outright', () => {
  it('deducts by class and floors at zero', () => {
    expect(scoreAudit([]).score).toBe(100)
    expect(scoreAudit([finding('a', 'minor')]).score).toBe(100 - DEDUCTION.minor)
    expect(scoreAudit([finding('a', 'major')]).score).toBe(100 - DEDUCTION.major)
    // Five Criticals is −125, which is not more useful than zero.
    const many = Array.from({ length: 5 }, () => finding('a', 'critical'))
    expect(scoreAudit(many).score).toBe(0)
  })

  it('fails a 98 with one Critical and passes a 90 with none', () => {
    // The program's exact words: "Any Critical finding fails the audit
    // outright regardless of score." No single number can carry both
    // facts, which is why `passes` is reported separately.
    const withCritical = scoreAudit([finding('a', 'critical')])
    expect(withCritical.passes).toBe(false)
    expect(withCritical.explanation).toMatch(/§10\.3/)
    expect(withCritical.explanation).toMatch(/regardless of score/)

    const clean = scoreAudit(Array.from({ length: 5 }, () => finding('a', 'minor')))
    expect(clean.score).toBe(90)
    expect(clean.passes).toBe(true)
  })

  it('applies Gate 4\'s higher pass mark', () => {
    const five = Array.from({ length: 5 }, () => finding('a', 'minor'))
    expect(scoreAudit(five, PEER_AUDIT_PASS).passes).toBe(true)
    expect(scoreAudit(five, PEER_AUDIT_PASS_G4).passes).toBe(false)
    expect(PEER_AUDIT_PASS_G4).toBeGreaterThan(PEER_AUDIT_PASS)
  })

  it('names what it found, rather than reporting a bare number', () => {
    const s = scoreAudit([
      finding('a', 'major'), finding('a', 'minor'), finding('a', 'minor'),
    ])
    expect(s.explanation).toContain('1 Major')
    expect(s.explanation).toContain('2 Minor')
    expect(scoreAudit([]).explanation).toContain('no findings')
  })
})

describe('§10.1 the Tier 1 schedule', () => {
  it('counts against working days on the book\'s own work week', () => {
    const b = buildDp452Bundle()
    const six: JobBookBundle = {
      ...b,
      book: { ...b.book, constructionStart: '2026-01-05', workWeek: 'mon_sat' },
    }
    const five: JobBookBundle = {
      ...b,
      book: { ...b.book, constructionStart: '2026-01-05', workWeek: 'mon_fri' },
    }
    // A six-day crew accrues the obligation faster, which is the whole
    // reason §8 and §10 count working days rather than calendar days.
    // Ten weeks in: 50 working days for a five-day crew, 60 for a six-day
    // one, which is five intervals owed against six.
    expect(selfAuditsDue(five, '2026-03-16')).toBe(5)
    expect(selfAuditsDue(six, '2026-03-16')).toBe(6)
  })

  it('owes nothing before construction starts', () => {
    const b = buildDp452Bundle()
    const book: JobBookBundle = {
      ...b, book: { ...b.book, constructionStart: '2026-06-01' },
    }
    expect(selfAuditsDue(book, '2026-05-01')).toBe(0)
  })

  it('reports null rather than a number when the start date is unknown', () => {
    // A schedule derived from a date nobody set is a figure with no
    // meaning, and the gate criterion must say indeterminate instead.
    const b = buildDp452Bundle()
    const book: JobBookBundle = {
      ...b, book: { ...b.book, constructionStart: null },
    }
    expect(selfAuditsDue(book, '2026-05-01')).toBeNull()
  })

  it('owes one audit per interval, not one per day', () => {
    const b = buildDp452Bundle()
    const book: JobBookBundle = {
      ...b,
      book: { ...b.book, constructionStart: '2026-01-05', workWeek: 'all_days' },
    }
    // all_days makes working days and calendar days the same, so the
    // arithmetic is checkable by hand: 20 days in, two intervals owed.
    expect(selfAuditsDue(book, '2026-01-25')).toBe(
      Math.floor(20 / SELF_AUDIT_INTERVAL_WORKING_DAYS),
    )
  })
})

describe('reading the audit history', () => {
  const audits = [
    audit({ id: 'a1', tier: 'tier_1_self', completedAt: '2026-01-10T00:00:00Z' }),
    audit({ id: 'a2', tier: 'tier_1_self', attempt: 2, completedAt: '2026-02-10T00:00:00Z' }),
    audit({ id: 'p1', tier: 'tier_2_peer', score: 82, outcome: 'fail', completedAt: '2026-01-15T00:00:00Z' }),
    audit({ id: 'p2', tier: 'tier_2_peer', attempt: 2, score: 94, completedAt: '2026-03-15T00:00:00Z' }),
    audit({ id: 'm1', tier: 'tier_3_manager', score: null, completedAt: '2026-04-01T00:00:00Z' }),
  ]
  const findings = [finding('p1', 'critical'), finding('p1', 'major'), finding('p2', 'minor')]

  it('takes the latest completed audit of a tier, not the first', () => {
    expect(latestOfTier(audits, 'tier_2_peer')?.id).toBe('p2')
    expect(latestOfTier(audits, 'tier_1_self')?.id).toBe('a2')
    expect(latestOfTier([], 'tier_2_peer')).toBeNull()
  })

  it('ignores an audit still in progress', () => {
    // A half-done audit is not a pass and not a fail. Letting it be the
    // "latest" would hand the gate engine a null score and read as "no
    // audit recorded", which is much more forgiving than the truth.
    const open = [...audits, audit({
      id: 'p3', tier: 'tier_2_peer', attempt: 3,
      outcome: 'in_progress', completedAt: null, score: null,
    })]
    expect(latestOfTier(open, 'tier_2_peer')?.id).toBe('p2')
    expect(summarizeAudits(open, findings).latestPeerAuditScore).toBe(94)
  })

  it('counts Criticals from the audit that raised them, not from today', () => {
    // An audit's verdict is a statement about a day. It does not improve
    // because somebody fixed the record afterwards — that is what the
    // re-audit attempt is for.
    const s = summarizeAudits(audits, findings)
    expect(s.latestPeerAuditScore).toBe(94)
    expect(s.latestPeerAuditCriticals).toBe(0) // p2 raised only a Minor
    expect(s.peerAuditsPerformed).toBe(2)
    expect(s.selfAuditsPerformed).toBe(2)
    expect(s.tier3VerifiedAt).toBe('2026-04-01T00:00:00Z')
  })

  it('reports nulls, not zeroes, when no peer audit exists', () => {
    // Zero Criticals is a finding. "No audit" is the absence of one, and
    // the gate criterion must not read the second as the first.
    const s = summarizeAudits([], [])
    expect(s.latestPeerAuditScore).toBeNull()
    expect(s.latestPeerAuditCriticals).toBeNull()
  })
})

describe('§10.2 independence', () => {
  const b = buildDp452Bundle()
  const withCustodian: JobBookBundle = {
    ...b, book: { ...b.book, custodianId: 'user-custodian' },
  }

  it('refuses the book\'s own Custodian, at any competency', () => {
    const r = canPeerAudit(withCustodian, 'user-custodian', 'JB-4')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/own Custodian/)
  })

  it('refuses below JB-3, and treats unassessed as unqualified', () => {
    for (const level of ['JB-1', 'JB-2', null, undefined]) {
      expect(canPeerAudit(withCustodian, 'someone-else', level).ok).toBe(false)
    }
    expect(canPeerAudit(withCustodian, 'someone-else', null).reason)
      .toMatch(/not assessed/)
  })

  it('allows an independent JB-3 or JB-4', () => {
    expect(canPeerAudit(withCustodian, 'someone-else', 'JB-3').ok).toBe(true)
    expect(canPeerAudit(withCustodian, 'someone-else', 'JB-4').ok).toBe(true)
  })
})

describe('the gate engine reads the audit history', () => {
  const b = buildDp452Bundle()

  it('still reports indeterminate when the history was not loaded', () => {
    // No `audits` key at all. "Not loaded" is not "none were performed",
    // and §7's whole design is that silence never scores as compliance.
    const g1 = evaluateGate('G1', b, { asOf: '2026-03-01' })
    const peer = g1.criteria.find((c) => c.id === 'g1.peer_audit')!
    expect(peer.state).toBe('indeterminate')
  })

  it('evaluates the criterion once the history is there', () => {
    const loaded: JobBookBundle = {
      ...b,
      audits: [audit({ id: 'p1', tier: 'tier_2_peer', score: 94 })],
      auditFindings: [],
    }
    const peer = evaluateGate('G1', loaded, { asOf: '2026-04-01' })
      .criteria.find((c) => c.id === 'g1.peer_audit')!
    expect(peer.state).toBe('met')
    expect(peer.detail).toContain('94')
  })

  it('fails the criterion on a Critical, whatever the score', () => {
    const loaded: JobBookBundle = {
      ...b,
      audits: [audit({ id: 'p1', tier: 'tier_2_peer', score: 98 })],
      auditFindings: [finding('p1', 'critical')],
    }
    const peer = evaluateGate('G1', loaded, { asOf: '2026-04-01' })
      .criteria.find((c) => c.id === 'g1.peer_audit')!
    expect(peer.state).toBe('not_met')
    expect(peer.detail).toMatch(/§10\.3/)
  })

  it('reads a signed Completeness Certification, and ignores a withdrawn one', () => {
    const cert = {
      jobBookId: b.book.id, certifiedBy: 'user-manager',
      certifiedAt: '2026-05-01T00:00:00Z', completionPct: 100,
      sectionsTotal: 22, sectionsApproved: 22, openCritical: 0, openMajor: 0,
    }
    const signed: JobBookBundle = { ...b, completenessCertification: cert }
    expect(
      evaluateGate('G4', signed, { asOf: '2026-06-01' })
        .criteria.find((c) => c.id === 'g4.completeness_cert')!.state,
    ).toBe('met')

    // §10.4 is a signature that can be taken back. Reading a withdrawn one
    // as current would let a book leave on a signature somebody retracted.
    const revoked: JobBookBundle = {
      ...b,
      completenessCertification: {
        ...cert, revokedAt: '2026-05-20T00:00:00Z',
        revokedBy: 'user-manager', revokedReason: 'Section 17 reopened.',
      },
    }
    expect(
      evaluateGate('G4', revoked, { asOf: '2026-06-01' })
        .criteria.find((c) => c.id === 'g4.completeness_cert')!.state,
    ).toBe('indeterminate')
  })

  it('lets an explicit context value override the derived one', () => {
    // A gate is often read against the period being gated rather than
    // against the book's whole history, and only the caller knows which.
    const loaded: JobBookBundle = {
      ...b,
      audits: [audit({ id: 'p1', tier: 'tier_2_peer', score: 94 })],
      auditFindings: [],
    }
    const peer = evaluateGate('G1', loaded, {
      asOf: '2026-04-01', latestPeerAuditScore: 60,
    }).criteria.find((c) => c.id === 'g1.peer_audit')!
    expect(peer.state).toBe('not_met')
    expect(peer.detail).toContain('60')
  })
})
