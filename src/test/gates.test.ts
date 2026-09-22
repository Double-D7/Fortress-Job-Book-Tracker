/**
 * Gate reviews — FDS-JBMP-001 §7.
 *
 * The thing these tests are really protecting is a single sentence from
 * the program's own root-cause table: the baseline review found books
 * where "there was no verification step between assembly and submission".
 * A gate engine that answers "met" when it has not actually checked
 * anything reproduces that failure with a green tick on top, which is
 * worse than having no gates at all.
 *
 * So most of what follows is about the difference between *no* and
 * *I don't know*.
 */
import { describe, expect, it } from 'vitest'
import {
  conditionalPassLapsed,
  currentGate,
  evaluateAllGates,
  evaluateGate,
  plannedMinimumFor,
  repeatFailures,
  DEFAULT_PLANNED_CURVE,
} from '@/lib/domain/gates'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import { buildGreeleyBundle } from '@/lib/data/seed/greeley'
import type { GateId, JobBookBundle } from '@/lib/domain/types'

const AS_OF = '2026-09-01'

const BOOKS: [string, () => JobBookBundle][] = [
  ['DP452', buildDp452Bundle],
  ['DP-318', buildGreeleyBundle],
]

describe('an unanswered criterion is never a passed one', () => {
  for (const [name, build] of BOOKS) {
    it(`${name}: no criterion is "met" without a detail stating what was found`, () => {
      for (const evaluation of evaluateAllGates(build(), { asOf: AS_OF })) {
        for (const c of evaluation.criteria) {
          expect(c.detail.trim().length, `${c.id} has no detail`).toBeGreaterThan(0)
        }
      }
    })

    it(`${name}: an unloaded NCR register reads indeterminate, not compliant`, () => {
      const bundle = build()
      expect(bundle.complianceFlags).toBeUndefined()
      const g1 = evaluateGate('G1', bundle, { asOf: AS_OF })
      const ncr = g1.criteria.find((c) => c.id === 'g1.ncr')
      expect(ncr?.state).toBe('indeterminate')
      expect(ncr?.detail).toMatch(/not loaded/i)
    })

    it(`${name}: a loaded but empty NCR register does read compliant`, () => {
      const bundle = { ...build(), complianceFlags: [] }
      const ncr = evaluateGate('G1', bundle, { asOf: AS_OF }).criteria.find(
        (c) => c.id === 'g1.ncr',
      )
      expect(ncr?.state).toBe('met')
    })

    it(`${name}: wouldPass is false while anything is unevaluable`, () => {
      for (const e of evaluateAllGates(build(), { asOf: AS_OF })) {
        if (e.indeterminate > 0) expect(e.wouldPass).toBe(false)
      }
    })
  }
})

