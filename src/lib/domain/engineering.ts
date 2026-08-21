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
  idIn?: number
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
  // Transcribed from the DP-318 weld log's 'NPS and Dimensions' sheet,
  // range B4:F40 — the table the workbook's own VLOOKUP reads. Values are
  // taken verbatim, including 8" XX-STG carrying a thinner wall than 8"
  // SCH 160: that is what the book says, and silently "correcting" a
  // reference table would put this application's arithmetic at odds with
  // the document an auditor is holding.
  { sizeSchedule: '1/2" - SCH 80. XS',   nps: '0.5',  schedule: 'SCH 80. XS',   odIn: 0.84,   idIn: 0.546,  wallIn: 0.147 },
  { sizeSchedule: '1/2" - SCH. 160',     nps: '0.5',  schedule: 'SCH. 160',     odIn: 0.84,   idIn: 0.466,  wallIn: 0.187 },
  { sizeSchedule: '1/2" - XX-STG.',      nps: '0.5',  schedule: 'XX-STG.',      odIn: 0.84,   idIn: 0.252,  wallIn: 0.294 },
  { sizeSchedule: '3/4" - SCH 80. XS',   nps: '0.75', schedule: 'SCH 80. XS',   odIn: 1.05,   idIn: 0.742,  wallIn: 0.154 },
  { sizeSchedule: '3/4" - SCH. 160',     nps: '0.75', schedule: 'SCH. 160',     odIn: 1.05,   idIn: 0.614,  wallIn: 0.218 },
  { sizeSchedule: '3/4" - XX-STG.',      nps: '0.75', schedule: 'XX-STG.',      odIn: 1.05,   idIn: 0.434,  wallIn: 0.308 },
  { sizeSchedule: '1" - SCH 80. XS',     nps: '1',    schedule: 'SCH 80. XS',   odIn: 1.315,  idIn: 0.957,  wallIn: 0.179 },
  { sizeSchedule: '1" - SCH. 160',       nps: '1',    schedule: 'SCH. 160',     odIn: 1.315,  idIn: 0.815,  wallIn: 0.25 },
  { sizeSchedule: '1" - XX-STG.',        nps: '1',    schedule: 'XX-STG.',      odIn: 1.315,  idIn: 0.599,  wallIn: 0.358 },
  { sizeSchedule: '1-1/2" - SCH 80. XS', nps: '1.5',  schedule: 'SCH 80. XS',   odIn: 1.9,    idIn: 1.5,    wallIn: 0.2 },
  { sizeSchedule: '1-1/2" - SCH. 160',   nps: '1.5',  schedule: 'SCH. 160',     odIn: 1.9,    idIn: 1.338,  wallIn: 0.281 },
  { sizeSchedule: '1-1/2" - XX-STG.',    nps: '1.5',  schedule: 'XX-STG.',      odIn: 1.9,    idIn: 1.1,    wallIn: 0.4 },
  { sizeSchedule: '2" - SCH. 40, STD',   nps: '2',    schedule: 'SCH. 40, STD', odIn: 2.375,  idIn: 2.067,  wallIn: 0.154 },
  { sizeSchedule: '2" - SCH 80. XS',     nps: '2',    schedule: 'SCH 80. XS',   odIn: 2.375,  idIn: 1.939,  wallIn: 0.218 },
  { sizeSchedule: '2" - SCH. 160',       nps: '2',    schedule: 'SCH. 160',     odIn: 2.375,  idIn: 1.689,  wallIn: 0.343 },
  { sizeSchedule: '2" - XX-STG.',        nps: '2',    schedule: 'XX-STG.',      odIn: 2.375,  idIn: 1.503,  wallIn: 0.436 },
  { sizeSchedule: '3" - SCH 40,STD',     nps: '3',    schedule: 'SCH 40,STD',   odIn: 3.5,    idIn: 3.068,  wallIn: 0.216 },
  { sizeSchedule: '3" - SCH 80. XS',     nps: '3',    schedule: 'SCH 80. XS',   odIn: 3.5,    idIn: 2.9,    wallIn: 0.3 },
  { sizeSchedule: '3" - SCH. 160',       nps: '3',    schedule: 'SCH. 160',     odIn: 3.5,    idIn: 2.624,  wallIn: 0.438 },
  { sizeSchedule: '3" - XX-STG.',        nps: '3',    schedule: 'XX-STG.',      odIn: 3.5,    idIn: 2.3,    wallIn: 0.6 },
  { sizeSchedule: '4" - SCH 40,STD',     nps: '4',    schedule: 'SCH 40,STD',   odIn: 4.5,    idIn: 4.026,  wallIn: 0.237 },
  { sizeSchedule: '4" - SCH 80. XS',     nps: '4',    schedule: 'SCH 80. XS',   odIn: 4.5,    idIn: 3.826,  wallIn: 0.337 },
  { sizeSchedule: '4" - SCH. 160',       nps: '4',    schedule: 'SCH. 160',     odIn: 4.5,    idIn: 3.438,  wallIn: 0.531 },
  { sizeSchedule: '4" - XX-STG.',        nps: '4',    schedule: 'XX-STG.',      odIn: 4.5,    idIn: 3.152,  wallIn: 0.674 },
  { sizeSchedule: '6" - SCH 40,STD',     nps: '6',    schedule: 'SCH 40,STD',   odIn: 6.625,  idIn: 6.065,  wallIn: 0.28 },
  { sizeSchedule: '6" - SCH 80. XS',     nps: '6',    schedule: 'SCH 80. XS',   odIn: 6.625,  idIn: 5.761,  wallIn: 0.432 },
  { sizeSchedule: '6" - SCH. 160',       nps: '6',    schedule: 'SCH. 160',     odIn: 6.625,  idIn: 5.189,  wallIn: 0.718 },
  { sizeSchedule: '6" - XX-STG.',        nps: '6',    schedule: 'XX-STG.',      odIn: 6.625,  idIn: 4.897,  wallIn: 0.864 },
  { sizeSchedule: '8" - SCH 40,STD',     nps: '8',    schedule: 'SCH 40,STD',   odIn: 8.625,  idIn: 7.981,  wallIn: 0.322 },
  { sizeSchedule: '8" - SCH. 60',        nps: '8',    schedule: 'SCH. 60',      odIn: 8.625,  idIn: 7.813,  wallIn: 0.406 },
  { sizeSchedule: '8" - SCH 80. XS',     nps: '8',    schedule: 'SCH 80. XS',   odIn: 8.625,  idIn: 7.625,  wallIn: 0.5 },
  { sizeSchedule: '8" - SCH. 160',       nps: '8',    schedule: 'SCH. 160',     odIn: 8.625,  idIn: 6.813,  wallIn: 0.906 },
  { sizeSchedule: '8" - XX-STG.',        nps: '8',    schedule: 'XX-STG.',      odIn: 8.625,  idIn: 6.875,  wallIn: 0.875 },
  { sizeSchedule: '10" - SCH 40,STD',    nps: '10',   schedule: 'SCH 40,STD',   odIn: 10.75,  idIn: 10.02,  wallIn: 0.365 },
  { sizeSchedule: '10" - SCH 60, XS',    nps: '10',   schedule: 'SCH 60, XS',   odIn: 10.75,  idIn: 9.75,   wallIn: 0.5 },
  { sizeSchedule: '10" - SCH. 80',       nps: '10',   schedule: 'SCH. 80',      odIn: 10.75,  idIn: 9.564,  wallIn: 0.593 },
  { sizeSchedule: '10" - SCH. 160',      nps: '10',   schedule: 'SCH. 160',     odIn: 10.75,  idIn: 8.5,    wallIn: 1.125 },
]

