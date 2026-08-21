/**
 * Pipe engineering and the inspection tier.
 *
 * Hand-computed expectations throughout: the point of this module is that
 * the arithmetic is reproducible outside a spreadsheet, and a test that
 * derived its expectations the same way the code does would prove nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  computeSmys, DP318_INSPECTION_RULE, EXAMPLE_TIER_RULES, hoopStressPsi,
  INSPECTION_TIER_VOCABULARY, lookupNps, npsKey, NPS_REFERENCE, rollupTiers,
  smysFor, tierRequiresNde, TIER_RULES_CONFIRMED, type TierRule,
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
  it('carries the workbook\'s own 37 rows', () => {
    expect(NPS_REFERENCE).toHaveLength(37)
  })

  it('finds dimensions by the workbook\'s labels', () => {
    expect(lookupNps('3" - SCH 80. XS')).toMatchObject({ odIn: 3.5, wallIn: 0.3 })
    expect(lookupNps('8" - SCH 40,STD')).toMatchObject({ odIn: 8.625, wallIn: 0.322 })
  })

  it('resolves the two sheets\' differing labels to one row', () => {
    // The dimension sheet says `2" - SCH. 40, STD`; the validation list
    // says `2" - SCH.40, STD`. One space, and about 28 welds lose their
    // wall thickness — and with it their hoop stress and % of SMYS.
    expect(npsKey('2" - SCH. 40, STD')).toBe(npsKey('2" - SCH.40, STD'))
    expect(lookupNps('2" - SCH.40, STD')).toMatchObject({ wallIn: 0.154 })
    expect(lookupNps('2"-SCH40STD')).toMatchObject({ wallIn: 0.154 })
  })

  it('preserves the workbook\'s values even where they look odd', () => {
    // 8" XX-STG carries a thinner wall than 8" SCH 160 in this table.
    // Quietly "fixing" a reference the operator holds a copy of would put
    // this application at odds with the document being audited.
    expect(lookupNps('8" - XX-STG.')!.wallIn).toBe(0.875)
    expect(lookupNps('8" - SCH. 160')!.wallIn).toBe(0.906)
  })

  it('returns null rather than a near miss', () => {
    expect(lookupNps('7" - SCH 80. XS')).toBeNull()
    expect(lookupNps('')).toBeNull()
    expect(lookupNps(null)).toBeNull()
  })
})

describe('% of SMYS is computed for every weld, whatever governs it', () => {
  it('derives hoop stress and % SMYS from pipe, grade and pressure', () => {
    // 3" SCH 80 XS, Gr. B, 1,440 psi → 1440 × 3.5 / (2 × 0.300)
    //   = 5040 / 0.600 = 8,400 psi / 35,000 = 24.00%
    const r = computeSmys({ pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 })
    expect(r.hoopStressPsi).toBeCloseTo(8400, 4)
    expect(r.pctSmys).toBeCloseTo(0.24, 4)
  })

  it('assigns no tier when the job supplies no bands', () => {
    // The DP-318 mistake in one assertion: a book with no band set must
    // not acquire an NDE obligation from a vocabulary it never used.
    const r = computeSmys({ pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 })
    expect(r.tier).toBeNull()
    expect(tierRequiresNde(r)).toBe(false)
    expect(r.uncomputableReason).toBeNull()
  })

  it('assigns a tier only when bands are passed in', () => {
    const r = computeSmys(
      { pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 },
      EXAMPLE_TIER_RULES)
    expect(r.tier).toBe('100% Visual and 15% NDT')
    expect(tierRequiresNde(r)).toBe(true)
  })

  it('computes a low-stress weld correctly', () => {
    // 8" SCH 40 STD, Gr. B, 285 psi → 285 × 8.625 / (2 × 0.322)
    //   = 2,458.125 / 0.644 = 3,816.9643 psi / 35,000 = 10.9056%
    const r = computeSmys({ pipeSizeSchedule: '8" - SCH 40,STD', pipeGrade: 'Gr. B', designPressurePsi: 285 })
    expect(r.hoopStressPsi).toBeCloseTo(3816.9643, 3)
    expect(r.pctSmys).toBeCloseTo(0.109056, 5)
  })

  it('reports why it could not compute, rather than returning zero', () => {
    expect(computeSmys({ pipeSizeSchedule: '7" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 })
      .uncomputableReason).toMatch(/No NPS dimension/)
    expect(computeSmys({ pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'X60', designPressurePsi: 1440 })
      .uncomputableReason).toMatch(/Unknown pipe grade/)
    expect(computeSmys({ pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: null })
      .uncomputableReason).toMatch(/No design pressure/)
    expect(computeSmys({ pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: null, designPressurePsi: 1440 })
      .tier).toBeNull()
  })
})

describe('DP-318 is governed by a flat rule, not a tier', () => {
  it('reads 100% visual and 10% NDE, as stated on the log', () => {
    expect(DP318_INSPECTION_RULE.kind).toBe('flat')
    expect(DP318_INSPECTION_RULE.requiredVisualPct).toBe(100)
    expect(DP318_INSPECTION_RULE.requiredNdePct).toBe(10)
    expect(DP318_INSPECTION_RULE.statedAs).toMatch(/100% visual & 10% NDE/)
  })

  it('seeds the tier vocabulary without putting it in force', () => {
    // The three tiers exist on the Data Validation sheet. No weld log
    // column uses them, and a vocabulary is not an obligation.
    expect(INSPECTION_TIER_VOCABULARY).toHaveLength(3)
    expect(INSPECTION_TIER_VOCABULARY).toContain('Random Visual')
    expect(TIER_RULES_CONFIRMED).toBe(false)
    expect(EXAMPLE_TIER_RULES.every((r) => /Example band only/.test(r.note ?? ''))).toBe(true)
  })

  it('honours a different break point without a code change', () => {
    // A 30% operator spec. Same weld, different obligation.
    const thirty: TierRule[] = [
      { id: 'below-30', minPctSmys: 0, maxPctSmys: 0.30, tier: '100% Visual',
        requiredNdtFraction: 0, requiresFullVisual: true },
      { id: 'at-or-above-30', minPctSmys: 0.30, maxPctSmys: null,
        tier: '100% Visual and 15% NDT', requiredNdtFraction: 0.15, requiresFullVisual: true },
    ]
    const input = { pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 }
    expect(computeSmys(input, EXAMPLE_TIER_RULES).tier).toBe('100% Visual and 15% NDT')
    expect(computeSmys(input, thirty).tier).toBe('100% Visual')
  })

  it('supports a three-band rule set including random visual', () => {
    const three: TierRule[] = [
      { id: 'low', minPctSmys: 0, maxPctSmys: 0.10, tier: 'Random Visual',
        requiredNdtFraction: 0, requiresFullVisual: false },
      ...EXAMPLE_TIER_RULES.map((r: TierRule) =>
        r.id === 'example-below-20-smys' ? { ...r, minPctSmys: 0.10 } : r),
    ]
    const r = computeSmys(
      { pipeSizeSchedule: '8" - SCH 40,STD', pipeGrade: 'Gr. B', designPressurePsi: 200 }, three)
    expect(r.pctSmys).toBeLessThan(0.10)
    expect(r.tier).toBe('Random Visual')
  })

  it('reports a % SMYS no band covers instead of assuming the lowest', () => {
    const gapped: TierRule[] = [
      { id: 'high-only', minPctSmys: 0.50, maxPctSmys: null, tier: '100% Visual and 15% NDT',
        requiredNdtFraction: 0.15, requiresFullVisual: true },
    ]
    const r = computeSmys(
      { pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 }, gapped)
    expect(r.tier).toBeNull()
    expect(r.uncomputableReason).toMatch(/No tier rule covers/)
  })
})

describe('book-level tier rollup', () => {
  const mk = (pipe: string, psi: number, hasNde: boolean) => ({
    smys: computeSmys({ pipeSizeSchedule: pipe, pipeGrade: 'Gr. B', designPressurePsi: psi },
      EXAMPLE_TIER_RULES),
    hasNde,
  })

  it('splits at the threshold and counts the shortfall', () => {
    const welds = [
      mk('3" - SCH 80. XS', 1440, true),   // 24.00% — required, met
      mk('3" - SCH 80. XS', 1440, false),  // 24.00% — required, NOT met
      mk('8" - SCH 40,STD', 285, false),   // 10.90% — not required
      mk('8" - SCH 40,STD', 285, false),   //        — not required
    ]
    const r = rollupTiers(welds, EXAMPLE_TIER_RULES)
    expect(r.atOrAboveThreshold).toBe(2)
    expect(r.belowThreshold).toBe(2)
    expect(r.tierRequired).toBe(2)
    expect(r.tierMet).toBe(1)
    expect(r.tierShortfall).toBe(1)
    expect(r.maxPctSmys).toBeCloseTo(0.24, 4)
  })

  it('counts uncomputable welds separately rather than as compliant', () => {
    const r = rollupTiers([
      mk('3" - SCH 80. XS', 1440, true),
      { smys: computeSmys({ pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: null, designPressurePsi: 1440 }),
        hasNde: false },
    ], EXAMPLE_TIER_RULES)
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
    const welds = [mk('3" - SCH 80. XS', 1440, false)]   // 24%
    expect(rollupTiers(welds, EXAMPLE_TIER_RULES).atOrAboveThreshold).toBe(1)
    expect(rollupTiers(
      welds.map((w) => ({ ...w, smys: computeSmys(
        { pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440 }, thirty) })),
      thirty,
    ).atOrAboveThreshold).toBe(0)
  })
})
