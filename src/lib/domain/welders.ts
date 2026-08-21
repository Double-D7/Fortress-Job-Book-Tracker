/**
 * Welder and X-ray percentage engine — the single most-audited number in
 * the book.
 *
 * A note on what "total welds" means here, because two defensible numbers
 * exist and mixing them is how audit findings start:
 *
 *   joint count   — rows in the weld log. One physical joint, counted once.
 *   welder credit — the sum of the per-welder columns in the Noble
 *                   template. A joint welded by two men across its four
 *                   passes is credited to both, so this total exceeds the
 *                   joint count.
 *
 * The Noble template's own rollup uses welder credit, so that is what this
 * module reproduces (2,476 credits against 955 + gas-lift joint rows in
 * DP452, an overstatement of ~5.7%). Both numbers are returned, and the UI
 * must label which one it is showing.
 */
import type { JobBook, Weld, Welder, WelderQualification } from './types'
import { addDays, isAfter, isBefore, isWithin } from './dates'

/** ASME Section IX: qualification lapses after 6 months without welding
 *  with that process. */
export const CONTINUITY_WINDOW_DAYS = 183

export interface WelderRollup {
  welderId: string
  initials: string
  fullName: string
  /** Welder-credit count, matching the Noble template's per-welder column. */
  totalWelds: number
  totalXrays: number
  xrayPct: number
  cwiPass: number
  cwiFail: number
  /** Share of this welder's joints that received a CWI visual inspection. */
  pctInspected: number
  ndtPass: number
  ndtFail: number
  meetsRequirement: boolean
  firstWeldDate?: string | null
  lastWeldDate?: string | null
}

/** A weld is X-rayed if a radiographic examination is recorded against it. */
export function isXrayed(w: Weld): boolean {
  return w.ndtMethod === 'RT' || (!!w.xrayNumber && w.xrayNumber.trim() !== '')
}

/** `NOT USED` weld numbers are gaps in the sequence by design and never
 *  count for or against anything. */
export function isCountable(w: Weld): boolean {
  return w.status !== 'not_used'
}

/**
 * The distinct welders credited for one joint. A `CT/CT/HS2/HS2` joint
 * credits two men, once each — never twice for holding two passes.
 */
export function creditedWelders(w: Weld): string[] {
  // A facility log records one welder stamp per weld rather than four pass
  // assignments. Reading whichever shape is populated keeps every rollup,
  // qualification check and continuity calculation identical across book
  // types — the alternative is the same logic written twice and drifting.
  if (w.welderId) return [w.welderId]
  const ids = [w.rootWelderId, w.hotWelderId, w.fillWelderId, w.capWelderId]
  return [...new Set(ids.filter((x): x is string => !!x))]
}

/** True when this weld uses the facility single-stamp shape. */
export function isSingleStampWeld(w: Weld): boolean {
  return !!w.welderId || (!!w.welderStamp && !w.welderPassAssignment)
}

/**
 * Who receives X-ray credit on a split-pass joint. The operator's
 * convention varies, so the rule is per-job configuration rather than an
 * assumption baked into the rollup.
 */
export function xrayCreditedWelders(w: Weld, rule: JobBook['xrayCreditRule']): string[] {
  // A single-stamp weld has one welder, so the split-pass credit rule has
  // nothing to choose between.
  if (w.welderId) return [w.welderId]
  switch (rule) {
    case 'root_welder': return w.rootWelderId ? [w.rootWelderId] : []
    case 'cap_welder':  return w.capWelderId ? [w.capWelderId] : []
    default:            return creditedWelders(w)
  }
}

/**
 * Per-welder rollup across an arbitrary weld set. Pass one line's welds for
 * the per-line block the Noble template prints; pass the whole book for the
 * aggregate.
 */
export function rollupByWelder(
  welds: Weld[],
  welders: Welder[],
  book: Pick<JobBook, 'xrayCreditRule' | 'requiredXrayPct'>,
): WelderRollup[] {
  const byId = new Map(welders.map((w) => [w.id, w]))
  const acc = new Map<string, WelderRollup>()

  const ensure = (id: string): WelderRollup => {
    let r = acc.get(id)
    if (!r) {
      const w = byId.get(id)
      r = {
        welderId: id,
        initials: w?.initials ?? '??',
        fullName: w?.fullName ?? 'Unknown welder',
        totalWelds: 0, totalXrays: 0, xrayPct: 0,
        cwiPass: 0, cwiFail: 0, pctInspected: 0,
        ndtPass: 0, ndtFail: 0, meetsRequirement: false,
        firstWeldDate: null, lastWeldDate: null,
      }
      acc.set(id, r)
    }
    return r
  }

  for (const weld of welds) {
    if (!isCountable(weld)) continue
    const credited = creditedWelders(weld)
    const xrayCredited = isXrayed(weld)
      ? new Set(xrayCreditedWelders(weld, book.xrayCreditRule))
      : new Set<string>()

    for (const id of credited) {
      const r = ensure(id)
      r.totalWelds += 1
      if (xrayCredited.has(id)) {
        r.totalXrays += 1
        if (weld.ndtResult === 'Pass') r.ndtPass += 1
        if (weld.ndtResult === 'Fail') r.ndtFail += 1
      }
      if (weld.cwiVisualResult === 'Pass') r.cwiPass += 1
      if (weld.cwiVisualResult === 'Fail') r.cwiFail += 1
      if (weld.weldDate) {
        if (!r.firstWeldDate || weld.weldDate < r.firstWeldDate) r.firstWeldDate = weld.weldDate
        if (!r.lastWeldDate || weld.weldDate > r.lastWeldDate) r.lastWeldDate = weld.weldDate
      }
    }
  }

  for (const r of acc.values()) {
    r.xrayPct = r.totalWelds ? (r.totalXrays / r.totalWelds) * 100 : 0
    r.pctInspected = r.totalWelds ? ((r.cwiPass + r.cwiFail) / r.totalWelds) * 100 : 0
    r.meetsRequirement = r.xrayPct >= book.requiredXrayPct
  }

  return [...acc.values()].sort((a, b) => b.totalWelds - a.totalWelds)
}