describe('Gate 0 checks the things the program says it checks', () => {
  it('a book with no Custodian fails, and says so in one sentence', () => {
    const b = buildDp452Bundle()
    const c = evaluateGate('G0', b, { asOf: AS_OF }).criteria.find((x) => x.id === 'g0.custodian')
    expect(c?.state).toBe('not_met')
    expect(c?.detail).toMatch(/No Custodian/i)
  })

  it('a named Custodian with no assessed competency is indeterminate, not qualified', () => {
    const base = buildDp452Bundle()
    const b = { ...base, book: { ...base.book, custodianId: 'u1' } }
    const c = evaluateGate('G0', b, { asOf: AS_OF, custodianName: 'R. Vance' }).criteria.find(
      (x) => x.id === 'g0.custodian',
    )
    expect(c?.state).toBe('indeterminate')
    expect(c?.detail).toMatch(/not assessed is not the same as qualified/i)
  })

  it('JB-1 is explicitly refused; JB-2 and above pass', () => {
    const base = buildDp452Bundle()
    const b = { ...base, book: { ...base.book, custodianId: 'u1' } }
    const at = (level: string) =>
      evaluateGate('G0', b, { asOf: AS_OF, custodianCompetency: level }).criteria.find(
        (x) => x.id === 'g0.custodian',
      )?.state
    expect(at('JB-1')).toBe('not_met')
    expect(at('JB-2')).toBe('met')
    expect(at('JB-4')).toBe('met')
  })

  it('governing documents recorded but never confirmed is not good enough', () => {
    const base = buildDp452Bundle()
    const b = {
      ...base,
      book: {
        ...base.book,
        clientChecklistReference: 'Job Book Checklist',
        clientChecklistRevision: 'C',
        pipingSpecReference: 'Noble Energy Piping Specification',
        pipingSpecRevision: '4',
        governingDocsConfirmedAt: null,
      },
    }
    const c = evaluateGate('G0', b, { asOf: AS_OF }).criteria.find(
      (x) => x.id === 'g0.governing_docs',
    )
    expect(c?.state).toBe('not_met')
    expect(c?.detail).toMatch(/never confirmed current with the client/i)
  })

  it('a curve that exists but was never agreed does not satisfy §6.2', () => {
    const base = buildDp452Bundle()
    const b = { ...base, book: { ...base.book, plannedCurve: DEFAULT_PLANNED_CURVE } }
    const c = evaluateGate('G0', b, { asOf: AS_OF }).criteria.find(
      (x) => x.id === 'g0.planned_curve',
    )
    expect(c?.state).toBe('not_met')
    expect(c?.detail).toMatch(/nobody has agreed it/i)
  })
})

describe('the planned completion curve', () => {
  it('carries the program defaults', () => {
    const b = buildDp452Bundle()
    expect(plannedMinimumFor(b, 'G0')).toBe(8)
    expect(plannedMinimumFor(b, 'G1')).toBe(25)
    expect(plannedMinimumFor(b, 'G2')).toBe(50)
    expect(plannedMinimumFor(b, 'G3')).toBe(85)
    expect(plannedMinimumFor(b, 'G4')).toBe(98)
    expect(plannedMinimumFor(b, 'G5')).toBe(100)
  })

  it("a book's own curve overrides the default, so a program revision cannot move the bar under a running job", () => {
    const base = buildDp452Bundle()
    const b = {
      ...base,
      book: {
        ...base.book,
        plannedCurve: [{ milestone: 'construction_25' as const, minimumPct: 40 }],
      },
    }
    expect(plannedMinimumFor(b, 'G1')).toBe(40)
  })
})

describe('Gate 4 is the one that must not be talked past', () => {
  for (const [name, build] of BOOKS) {
    it(`${name}: below 100% weighted completion, Gate 4 fails`, () => {
      const e = evaluateGate('G4', build(), { asOf: AS_OF })
      const complete = e.criteria.find((c) => c.id === 'g4.complete')
      if (e.completionPct < 100) {
        expect(complete?.state).toBe('not_met')
        expect(complete?.detail).toMatch(/No exceptions/)
      } else {
        expect(complete?.state).toBe('met')
      }
      expect(e.wouldPass).toBe(false)
    })

    it(`${name}: the Completeness Certification is reported missing, not assumed`, () => {
      const c = evaluateGate('G4', build(), { asOf: AS_OF }).criteria.find(
        (x) => x.id === 'g4.completeness_cert',
      )
      expect(c?.state).toBe('indeterminate')
      expect(c?.text).toMatch(/Completeness Certification signed by the QA\/QC Manager/)
    })
  }
})