/**
 * Normalize a pipe size / schedule label to a lookup key. Field logs write
 * the same pipe as `3" S80`, `3 XS`, `3in XS` and `3" SCH80`, and the
 * dimensions are identical in every case.
 */
/**
 * Normalize a pipe size / schedule label to a lookup key.
 *
 * The workbook itself is inconsistent: the dimension sheet writes
 * `2" - SCH. 40, STD` while the validation list writes `2" - SCH.40, STD`.
 * Matching on the literal string loses roughly 28 welds to a missing wall
 * thickness, and a weld with no wall thickness has no hoop stress and no
 * % of SMYS — so the difference between one space and none is the
 * difference between an engineering figure and a blank.
 *
 * Everything that is punctuation, spacing or case is therefore discarded,
 * leaving only the digits and letters that carry meaning.
 */
export function npsKey(sizeSchedule: string): string {
  return sizeSchedule
    .trim()
    .toUpperCase()
    // Fractions and inch marks survive as digits and slashes; drop the rest.
    .replace(/[^A-Z0-9/]/g, '')
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
 * The three-tier vocabulary, seeded from the weld log's `Data Validation`
 * sheet (J5:J7). It is a valid vocabulary for jobs specified that way.
 * DP-318 is not one of them — see `InspectionRule` below.
 */
export const INSPECTION_TIER_VOCABULARY: InspectionTier[] = [
  'Random Visual', '100% Visual', '100% Visual and 15% NDT',
]

/**
 * How a job decides what inspection each weld owes.
 *
 * Two shapes exist, and reading the wrong one off a book is how an
 * application invents findings:
 *
 *   flat    — one job-wide requirement, stated on the log's own face.
 *             DP-318's Project Overview cell G7 reads
 *             "Project Totals- Requirement- 100% visual & 10% NDE".
 *   tiered  — a per-weld requirement derived from % of SMYS against a
 *             threshold table.
 *
 * An earlier reading of DP-318 assumed the tiered shape and reported 90
 * welds as failing a 15% NDT obligation they never had. The tier
 * vocabulary does exist in that workbook, but no weld log column uses it;
 * it is a validation list waiting for a job that needs it. The rule a book
 * is governed by is a property of the book, so it is read from the book
 * and never inferred from the presence of a vocabulary.
 */
export type InspectionRuleKind = 'flat' | 'tiered'

export interface FlatInspectionRule {
  kind: 'flat'
  requiredVisualPct: number
  requiredNdePct: number
  /** The requirement as printed, so the UI can quote the source. */
  statedAs?: string
}

export interface TieredInspectionRule {
  kind: 'tiered'
  rules: TierRule[]
  /** Whether QA/QC have signed off on these break points. */
  confirmed: boolean
}

export type InspectionRule = FlatInspectionRule | TieredInspectionRule

/** DP-318's rule, read from cell G7 rather than inferred. */
export const DP318_INSPECTION_RULE: FlatInspectionRule = {
  kind: 'flat',
  requiredVisualPct: 100,
  requiredNdePct: 10,
  statedAs: 'Project Totals- Requirement- 100% visual & 10% NDE',
}

/**
 * A tier rule: the band of % SMYS it covers and what that band requires.
 *
 * These live in a table rather than in an `if` chain because no break
 * point has been confirmed by QA/QC. Nothing in the DP-318 workbook
 * establishes one — the 20% figure was inferred and is wrong for that job
 * — so a book switched to `tiered` must carry its own bands, supplied by
 * the people who own the specification.
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
 * An example band set, NOT a default.
 *
 * Deliberately not applied to any book automatically. A job on the tiered
 * rule supplies its own bands; this exists so the shape is testable and so
 * the UI has something to render when someone builds one.
 */
export const EXAMPLE_TIER_RULES: TierRule[] = [
  {
    id: 'example-below-20-smys',
    minPctSmys: 0,
    maxPctSmys: 0.20,
    tier: '100% Visual',
    requiredNdtFraction: 0,
    requiresFullVisual: true,
    note: 'Example band only — unconfirmed, and not in force on any job.',
  },
  {
    id: 'example-at-or-above-20-smys',
    minPctSmys: 0.20,
    maxPctSmys: null,
    tier: '100% Visual and 15% NDT',
    requiredNdtFraction: 0.15,
    requiresFullVisual: true,
    note: 'Example band only — unconfirmed, and not in force on any job.',
  },
]

/** No tier break point has been confirmed by QA/QC for any job. */
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
/**
 * Hoop stress and % of SMYS for one weld.
 *
 * Computed for every weld on every book, whatever rule governs its
 * inspection: it is real engineering data about the pipe and belongs on
 * the record whether or not it decides anything. A tier is assigned only
 * when a band set is supplied.
 */
export function computeSmys(
  input: SmysInput,
  rules: TierRule[] = [],
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
  const rule = rules.length
    ? rules.find((r) => pct >= r.minPctSmys && (r.maxPctSmys == null || pct < r.maxPctSmys))
    : undefined

  return {
    odIn: dim.odIn,
    wallIn: dim.wallIn,
    hoopStressPsi: hoop,
    smysPsi: smys,
    pctSmys: pct,
    tier: rule?.tier ?? null,
    requiredNdtFraction: rule?.requiredNdtFraction ?? null,
    ruleId: rule?.id ?? null,
    // A book with no tier bands is not a book with a problem — % of SMYS
    // computed fine, and nothing was asked of it.
    uncomputableReason: !rules.length || rule
      ? null
      : `No tier rule covers ${(pct * 100).toFixed(2)}% SMYS`,
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
  rules: TierRule[] = [],
  /** Reporting threshold for the below/at-or-above split. Only a summary
   *  cut, never an obligation — a book on the flat rule still wants to
   *  know how its stress is distributed. */
  reportingThreshold = 0.20,
): TierRollup {
  const threshold = rules.find((r) => r.requiredNdtFraction > 0)?.minPctSmys ?? reportingThreshold
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
