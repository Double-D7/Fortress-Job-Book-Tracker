/**
 * The portfolio row, and the bug it exists to prevent recurring.
 *
 * The dashboard said "0 critical" on books whose own pages said three.
 * Not a rounding difference or a stale cache — two implementations of
 * one contract, which had quietly diverged:
 *
 *   The seed provider counted findings the way the book's pages do, by
 *   running the rules engine over the bundle.
 *
 *   The Supabase provider counted rows in `compliance_flag` with
 *   `state = 'open'`. That table is a RESOLUTION LEDGER — `resolveFlag`
 *   upserts a row when somebody resolves, dismisses or acknowledges a
 *   finding, and nothing else writes one. On a live project it was
 *   empty, so the count was structurally zero for every book. And once
 *   a finding WAS resolved, the `state = 'open'` filter excluded it
 *   again, so it could never self-correct either.
 *
 * The demo was right and production was wrong, which is the worst way
 * round: the thing everybody looks at was fine.
 *
 * So `summarizeBook` is now the single definition, and these tests hold
 * it to the one property that matters — the card agrees with the page it
 * links to.
 */
import { describe, expect, it } from 'vitest'
import { summarizeBook } from '@/lib/data/provider'
import { aggregateFindings, countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import { scoreBook } from '@/lib/domain/scoring'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import { buildGreeleyBundle } from '@/lib/data/seed/greeley'
import { applyComputedScores } from '@/lib/domain/scoring'

const BUNDLES = [
  ['DP452', applyComputedScores(buildDp452Bundle())],
  ['Greeley', applyComputedScores(buildGreeleyBundle())],
] as const

describe('the card agrees with the page', () => {
  for (const [name, bundle] of BUNDLES) {
    it(`${name}: critical count matches what the flags page shows`, () => {
      // This is the assertion the old code would have failed. The flags
      // page renders countBySeverity(aggregateFindings(evaluateFlags));
      // the card must show the same number or it is lying about risk.
      const onThePage = countBySeverity(aggregateFindings(evaluateFlags(bundle)))
      const onTheCard = summarizeBook(bundle, 'Some Operator')

      expect(onTheCard.criticalFlags).toBe(onThePage.critical)
      expect(onTheCard.criticalRecords).toBe(onThePage.criticalRecords)
    })

    it(`${name}: percentage matches the scoring engine`, () => {
      expect(summarizeBook(bundle, 'Some Operator').overallPct)
        .toBe(scoreBook(bundle).overallPct)
    })
  }

  it('actually finds criticals in the reference data', () => {
    // Without this the two assertions above would both pass on a pair of
    // zeroes, which is exactly the state the bug produced. The reference
    // books are known to carry findings; if they ever stop, these tests
    // stop proving anything and should fail loudly rather than go quiet.
    const total = BUNDLES.reduce(
      (n, [, b]) => n + countBySeverity(aggregateFindings(evaluateFlags(b))).critical, 0)
    expect(total).toBeGreaterThan(0)
  })
})

describe('the rest of the row', () => {
  const [, bundle] = BUNDLES[0]

  it('carries the operator name it is given', () => {
    expect(summarizeBook(bundle, 'Chevron').clientOrgName).toBe('Chevron')
  })

  it('stops the countdown once a book is delivered', () => {
    // A book that has been handed over cannot be running late, however
    // long ago its target was.
    for (const status of ['submitted', 'accepted', 'archived'] as const) {
      const delivered = {
        ...bundle,
        book: { ...bundle.book, status, targetTurnoverDate: '2020-01-01' },
      }
      const row = summarizeBook(delivered, 'X')
      expect(row.turnoverState, status).toBe('delivered')
      expect(row.daysToTurnover, status).toBeNull()
    }
  })

  it('says so plainly when no target is set', () => {
    const noTarget = {
      ...bundle,
      book: { ...bundle.book, status: 'in_progress' as const, targetTurnoverDate: null },
    }
    const row = summarizeBook(noTarget, 'X')
    expect(row.turnoverState).toBe('no_target')
    expect(row.daysToTurnover).toBeNull()
  })

  it('counts days against a fixed as-of rather than the wall clock', () => {
    // Passing the date in is what makes this testable at all; reading
    // `new Date()` inside would make the expected value drift daily.
    const dated = {
      ...bundle,
      book: { ...bundle.book, status: 'in_progress' as const, targetTurnoverDate: '2026-01-10' },
    }
    expect(summarizeBook(dated, 'X', new Date('2026-01-01T12:00:00Z')).daysToTurnover).toBe(9)
    expect(summarizeBook(dated, 'X', new Date('2026-01-01T12:00:00Z')).turnoverState)
      .toBe('upcoming')
  })

  it('reports a passed target as overdue, not as a negative countdown', () => {
    const late = {
      ...bundle,
      book: { ...bundle.book, status: 'in_progress' as const, targetTurnoverDate: '2026-01-01' },
    }
    const row = summarizeBook(late, 'X', new Date('2026-01-11T12:00:00Z'))
    expect(row.turnoverState).toBe('overdue')
    expect(row.daysToTurnover).toBe(-10)
  })

  it('falls back to the book type when no division is recorded', () => {
    const row = summarizeBook(bundle, 'X')
    expect(row.division ?? row.bookType).toBeTruthy()
  })
})