describe('§10.3 — a Critical finding fails a peer audit outright', () => {
  it('a 98-scored audit with one Critical still fails', () => {
    const c = evaluateGate('G2', buildDp452Bundle(), {
      asOf: AS_OF,
      latestPeerAuditScore: 98,
      latestPeerAuditCriticals: 1,
    }).criteria.find((x) => x.id === 'g2.peer_audit')
    expect(c?.state).toBe('not_met')
    expect(c?.detail).toMatch(/regardless of score/)
  })

  it('the same score with no Criticals passes', () => {
    const c = evaluateGate('G2', buildDp452Bundle(), {
      asOf: AS_OF,
      latestPeerAuditScore: 98,
      latestPeerAuditCriticals: 0,
    }).criteria.find((x) => x.id === 'g2.peer_audit')
    expect(c?.state).toBe('met')
  })

  it('G4 demands 95 where G1 and G2 demand 90', () => {
    const at = (gate: GateId) =>
      evaluateGate(gate, buildDp452Bundle(), {
        asOf: AS_OF,
        latestPeerAuditScore: 92,
        latestPeerAuditCriticals: 0,
      }).criteria.find((x) => x.id === `${gate.toLowerCase()}.peer_audit`)?.state
    expect(at('G1')).toBe('met')
    expect(at('G2')).toBe('met')
    expect(at('G4')).toBe('not_met')
  })
})

describe('§11.5 — an NCR with no due date cannot be shown to be on time', () => {
  const withFlags = (flags: unknown[]) => ({
    ...buildDp452Bundle(),
    complianceFlags: flags as JobBookBundle['complianceFlags'],
  })

  it('an undated open Critical fails the criterion rather than passing it by default', () => {
    const c = evaluateGate('G1', withFlags([
      { id: 'f1', jobBookId: 'b', ruleId: 'x', severity: 'critical', title: 'Undated',
        detail: '', fingerprint: 'f1', state: 'open' },
    ]), { asOf: AS_OF }).criteria.find((x) => x.id === 'g1.ncr')
    expect(c?.state).toBe('not_met')
    expect(c?.detail).toMatch(/no due date/i)
  })

  it('a dated, not-yet-due finding is on time', () => {
    const c = evaluateGate('G1', withFlags([
      { id: 'f1', jobBookId: 'b', ruleId: 'x', severity: 'critical', title: 'Dated',
        detail: '', fingerprint: 'f1', state: 'open', dueAt: '2026-12-31' },
    ]), { asOf: AS_OF }).criteria.find((x) => x.id === 'g1.ncr')
    expect(c?.state).toBe('met')
  })

  it('a dated, overdue finding is past due', () => {
    const c = evaluateGate('G1', withFlags([
      { id: 'f1', jobBookId: 'b', ruleId: 'x', severity: 'critical', title: 'Late',
        detail: '', fingerprint: 'f1', state: 'open', dueAt: '2026-01-01' },
    ]), { asOf: AS_OF }).criteria.find((x) => x.id === 'g1.ncr')
    expect(c?.state).toBe('not_met')
    expect(c?.detail).toMatch(/past due/i)
  })

  it('a resolved finding stops counting', () => {
    const c = evaluateGate('G1', withFlags([
      { id: 'f1', jobBookId: 'b', ruleId: 'x', severity: 'critical', title: 'Fixed',
        detail: '', fingerprint: 'f1', state: 'resolved', dueAt: '2026-01-01' },
    ]), { asOf: AS_OF }).criteria.find((x) => x.id === 'g1.ncr')
    expect(c?.state).toBe('met')
  })
})

describe('§7 — the rules that give gates their force', () => {
  it('a Conditional Pass lapses the day after its window closes', () => {
    const r = { outcome: 'conditional_pass', conditionalDueAt: '2026-09-10', clearedAt: null }
    expect(conditionalPassLapsed(r, '2026-09-10')).toBe(false)
    expect(conditionalPassLapsed(r, '2026-09-11')).toBe(true)
  })

  it('a cleared Conditional Pass never lapses', () => {
    expect(
      conditionalPassLapsed(
        { outcome: 'conditional_pass', conditionalDueAt: '2026-09-10', clearedAt: '2026-09-09T00:00:00Z' },
        '2026-12-01',
      ),
    ).toBe(false)
  })

  it('an uncleared Conditional Pass does not advance the book', () => {
    expect(
      currentGate([
        { gate: 'G0', outcome: 'pass' },
        { gate: 'G1', outcome: 'conditional_pass', clearedAt: null },
      ]),
    ).toBe('G0')
  })

  it('a cleared Conditional Pass does advance it', () => {
    expect(
      currentGate([
        { gate: 'G0', outcome: 'pass' },
        { gate: 'G1', outcome: 'conditional_pass', clearedAt: '2026-09-09T00:00:00Z' },
      ]),
    ).toBe('G1')
  })

  it('failing the same gate twice is detectable', () => {
    expect(
      repeatFailures([
        { gate: 'G1', outcome: 'fail' },
        { gate: 'G1', outcome: 'fail' },
        { gate: 'G2', outcome: 'fail' },
      ]),
    ).toEqual(['G1'])
  })
})

