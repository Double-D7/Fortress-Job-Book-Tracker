/**
 * Pipe engineering and the inspection tier.
 *
 * Hand-computed expectations throughout: the point of this module is that
 * the arithmetic is reproducible outside a spreadsheet, and a test that
 * derived its expectations the same way the code does would prove nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  computeSmys, DEFAULT_TIER_RULES, hoopStressPsi, lookupNps, npsKey,
  NPS_REFERENCE, rollupTiers, smysFor, tierRequiresNde, TIER_RULES_CONFIRMED,
  type TierRule,
} from '@/lib/domain/engineering'

describe('Barlow hoop stress', () => {
  it('computes σ = P·D / 2t', () => {
    // 3" XS: OD 3.500", wall 0.300". At 1,440 psi:
    //   1440 × 3.5 / (2 × 0.300) = 5040 / 0.600 = 8,400 psi
    expect(hoopStressPsi(1440, 3.5, 0.3)).toBeCloseTo(8400, 4)
  })

  it('uses outside diameter, the conservative convention', () => {
    // Using ID (3.5 - 2×0.3 = 2.9) would give 6,960 psi — 17% lower, and
    // would under-state every tier in the book.
    expect(hoopStressPsi(1440, 3.5, 0.3)).toBeGreaterThan(hoopStressPsi(1440, 2.9, 0.3)!)
  })

  it('refuses a zero or negative wall rather than returning Infinity', () => {
    expect(hoopStressPsi(1440, 3.5, 0)).toBeNull()
    expect(hoopStressPsi(1440, 0, 0.3)).toBeNull()
  })
})

describe('SMYS by grade', () => {
  it.each([['Gr. B', 35_000], ['X42', 42_000], ['X52', 52_000]] as const)(
    '%s is %i psi', (grade, psi) => expect(smysFor(grade)).toBe(psi),
  )

  it('tolerates the spellings a field log actually contains', () => {
    for (const v of ['Gr. B', 'GR B', 'Grade B', 'gr.b', 'B']) expect(smysFor(v)).toBe(35_000)
    expect(smysFor('x52')).toBe(52_000)
  })

  it('returns null for an unknown grade rather than guessing', () => {
    expect(smysFor('X60')).toBeNull()
    expect(smysFor('')).toBeNull()
    expect(smysFor(null)).toBeNull()
  })
})

describe('NPS lookup', () => {
  it('finds standard dimensions', () => {
    expect(lookupNps('3" XS')).toMatchObject({ odIn: 3.5, wallIn: 0.3 })
    expect(lookupNps('8" STD')).toMatchObject({ odIn: 8.625, wallIn: 0.322 })
  })

  it('treats the interchangeable schedule names as the same wall', () => {
    // Schedule 80 and XS coincide through NPS 8; STD and 40 through NPS 10.
    // A log writes them interchangeably and means the same pipe.
    for (const v of ['3" XS', '3" S80', '3 SCH80', '3" SCH 80', '3in XH', '3" XH']) {
      expect(lookupNps(v), `${v} should resolve`).toMatchObject({ wallIn: 0.3 })
    }
    for (const v of ['4" STD', '4" S40', '4 SCH40']) {
      expect(lookupNps(v), `${v} should resolve`).toMatchObject({ wallIn: 0.237 })
    }
  })

  it('normalizes to a stable key', () => {
    expect(npsKey('3" S80')).toBe(npsKey('3 XS'))
    expect(npsKey('  6"  SCH 160 ')).toBe(npsKey('6" S160'))
  })

  it('returns null rather than a near miss', () => {
    expect(lookupNps('7" XS')).toBeNull()
    expect(lookupNps('')).toBeNull()
    expect(lookupNps(null)).toBeNull()
  })

  it('carries enough of the table to cover a facility book', () => {
    expect(NPS_REFERENCE.length).toBeGreaterThanOrEqual(37)
  })
})

describe('the tier calculation end to end', () => {
  it('derives % SMYS from pipe, grade and pressure', () => {
    // 3" XS, Gr. B, 1,440 psi → 8,400 psi hoop / 35,000 = 24.00%
    const r = computeSmys({ pipeSizeSchedule: '3" XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 })
    expect(r.hoopStressPsi).toBeCloseTo(8400, 4)
    expect(r.pctSmys).toBeCloseTo(0.24, 4)
    expect(r.tier).toBe('100% Visual and 15% NDT')
    expect(tierRequiresNde(r)).toBe(true)
  })

  it('puts a low-stress weld in the visual-only tier', () => {
    // 8" STD, Gr. B, 285 psi → 285 × 8.625 / (2 × 0.322)
    //   = 2,458.125 / 0.644 = 3,816.9643 psi / 35,000 = 10.9056%
    const r = computeSmys({ pipeSizeSchedule: '8" STD', pipeGrade: 'Gr. B', designPressurePsi: 285 })
    expect(r.hoopStressPsi).toBeCloseTo(3816.9643, 3)
    expect(r.pctSmys).toBeCloseTo(0.109056, 5)
    expect(r.tier).toBe('100% Visual')
    expect(tierRequiresNde(r)).toBe(false)
  })

  it('breaks exactly at 20% SMYS, inclusive of the boundary', () => {
    // Contrive a pipe at precisely 20%: hoop must be 7,000 psi on Gr. B.
    // 2" XS: OD 2.375, wall 0.218 → P = 7000 × 2 × 0.218 / 2.375 = 1,284.63
    const at = computeSmys({ pipeSizeSchedule: '2" XS', pipeGrade: 'Gr. B',
      designPressurePsi: (7000 * 2 * 0.218) / 2.375 })
    expect(at.pctSmys).toBeCloseTo(0.2, 6)
    expect(at.tier).toBe('100% Visual and 15% NDT')

    const below = computeSmys({ pipeSizeSchedule: '2" XS', pipeGrade: 'Gr. B',
      designPressurePsi: (6999 * 2 * 0.218) / 2.375 })
    expect(below.tier).toBe('100% Visual')
  })

  it('reports why it could not compute, rather than returning zero', () => {
    expect(computeSmys({ pipeSizeSchedule: '7" XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 })
      .uncomputableReason).toMatch(/No NPS dimension/)
    expect(computeSmys({ pipeSizeSchedule: '3" XS', pipeGrade: 'X60', designPressurePsi: 1440 })
      .uncomputableReason).toMatch(/Unknown pipe grade/)
    expect(computeSmys({ pipeSizeSchedule: '3" XS', pipeGrade: 'Gr. B', designPressurePsi: null })
      .uncomputableReason).toMatch(/No design pressure/)
    // A weld that cannot be computed has no tier, so it cannot silently
    // fall into the visual-only band.
    expect(computeSmys({ pipeSizeSchedule: '3" XS', pipeGrade: null, designPressurePsi: 1440 })
      .tier).toBeNull()
  })
})

describe('the tier thresholds are configuration, not code', () => {
  it('is marked unconfirmed until QA/QC sign off on the break point', () => {
    expect(TIER_RULES_CONFIRMED).toBe(false)
  })

  it('honours a different break point without a code change', () => {
    // A 30% operator spec. Same weld, different obligation.
    const thirty: TierRule[] = [
      { id: 'below-30', minPctSmys: 0, maxPctSmys: 0.30, tier: '100% Visual',
        requiredNdtFraction: 0, requiresFullVisual: true },
      { id: 'at-or-above-30', minPctSmys: 0.30, maxPctSmys: null,
        tier: '100% Visual and 15% NDT', requiredNdtFraction: 0.15, requiresFullVisual: true },
    ]
    const input = { pipeSizeSchedule: '3" XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 }
    expect(computeSmys(input).tier).toBe('100% Visual and 15% NDT')          // 24% vs 20%
    expect(computeSmys(input, thirty).tier).toBe('100% Visual')              // 24% vs 30%
  })

  it('supports a three-band rule set including random visual', () => {
    const three: TierRule[] = [
      { id: 'low', minPctSmys: 0, maxPctSmys: 0.10, tier: 'Random Visual',
        requiredNdtFraction: 0, requiresFullVisual: false },
      ...DEFAULT_TIER_RULES.map((r) =>
        r.id === 'below-20-smys' ? { ...r, minPctSmys: 0.10 } : r),
    ]
    const r = computeSmys(
      { pipeSizeSchedule: '8" STD', pipeGrade: 'Gr. B', designPressurePsi: 200 }, three)
    expect(r.pctSmys).toBeLessThan(0.10)
    expect(r.tier).toBe('Random Visual')
  })

  it('reports a % SMYS no band covers instead of assuming the lowest', () => {
    const gapped: TierRule[] = [
      { id: 'high-only', minPctSmys: 0.50, maxPctSmys: null, tier: '100% Visual and 15% NDT',
        requiredNdtFraction: 0.15, requiresFullVisual: true },
    ]
    const r = computeSmys(
      { pipeSizeSchedule: '3" XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 }, gapped)
    expect(r.tier).toBeNull()
    expect(r.uncomputableReason).toMatch(/No tier rule covers/)
  })
})

describe('book-level tier rollup', () => {
  const mk = (pipe: string, psi: number, hasNde: boolean) => ({
    smys: computeSmys({ pipeSizeSchedule: pipe, pipeGrade: 'Gr. B', designPressurePsi: psi }),
    hasNde,
  })

  it('splits at the threshold and counts the shortfall', () => {
    const welds = [
      mk('3" XS', 1440, true),   // 24.00% — required, met
      mk('3" XS', 1440, false),  // 24.00% — required, NOT met
      mk('8" STD', 285, false),  // 10.90% — not required
      mk('8" STD', 285, false),  //         — not required
    ]
    const r = rollupTiers(welds)
    expect(r.atOrAboveThreshold).toBe(2)
    expect(r.belowThreshold).toBe(2)
    expect(r.tierRequired).toBe(2)
    expect(r.tierMet).toBe(1)
    expect(r.tierShortfall).toBe(1)
    expect(r.maxPctSmys).toBeCloseTo(0.24, 4)
  })

  it('counts uncomputable welds separately rather than as compliant', () => {
    const r = rollupTiers([
      mk('3" XS', 1440, true),
      { smys: computeSmys({ pipeSizeSchedule: '3" XS', pipeGrade: null, designPressurePsi: 1440 }),
        hasNde: false },
    ])
    expect(r.computed).toBe(1)
    expect(r.uncomputable).toBe(1)
    expect(r.belowThreshold + r.atOrAboveThreshold).toBe(1)
  })

  it('reads the threshold from the rule table rather than hard-coding 20%', () => {
    const thirty: TierRule[] = [
      { id: 'b', minPctSmys: 0, maxPctSmys: 0.30, tier: '100% Visual',
        requiredNdtFraction: 0, requiresFullVisual: true },
      { id: 'a', minPctSmys: 0.30, maxPctSmys: null, tier: '100% Visual and 15% NDT',
        requiredNdtFraction: 0.15, requiresFullVisual: true },
    ]
    const welds = [mk('3" XS', 1440, false)]   // 24%
    expect(rollupTiers(welds).atOrAboveThreshold).toBe(1)              // 20% table
    expect(rollupTiers(
      welds.map((w) => ({ ...w, smys: computeSmys(
        { pipeSizeSchedule: '3" XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 }, thirty) })),
      thirty,
    ).atOrAboveThreshold).toBe(0)                                      // 30% table
  })
})
