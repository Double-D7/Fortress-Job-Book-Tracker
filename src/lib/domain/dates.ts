/**
 * Calendar-date helpers.
 *
 * Everything in this domain is a calendar date (`YYYY-MM-DD`), never an
 * instant: a weld happened on a day in a field. Comparing ISO date strings
 * lexicographically is exact for this format and sidesteps the timezone
 * bugs that turn a 2024-12-31 weld into 2025-01-01 for anyone east of UTC.
 */
import type { IsoDate } from './types'

/** Deliberately returns `boolean`, not a type predicate: `IsoDate` is a
 *  plain string alias, so a predicate would narrow the negative branch to
 *  `never` and hide real parsing paths from the compiler. */
export const isIsoDate = (v: unknown): boolean =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** `a < b`. Null on either side is "unknown", which is never a comparison. */
export function isBefore(a?: IsoDate | null, b?: IsoDate | null): boolean {
  return !!a && !!b && a < b
}
export function isAfter(a?: IsoDate | null, b?: IsoDate | null): boolean {
  return !!a && !!b && a > b
}

/** Inclusive on both ends; an open end means unbounded in that direction. */
export function isWithin(d: IsoDate, start?: IsoDate | null, end?: IsoDate | null): boolean {
  if (start && d < start) return false
  if (end && d > end) return false
  return true
}

export function addDays(d: IsoDate, days: number): IsoDate {
  const dt = new Date(`${d}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

export function today(): IsoDate {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Parse the date formats the source workbooks actually contain: Excel
 * serial numbers, `M/D/YY`, `M-D-YYYY`, `M.D.YYYY` and ISO. Returns null
 * rather than guessing, so an unparseable cell surfaces as a validation
 * error instead of a silently wrong date.
 */
export function parseLooseDate(v: unknown): IsoDate | null {
  if (v == null || v === '') return null
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial: day 1 is 1900-01-01, offset by the mythical 1900 leap day.
    if (v < 1 || v > 80_000) return null
    const ms = Math.round((v - 25_569) * 86_400_000)
    return new Date(ms).toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  if (isIsoDate(s)) return s
  const m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/)
  if (!m) return null
  const [, mo, da, yrRaw] = m as unknown as [string, string, string, string]
  let yr = Number(yrRaw)
  if (yr < 100) yr += yr < 70 ? 2000 : 1900
  const month = Number(mo)
  const day = Number(da)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${String(yr).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
