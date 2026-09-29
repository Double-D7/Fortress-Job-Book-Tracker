/**
 * The engine has to survive the shape the database actually returns.
 *
 * Every test in this suite builds its bundle from the seed provider,
 * which is an in-memory object graph: an NDE report there carries its
 * exposure rows in `lines`, because whoever built it put them there. The
 * Supabase provider assembles a bundle table by table, and
 * `nde_report_line` was written by the importer and never read back. So
 * in production every report arrived with `lines` undefined.
 *
 * `ndeCoverage` walked them. `for (const line of undefined)` threw inside
 * `evaluateFlags`, which is called on the portfolio dashboard — the first
 * page after signing in. The whole application returned a server-side
 * exception, and the entire suite passed, because the seed provider makes
 * the bug invisible.
 *
 * This is the third divergence of that exact kind found in a fortnight.
 * These cases exercise the domain engine against records shaped the way
 * the database hands them over, with the optional relations absent.
 */
import { describe, expect, it } from 'vitest'
import { evaluateFlags } from '@/lib/domain/flags'
import { ndeCoverage } from '@/lib/domain/ndeCoverage'
import { reconcileNde } from '@/lib/domain/reconcile'
import { scoreBook } from '@/lib/domain/scoring'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { JobBookBundle, NdeReport } from '@/lib/domain/types'

/**
 * The seed bundle with every relation the database does not fold into its
 * parent row stripped back out — which is what `getBundle` returns before
 * anything re-attaches them.
 */
function asTheDatabaseReturnsIt(): JobBookBundle {
  const b = buildDp452Bundle()
  return {
    ...b,
    ndeReports: b.ndeReports.map((r) => {
      const { lines: _lines, ...row } = r
      return row as NdeReport
    }),
  }
}

describe('a report whose exposure rows were never loaded', () => {
  it('evidences nothing instead of throwing', () => {
    const b = asTheDatabaseReturnsIt()
    expect(() => ndeCoverage(b.welds, b.ndeReports, b.book)).not.toThrow()
    expect(ndeCoverage(b.welds, b.ndeReports, b.book).evidenced).toBe(0)
  })

  it('does not take down the flag engine', () => {
    // This is the one that mattered: evaluateFlags runs on the dashboard,
    // so a throw here is the whole application down after sign-in.
    const b = asTheDatabaseReturnsIt()
    expect(() => evaluateFlags(b)).not.toThrow()
    expect(evaluateFlags(b).length).toBeGreaterThan(0)
  })

  it('does not take down scoring', () => {
    expect(() => scoreBook(asTheDatabaseReturnsIt())).not.toThrow()
  })

  it('does not take down the reconciliation', () => {
    const b = asTheDatabaseReturnsIt()
    expect(() => reconcileNde(b.welds, b.ndeReports)).not.toThrow()
  })
})

describe('the same bundle with its rows loaded', () => {
  it('still evidences what the reports cover', () => {
    // The guard must not have quietly turned coverage off for everybody.
    const b = buildDp452Bundle()
    expect(ndeCoverage(b.welds, b.ndeReports, b.book).evidenced).toBeGreaterThan(0)
  })
})
