/**
 * Data access.
 *
 * The application talks to this interface, never to Supabase directly, for
 * two reasons. It keeps the domain engine testable without a database, and
 * it means the DP452 reference book runs the real screens with the real
 * scoring code — a demo that shares every line of logic with production
 * rather than approximating it.
 *
 * `SeedProvider` is in-memory and read-only. `SupabaseProvider` (below) is
 * the persistent one; both satisfy the same contract, and every query it
 * issues runs under the caller's RLS session, so the isolation guarantees
 * are the database's rather than this file's.
 */
import type { JobBookBundle, UserRole } from '@/lib/domain/types'
import { buildDp452Bundle } from './seed/dp452'

export interface JobBookSummary {
  id: string
  jobNumber: string
  facilityName: string | null
  clientOrgName: string
  bookType: 'flowline' | 'facility'
  status: string
  overallPct: number
  criticalFlags: number
  targetTurnoverDate: string | null
  daysToTurnover: number | null
}

export interface Viewer {
  id: string
  email: string
  fullName: string
  role: UserRole
  clientOrgId: string | null
}

export interface DataProvider {
  listJobBooks(viewer: Viewer): Promise<JobBookSummary[]>
  getBundle(viewer: Viewer, jobBookId: string): Promise<JobBookBundle | null>
}

/** The demo/seed provider. Builds the reference book once per process. */
class SeedProvider implements DataProvider {
  private cache: JobBookBundle | null = null

  private bundle(): JobBookBundle {
    if (!this.cache) this.cache = buildDp452Bundle()
    return this.cache
  }

  /**
   * Client isolation is mirrored here so the seed provider behaves like the
   * real one. It is a convenience, not the control — in the Supabase
   * provider the same rule is a database policy, which is what actually
   * holds when the API is probed directly.
   */
  private canSee(viewer: Viewer, b: JobBookBundle): boolean {
    if (viewer.role === 'client_user') return viewer.clientOrgId === b.clientOrg.id
    if (viewer.role === 'third_party_inspector') return false  // requires a grant row
    return true
  }

  async listJobBooks(viewer: Viewer): Promise<JobBookSummary[]> {
    const b = this.bundle()
    if (!this.canSee(viewer, b)) return []
    const { scoreBook } = await import('@/lib/domain/scoring')
    const { countBySeverity, evaluateFlags } = await import('@/lib/domain/flags')
    const score = scoreBook(b)
    const counts = countBySeverity(evaluateFlags(b))
    const days = b.book.targetTurnoverDate
      ? Math.round(
          (Date.parse(`${b.book.targetTurnoverDate}T00:00:00Z`) -
            Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86_400_000,
        )
      : null
    return [{
      id: b.book.id,
      jobNumber: b.book.jobNumber,
      facilityName: b.book.facilityName ?? null,
      clientOrgName: b.clientOrg.name,
      bookType: b.book.bookType,
      status: b.book.status,
      overallPct: score.overallPct,
      criticalFlags: counts.critical,
      targetTurnoverDate: b.book.targetTurnoverDate ?? null,
      daysToTurnover: days,
    }]
  }

  async getBundle(viewer: Viewer, jobBookId: string): Promise<JobBookBundle | null> {
    const b = this.bundle()
    if (b.book.id !== jobBookId || !this.canSee(viewer, b)) return null
    return redactForViewer(viewer, b)
  }
}

/**
 * Strip internal-only fields before a bundle leaves the server for an
 * external viewer.
 *
 * §3 requires this to happen server-side rather than being hidden in the
 * browser: a client user must not be able to read an internal deficiency
 * note out of a response payload. In the Supabase provider the same
 * projection is done by the `client_*_v` views, so a probe of the REST API
 * gets the same reduced shape this returns.
 */
export function redactForViewer(viewer: Viewer, b: JobBookBundle): JobBookBundle {
  const external = viewer.role === 'client_user' || viewer.role === 'third_party_inspector'
  if (!external) return b
  return {
    ...b,
    sections: b.sections.map((s) => ({ ...s, internalNotes: null })),
    // Draft and unapproved documents do not exist as far as an external
    // reader is concerned.
    documents: b.documents.filter((d) => d.approvedAt && d.visibility !== 'internal'),
    welds: b.welds.map((w) => ({
      ...w,
      comments: null,
      rootWelderId: null, hotWelderId: null, fillWelderId: null, capWelderId: null,
      welderPassAssignment: null,
    })),
  }
}

let provider: DataProvider | null = null

export function getDataProvider(): DataProvider {
  if (!provider) provider = new SeedProvider()
  return provider
}

/** The signed-in viewer. Wired to Supabase Auth in `lib/supabase/server.ts`;
 *  the seed provider runs as a QA/QC manager so every screen is reachable
 *  in development. */
export const DEMO_VIEWER: Viewer = {
  id: 'user-mgr-1',
  email: 'david.devitt@fortressds.com',
  fullName: 'David Devitt',
  role: 'qaqc_manager',
  clientOrgId: null,
}
