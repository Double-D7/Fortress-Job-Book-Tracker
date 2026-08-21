/**
 * Pipe engineering: hoop stress, % SMYS, and the required inspection tier.
 *
 * A facility weld log does not carry a flat job-wide X-ray percentage the
 * way a flowline log does. It derives each weld's inspection requirement
 * from the pipe itself — how hard the pipe is working relative to what the
 * steel can take. Two welds on the same job can therefore carry different
 * obligations, and the log is only defensible if the derivation is
 * reproducible.
 *
 * Everything here is a pure function of its inputs, so a change to design
 * pressure or grade recomputes the tier for every affected weld rather
 * than leaving a stale number in a cell.
 */

export type PipeGrade = 'Gr. B' | 'X42' | 'X52'

/** Specified Minimum Yield Strength, psi. */
export const SMYS_PSI: Record<PipeGrade, number> = {
  'Gr. B': 35_000,
  X42: 42_000,
  X52: 52_000,
}

export function smysFor(grade: string | null | undefined): number | null {
  if (!grade) return null
  const key = grade.trim()
  if (key in SMYS_PSI) return SMYS_PSI[key as PipeGrade]
  // Tolerate the spellings a field log actually contains.
  const norm = key.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (norm === 'GRB' || norm === 'GRADEB' || norm === 'B') return SMYS_PSI['Gr. B']
  if (norm === 'X42') return SMYS_PSI.X42
  if (norm === 'X52') return SMYS_PSI.X52
  return null
}

export interface NpsDimension {
  /** Key as written in the weld log's pipe size / schedule column. */
  sizeSchedule: string
  nps: string
  schedule: string
  odIn: number
  wallIn: number
}

/**
 * NPS outside diameter and wall thickness.
 *
 * Sourced from ASME B36.10M (welded and seamless wrought steel pipe).
 * The Greeley weld log carries its own 'NPS and Dimensions' sheet with 37
 * rows; `loadNpsTable` replaces these defaults with that sheet on import,
 * and `npsTableSource` records which is in force so a score can say where
 * its dimensions came from.
 */