export interface XrayTotals {
  /** Welder-credit totals — the Noble template's number. */
  totalWeldCredits: number
  totalXrayCredits: number
  xrayPct: number
  /** Physical joints, counted once each. */
  jointCount: number
  xrayedJointCount: number
  /** How far the credit total overstates the joint count, as a percentage. */
  creditOverstatementPct: number
}

export function xrayTotals(
  welds: Weld[],
  book: Pick<JobBook, 'xrayCreditRule' | 'requiredXrayPct'>,
  welders: Welder[] = [],
): XrayTotals {
  const rollups = rollupByWelder(welds, welders, book)
  const totalWeldCredits = rollups.reduce((s, r) => s + r.totalWelds, 0)
  const totalXrayCredits = rollups.reduce((s, r) => s + r.totalXrays, 0)
  const countable = welds.filter(isCountable)
  const jointCount = countable.length
  const xrayedJointCount = countable.filter(isXrayed).length
  return {
    totalWeldCredits,
    totalXrayCredits,
    xrayPct: totalWeldCredits ? (totalXrayCredits / totalWeldCredits) * 100 : 0,
    jointCount,
    xrayedJointCount,
    creditOverstatementPct: jointCount ? ((totalWeldCredits - jointCount) / jointCount) * 100 : 0,
  }
}

/**
 * Was this welder qualified on the day they welded?
 *
 * Both directions matter. A certificate that has since expired is fine for
 * work performed while it was live; a weld performed before qualification
 * or after expiry is a finding regardless of today's status.
 */
export function qualifiedOn(
  welderId: string,
  date: string,
  quals: WelderQualification[],
): boolean {
  return quals.some(
    (q) => q.welderId === welderId && isWithin(date, q.qualificationDate, q.expiryDate ?? null),
  )
}

export interface ContinuityStatus {
  welderId: string
  lastWeldDate: string | null
  daysSinceLastWeld: number | null
  lapsed: boolean
  lapsesOn: string | null
}

/**
 * Continuity against the ASME IX 6-month rule, evaluated as of `asOf`
 * (default: the welder's own last weld plus the window, i.e. when the
 * qualification will go stale if they do not weld again).
 */
export function continuityStatus(
  welderId: string,
  welds: Weld[],
  asOf: string,
): ContinuityStatus {
  const dates = welds
    .filter((w) => isCountable(w) && creditedWelders(w).includes(welderId) && w.weldDate)
    .map((w) => w.weldDate as string)
    .sort()
  const last = dates.length ? dates[dates.length - 1]! : null
  if (!last) {
    return { welderId, lastWeldDate: null, daysSinceLastWeld: null, lapsed: false, lapsesOn: null }
  }
  const lapsesOn = addDays(last, CONTINUITY_WINDOW_DAYS)
  return {
    welderId,
    lastWeldDate: last,
    daysSinceLastWeld: Math.round(
      (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000,
    ),
    lapsed: isAfter(asOf, lapsesOn),
    lapsesOn,
  }
}

/**
 * Resolve a name as written in a log to a managed welder. Import must never
 * mint a new welder from a typo — `Conor Tracy`, `Cannon Tracey`, `Canor
 * Tracy` and `Coner Tracy` are one man, and the WPQ is filed under a fifth
 * spelling.
 */
export function resolveWelder(nameOrInitials: string, welders: Welder[]): Welder | null {
  const needle = nameOrInitials.trim().toLowerCase()
  if (!needle) return null
  return (
    welders.find((w) => w.initials.toLowerCase() === needle) ??
    welders.find((w) => w.fullName.toLowerCase() === needle) ??
    welders.find((w) => w.nameAliases.some((a) => a.toLowerCase() === needle)) ??
    null
  )
}

/** Split a `Root/Hot/Fill/Cap` cell such as `CT/CT/HS2/HS2`. */
export function parsePassAssignment(cell: string): (string | null)[] {
  const parts = cell.split('/').map((p) => p.trim())
  const out: (string | null)[] = []
  for (let i = 0; i < 4; i++) out.push(parts[i] && parts[i] !== '' ? parts[i]! : null)
  return out
}

export { isBefore }