describe('Gate 2 re-runs Gate 1 rather than trusting it', () => {
  it('"all Gate 1 criteria, sustained" reports which ones stopped holding', () => {
    const c = evaluateGate('G2', buildDp452Bundle(), { asOf: AS_OF }).criteria.find(
      (x) => x.id === 'g2.gate1_sustained',
    )
    expect(c).toBeDefined()
    expect(c?.state).not.toBe('met')
  })
})

describe('the criterion text is the program’s, not a paraphrase', () => {
  it('Gate 4 quotes §7 verbatim on the mandatory checks', () => {
    const texts = evaluateGate('G4', buildDp452Bundle(), { asOf: AS_OF }).criteria.map((c) => c.text)
    expect(texts).toContain('Weighted completion at 100% of applicable, non N/A sections.')
    expect(texts).toContain(
      '100% verification of section presence against the client checklist, item by item, by title.',
    )
    expect(texts).toContain(
      '100% verification that every certificate was valid on the date of the work it covers, in both directions.',
    )
    expect(texts).toContain('Zero open Critical findings. Zero open Major findings.')
  })

  it('every gate carries its §7 "When:" line', () => {
    const e = evaluateAllGates(buildDp452Bundle(), { asOf: AS_OF })
    expect(e.find((x) => x.gate === 'G4')?.when).toBe(
      'Before submission. Mandatory. No exceptions.',
    )
    expect(e.find((x) => x.gate === 'G0')?.when).toBe(
      'Before first weld and before first material receipt',
    )
  })
})

/**
 * Two defects the first browser run surfaced, both of the same family:
 * a criterion that reports "not met" when the thing it looked for is
 * actually there. A gate engine that cries wolf gets ignored, and an
 * ignored gate is worse than no gate.
 */
describe('the engine looks in the right place', () => {
  it('finds documents by the section row, not the template row', () => {
    const b = buildDp452Bundle()
    // The link is document.sectionId -> job_book_section.id. If the engine
    // compared against sectionDefinition.id instead it would match nothing
    // and report every procedure section empty.
    const anyFiled = b.documents.filter((d) => d.sectionId && !d.deletedAt)
    expect(anyFiled.length).toBeGreaterThan(0)
    const defIds = new Set(b.sectionDefinitions.map((d) => d.id))
    expect(anyFiled.every((d) => !defIds.has(d.sectionId!))).toBe(true)

    const c = evaluateGate('G0', b, { asOf: AS_OF }).criteria.find(
      (x) => x.id === 'g0.procedures_loaded',
    )
    expect(c?.state).toBe('met')
  })

  it('judges "mobilizing" against the work window, not the day of the review', () => {
    const b = buildDp452Bundle()
    // DP452 was built in 2024-25. Asking whether its inspectors are
    // credentialled *today* is the wrong question and answers it wrong.
    expect(b.book.constructionStart).toBeTruthy()
    const c = evaluateGate('G0', b, { asOf: '2030-01-01' }).criteria.find(
      (x) => x.id === 'g0.inspector_creds',
    )
    expect(c?.detail).toContain(b.book.constructionStart!)
    expect(c?.detail).not.toContain('2030-01-01')
  })
})