export const NPS_REFERENCE: NpsDimension[] = [
  { sizeSchedule: '1/2" STD',   nps: '1/2',   schedule: 'STD',   odIn: 0.840,  wallIn: 0.109 },
  { sizeSchedule: '1/2" XS',    nps: '1/2',   schedule: 'XS',    odIn: 0.840,  wallIn: 0.147 },
  { sizeSchedule: '3/4" STD',   nps: '3/4',   schedule: 'STD',   odIn: 1.050,  wallIn: 0.113 },
  { sizeSchedule: '3/4" XS',    nps: '3/4',   schedule: 'XS',    odIn: 1.050,  wallIn: 0.154 },
  { sizeSchedule: '3/4" S160',  nps: '3/4',   schedule: '160',   odIn: 1.050,  wallIn: 0.219 },
  { sizeSchedule: '1" STD',     nps: '1',     schedule: 'STD',   odIn: 1.315,  wallIn: 0.133 },
  { sizeSchedule: '1" XS',      nps: '1',     schedule: 'XS',    odIn: 1.315,  wallIn: 0.179 },
  { sizeSchedule: '1-1/4" STD', nps: '1-1/4', schedule: 'STD',   odIn: 1.660,  wallIn: 0.140 },
  { sizeSchedule: '1-1/4" XS',  nps: '1-1/4', schedule: 'XS',    odIn: 1.660,  wallIn: 0.191 },
  { sizeSchedule: '1-1/2" STD', nps: '1-1/2', schedule: 'STD',   odIn: 1.900,  wallIn: 0.145 },
  { sizeSchedule: '1-1/2" XS',  nps: '1-1/2', schedule: 'XS',    odIn: 1.900,  wallIn: 0.200 },
  { sizeSchedule: '2" STD',     nps: '2',     schedule: 'STD',   odIn: 2.375,  wallIn: 0.154 },
  { sizeSchedule: '2" XS',      nps: '2',     schedule: 'XS',    odIn: 2.375,  wallIn: 0.218 },
  { sizeSchedule: '2" S160',    nps: '2',     schedule: '160',   odIn: 2.375,  wallIn: 0.344 },
  { sizeSchedule: '2" XXH',     nps: '2',     schedule: 'XXH',   odIn: 2.375,  wallIn: 0.436 },
  { sizeSchedule: '2-1/2" STD', nps: '2-1/2', schedule: 'STD',   odIn: 2.875,  wallIn: 0.203 },
  { sizeSchedule: '2-1/2" XS',  nps: '2-1/2', schedule: 'XS',    odIn: 2.875,  wallIn: 0.276 },
  { sizeSchedule: '3" STD',     nps: '3',     schedule: 'STD',   odIn: 3.500,  wallIn: 0.216 },
  { sizeSchedule: '3" XS',      nps: '3',     schedule: 'XS',    odIn: 3.500,  wallIn: 0.300 },
  { sizeSchedule: '3" S160',    nps: '3',     schedule: '160',   odIn: 3.500,  wallIn: 0.438 },
  { sizeSchedule: '3-1/2" STD', nps: '3-1/2', schedule: 'STD',   odIn: 4.000,  wallIn: 0.226 },
  { sizeSchedule: '4" STD',     nps: '4',     schedule: 'STD',   odIn: 4.500,  wallIn: 0.237 },
  { sizeSchedule: '4" XS',      nps: '4',     schedule: 'XS',    odIn: 4.500,  wallIn: 0.337 },
  { sizeSchedule: '4" S160',    nps: '4',     schedule: '160',   odIn: 4.500,  wallIn: 0.531 },
  { sizeSchedule: '4" XXH',     nps: '4',     schedule: 'XXH',   odIn: 4.500,  wallIn: 0.674 },
  { sizeSchedule: '5" STD',     nps: '5',     schedule: 'STD',   odIn: 5.563,  wallIn: 0.258 },
  { sizeSchedule: '6" STD',     nps: '6',     schedule: 'STD',   odIn: 6.625,  wallIn: 0.280 },
  { sizeSchedule: '6" XS',      nps: '6',     schedule: 'XS',    odIn: 6.625,  wallIn: 0.432 },
  { sizeSchedule: '6" S160',    nps: '6',     schedule: '160',   odIn: 6.625,  wallIn: 0.719 },
  { sizeSchedule: '8" STD',     nps: '8',     schedule: 'STD',   odIn: 8.625,  wallIn: 0.322 },
  { sizeSchedule: '8" XS',      nps: '8',     schedule: 'XS',    odIn: 8.625,  wallIn: 0.500 },
  { sizeSchedule: '10" STD',    nps: '10',    schedule: 'STD',   odIn: 10.750, wallIn: 0.365 },
  { sizeSchedule: '10" XS',     nps: '10',    schedule: 'XS',    odIn: 10.750, wallIn: 0.500 },
  { sizeSchedule: '12" STD',    nps: '12',    schedule: 'STD',   odIn: 12.750, wallIn: 0.375 },
  { sizeSchedule: '12" XS',     nps: '12',    schedule: 'XS',    odIn: 12.750, wallIn: 0.500 },
  { sizeSchedule: '14" STD',    nps: '14',    schedule: 'STD',   odIn: 14.000, wallIn: 0.375 },
  { sizeSchedule: '16" STD',    nps: '16',    schedule: 'STD',   odIn: 16.000, wallIn: 0.375 },
  { sizeSchedule: '16" XS',     nps: '16',    schedule: 'XS',    odIn: 16.000, wallIn: 0.500 },
  { sizeSchedule: '18" STD',    nps: '18',    schedule: 'STD',   odIn: 18.000, wallIn: 0.375 },
  { sizeSchedule: '20" STD',    nps: '20',    schedule: 'STD',   odIn: 20.000, wallIn: 0.375 },
]

/**
 * Normalize a pipe size / schedule label to a lookup key. Field logs write
 * the same pipe as `3" S80`, `3 XS`, `3in XS` and `3" SCH80`, and the
 * dimensions are identical in every case.
 */
