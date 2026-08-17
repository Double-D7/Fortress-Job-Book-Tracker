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
import { scaffoldJobBook, validateNewJobBook, type NewJobBookInput } from '@/lib/domain/scaffold'
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

export interface CreateResult {
  ok: boolean
  jobBookId?: string
  errors?: { field: string; message: string }[]
  warnings?: { field: string; message: string }[]
}

export interface DataProvider {
  listJobBooks(viewer: Viewer): Promise<JobBookSummary[]>
  getBundle(viewer: Viewer, jobBookId: string): Promise<JobBookBundle | null>
  createJobBook(viewer: Viewer, input: NewJobBookInput): Promise<CreateResult>
  listClientOrgs(viewer: Viewer): Promise<{ id: string; name: string }[]>
}

/** The demo/seed provider. Builds the reference book once per process. */
class SeedProvider implements DataProvider {
  private cache: JobBookBundle | null = null
  /**
   * Books created through the setup wizard. In-memory and per-process:
   * they survive navigation but not a server restart, which is the right
   * trade for a provider whose job is to demonstrate the flow. The
   * Supabase provider persists through `create_job_book()`, which
   * scaffolds the sections in the same transaction as the book so one
   * cannot exist without the other.
   */
  private created = new Map<string, JobBookBundle>()

  private bundle(): JobBookBundle {
    if (!this.cache) this.cache = buildDp452Bundle()
    return this.cache
  }

  private all(): JobBookBundle[] {
    return [this.bundle(), ...this.created.values()]
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
    const { scoreBook } = await import('@/lib/domain/scoring')
    const { countBySeverity, evaluateFlags } = await import('@/lib/domain/flags')
    const out: JobBookSummary[] = []
    for (const b of this.all()) {
      if (!this.canSee(viewer, b)) continue
      const score = scoreBook(b)
      const counts = countBySeverity(evaluateFlags(b))
      const days = b.book.targetTurnoverDate
        ? Math.round(
            (Date.parse(`${b.book.targetTurnoverDate}T00:00:00Z`) -
              Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86_400_000,
          )
        : null
      out.push({
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
      })
    }
    return out.sort((a, c) => a.jobNumber.localeCompare(c.jobNumber))
  }

  async getBundle(viewer: Viewer, jobBookId: string): Promise<JobBookBundle | null> {
    const b = this.all().find((x) => x.book.id === jobBookId)
    if (!b || !this.canSee(viewer, b)) return null
    return redactForViewer(viewer, b)
  }

  async listClientOrgs(viewer: Viewer): Promise<{ id: string; name: string }[]> {
    const orgs = new Map<string, string>()
    for (const b of this.all()) {
      if (this.canSee(viewer, b)) orgs.set(b.clientOrg.id, b.clientOrg.name)
    }
    // A demo instance would otherwise offer exactly one operator, which
    // hides the client-isolation story the wizard is meant to show.
    orgs.set('org-oxy', 'Occidental')
    orgs.set('org-devon', 'Devon Energy')
    return [...orgs.entries()].map(([id, name]) => ({ id, name }))
                              .sort((a, b) => a.name.localeCompare(b.name))
  }

  async createJobBook(viewer: Viewer, input: NewJobBookInput): Promise<CreateResult> {
    // Mirrors the role check in `create_job_book()`. The database is the
    // control; this is the courtesy that stops a tech reaching a form they
    // cannot submit.
    if (viewer.role !== 'fortress_admin' && viewer.role !== 'qaqc_manager') {
      return {
        ok: false,
        errors: [{ field: 'role', message: 'Creating a job book requires a QA/QC Manager or Admin.' }],
      }
    }

    const { errors, warnings } = validateNewJobBook(input)
    if (errors.length) return { ok: false, errors, warnings }

    const slug = input.jobNumber.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    if (this.all().some((b) => b.book.jobNumber.toLowerCase() === input.jobNumber.trim().toLowerCase())) {
      return {
        ok: false,
        errors: [{ field: 'jobNumber', message: `A job book numbered ${input.jobNumber} already exists.` }],
        warnings,
      }
    }

    const { book, sections, weldLines, sectionDefinitions } = scaffoldJobBook(
      input,
      (kind, key) => (kind === 'book' ? `book-${slug}` : `${kind}-${slug}-${key.split(':').pop()}`),
    )
    const orgs = await this.listClientOrgs(viewer)
    const org = orgs.find((o) => o.id === input.clientOrgId)

    this.created.set(book.id, {
      book,
      project: {
        id: input.projectId,
        clientOrgId: input.clientOrgId,
        name: input.facilityName?.trim() || book.jobNumber,
        operatorPicName: input.operatorPicName ?? null,
        afeNumber: null,
      },
      clientOrg: { id: input.clientOrgId, name: org?.name ?? 'Unknown operator', logoUrl: null },
      sectionDefinitions,
      sections,
      documents: [],
      weldLines,
      welds: [],
      welders: [],
      welderQualifications: [],
      cwis: [],
      ndtTechnicians: [],
      torqueWrenches: [],
      torqueConnections: [],
      certificates: [],
      ndeReports: [],
      materialHeats: [],
      pressureTests: [],
      cpTestPoints: [],
      utReadings: [],
    })
    return { ok: true, jobBookId: book.id, warnings }
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