export function npsKey(sizeSchedule: string): string {
  let s = sizeSchedule.trim().toUpperCase()
  s = s.replace(/SCH(EDULE)?\s*\.?\s*/g, 'S')
  // `3IN` has no word boundary between the digit and the unit, so an
  // anchored \bIN\b never fires on the form a field log actually writes.
  s = s.replace(/(\d)\s*(?:INCHES|INCH|IN)\b/g, '$1"')
  s = s.replace(/["”]/g, '"').replace(/"+/g, '"')
  s = s.replace(/\s+/g, ' ')
  // Schedule 80 and XS coincide through NPS 8; STD and 40 through NPS 10.
  // Field logs use the names interchangeably and mean the same wall.
  s = s.replace(/\bS?80\b/, 'XS').replace(/\bS?40\b/, 'STD')
  s = s.replace(/\bXH\b/, 'XS').replace(/\bXXS\b/, 'XXH')
  s = s.replace(/\bS?160\b/, 'S160')
  return s.replace(/"/g, '').replace(/\s+/g, ' ').trim()
}

export function lookupNps(
  sizeSchedule: string | null | undefined, table: NpsDimension[] = NPS_REFERENCE,
): NpsDimension | null {
  if (!sizeSchedule) return null
  const key = npsKey(sizeSchedule)
  return table.find((r) => npsKey(r.sizeSchedule) === key) ?? null
}

/**
 * Barlow's formula. Hoop stress in a thin-walled cylinder:
 *
 *     σ = P · D / (2 · t)
 *
 * using outside diameter, which is the conservative convention in pipeline
 * work and what the weld log's own column computes.
 */
export function hoopStressPsi(
  designPressurePsi: number, odIn: number, wallIn: number,
): number | null {
  if (!(wallIn > 0) || !(odIn > 0) || !Number.isFinite(designPressurePsi)) return null
  return (designPressurePsi * odIn) / (2 * wallIn)
}

export type InspectionTier = 'Random Visual' | '100% Visual' | '100% Visual and 15% NDT'

/**
 * A tier rule: the band of % SMYS it covers and what that band requires.
 *
 * These live in a table rather than in an `if` chain because the 20%
 * break point is *inferred* from the workbook, not quoted from a code
 * clause, and still needs QA/QC confirmation. When someone confirms it —
 * or corrects it to 30% for a different operator — that is a row edit and
 * a recomputation, not a code change and a deploy.
 */
export interface TierRule {
  id: string
  /** Inclusive lower bound, as a fraction (0.20 = 20% SMYS). */
  minPctSmys: number
  /** Exclusive upper bound; null means unbounded. */
  maxPctSmys: number | null
  tier: InspectionTier
  /** Fraction of welds in this band requiring NDE. */
  requiredNdtFraction: number
  requiresFullVisual: boolean
  note?: string
}

/**
 * Default rule set, matching the Greeley weld log's behaviour. Marked
 * unconfirmed so the UI can say so next to any number derived from it.
 */
export const DEFAULT_TIER_RULES: TierRule[] = [
  {
    id: 'below-20-smys',
    minPctSmys: 0,
    maxPctSmys: 0.20,
    tier: '100% Visual',
    requiredNdtFraction: 0,
    requiresFullVisual: true,
    note: 'Below 20% SMYS — visual inspection only.',
  },
  {
    id: 'at-or-above-20-smys',
    minPctSmys: 0.20,
    maxPctSmys: null,
    tier: '100% Visual and 15% NDT',
    requiredNdtFraction: 0.15,
    requiresFullVisual: true,
    note: 'At or above 20% SMYS — radiographic or equivalent examination required.',
  },
]

export const TIER_RULES_CONFIRMED = false

export interface SmysResult {
  odIn: number | null
  wallIn: number | null
  hoopStressPsi: number | null
  smysPsi: number | null
  pctSmys: number | null
  tier: InspectionTier | null
  requiredNdtFraction: number | null
  ruleId: string | null
  /** Why the calculation could not be completed, when it could not. */
  uncomputableReason: string | null
}

export interface SmysInput {
  pipeSizeSchedule?: string | null
  pipeGrade?: string | null
  designPressurePsi?: number | null
}

/**
 * Full derivation for one weld. Returns every intermediate value, not just
 * the tier, so the UI can show the arithmetic — an inspector challenged on
 * a tier needs to see the OD, wall and stress that produced it.
 */
export function computeSmys(
  input: SmysInput,
  rules: TierRule[] = DEFAULT_TIER_RULES,
  table: NpsDimension[] = NPS_REFERENCE,
): SmysResult {
  const empty: SmysResult = {
    odIn: null, wallIn: null, hoopStressPsi: null, smysPsi: null, pctSmys: null,
    tier: null, requiredNdtFraction: null, ruleId: null, uncomputableReason: null,
  }

  const dim = lookupNps(input.pipeSizeSchedule, table)
  const smys = smysFor(input.pipeGrade)
  const pressure = input.designPressurePsi

  if (!dim) {
    return { ...empty, smysPsi: smys,
      uncomputableReason: input.pipeSizeSchedule
        ? `No NPS dimension for "${input.pipeSizeSchedule}"`
        : 'No pipe size or schedule recorded' }
  }
  if (smys == null) {
    return { ...empty, odIn: dim.odIn, wallIn: dim.wallIn,
      uncomputableReason: input.pipeGrade
        ? `Unknown pipe grade "${input.pipeGrade}"`
        : 'No pipe grade recorded' }
  }
  if (pressure == null || !Number.isFinite(pressure)) {
    return { ...empty, odIn: dim.odIn, wallIn: dim.wallIn, smysPsi: smys,
      uncomputableReason: 'No design pressure recorded' }
  }

  const hoop = hoopStressPsi(pressure, dim.odIn, dim.wallIn)
  if (hoop == null) {
    return { ...empty, odIn: dim.odIn, wallIn: dim.wallIn, smysPsi: smys,
      uncomputableReason: 'Wall thickness is zero or invalid' }
  }

  const pct = hoop / smys
  const rule = rules.find(
    (r) => pct >= r.minPctSmys && (r.maxPctSmys == null || pct < r.maxPctSmys),
  )

  return {
    odIn: dim.odIn,
    wallIn: dim.wallIn,
    hoopStressPsi: hoop,
    smysPsi: smys,
    pctSmys: pct,
    tier: rule?.tier ?? null,
    requiredNdtFraction: rule?.requiredNdtFraction ?? null,
    ruleId: rule?.id ?? null,
    uncomputableReason: rule ? null : `No tier rule covers ${(pct * 100).toFixed(2)}% SMYS`,
  }
}

/** Does this weld require NDE under its tier? */
export function tierRequiresNde(r: SmysResult): boolean {
  return (r.requiredNdtFraction ?? 0) > 0
}

export interface TierRollup {
  computed: number
  uncomputable: number
  belowThreshold: number
  atOrAboveThreshold: number
  maxPctSmys: number | null
  /** Welds whose tier requires NDE. */
  tierRequired: number
  /** Of those, how many actually received it. */
  tierMet: number
  tierShortfall: number
}

/**
 * Book-level rollup. `thresholdFraction` is read from the rule table's
 * first non-zero NDE band rather than hard-coded, so moving the break
 * point moves this summary with it.
 */
export function rollupTiers(
  welds: { smys: SmysResult; hasNde: boolean }[],
  rules: TierRule[] = DEFAULT_TIER_RULES,
): TierRollup {
  const threshold = rules.find((r) => r.requiredNdtFraction > 0)?.minPctSmys ?? 0.20
  let computed = 0
  let uncomputable = 0
  let below = 0
  let atOrAbove = 0
  let max: number | null = null
  let required = 0
  let met = 0

  for (const w of welds) {
    if (w.smys.pctSmys == null) { uncomputable++; continue }
    computed++
    if (max == null || w.smys.pctSmys > max) max = w.smys.pctSmys
    if (w.smys.pctSmys >= threshold) atOrAbove++
    else below++
    if (tierRequiresNde(w.smys)) {
      required++
      if (w.hasNde) met++
    }
  }

  return {
    computed, uncomputable,
    belowThreshold: below,
    atOrAboveThreshold: atOrAbove,
    maxPctSmys: max,
    tierRequired: required,
    tierMet: met,
    tierShortfall: required - met,
  }
}
