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
import { applyComputedScores } from '@/lib/domain/scoring'
import { previewUploads, type PrepareInput } from '@/lib/domain/upload'
import { buildDp452Bundle } from './seed/dp452'
import { buildGreeleyBundle } from './seed/greeley'

export interface JobBookSummary {
  id: string
  jobNumber: string
  facilityName: string | null
  clientOrgName: string
  bookType: 'flowline' | 'facility'
  status: string
  overallPct: number
  /** Distinct findings, not the records behind them. */
  criticalFlags: number
  criticalRecords: number
  targetTurnoverDate: string | null
  /** Null when no target is set, and null once the book has been handed
   *  over — a delivered book cannot be running late. */
  daysToTurnover: number | null
  turnoverState: 'no_target' | 'delivered' | 'upcoming' | 'overdue'
}

/** Statuses at or past hand-over. Countdowns stop here. */
const DELIVERED_STATUSES = new Set(['submitted', 'accepted', 'archived'])

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

export interface UploadResult {
  ok: boolean
  /** What was actually written, in the order supplied. */
  added: { originalFilename: string; normalizedFilename: string; sha256: string }[]
  /** Files the preview refused, with the reason. */
  rejected: { originalFilename: string; reason: string }[]
  error?: string
}

export interface DataProvider {
  listJobBooks(viewer: Viewer): Promise<JobBookSummary[]>
  getBundle(viewer: Viewer, jobBookId: string): Promise<JobBookBundle | null>
  createJobBook(viewer: Viewer, input: NewJobBookInput): Promise<CreateResult>
  listClientOrgs(viewer: Viewer): Promise<{ id: string; name: string }[]>
  /**
   * Add documents to one section.
   *
   * Runs the same `previewUploads` the tech saw before pressing the button,
   * against the book as it is *now* rather than as it was when the preview
   * rendered — otherwise two techs uploading the same file a minute apart
   * both pass a preview taken before the other's commit.
   */
  addDocuments(
    viewer: Viewer,
    jobBookId: string,
    sectionNumber: string,
    files: PrepareInput[],
  ): Promise<UploadResult>
}

/** The demo/seed provider. Builds the reference book once per process. */
class SeedProvider implements DataProvider {
  private cache: JobBookBundle[] | null = null
  /**
   * Books created through the setup wizard. In-memory and per-process:
   * they survive navigation but not a server restart, which is the right
   * trade for a provider whose job is to demonstrate the flow. The
   * Supabase provider persists through `create_job_book()`, which
   * scaffolds the sections in the same transaction as the book so one
   * cannot exist without the other.
   */
  private created = new Map<string, JobBookBundle>()

  private seeded(): JobBookBundle[] {
    // Stamped, not raw. `computedPct` is a cache the client-facing views
    // read directly, so a bundle must never leave this provider carrying a
    // stored percentage that disagrees with what the engine computes —
    // otherwise staff and client read two different books off one dataset.
    if (!this.cache) {
      this.cache = [buildDp452Bundle(), buildGreeleyBundle()].map(applyComputedScores)
    }
    return this.cache
  }

  private all(): JobBookBundle[] {
    return [...this.seeded(), ...this.created.values()]
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
    const { aggregateFindings, countBySeverity, evaluateFlags } = await import('@/lib/domain/flags')
    const out: JobBookSummary[] = []
    for (const b of this.all()) {
      if (!this.canSee(viewer, b)) continue
      const score = scoreBook(b)
      const counts = countBySeverity(aggregateFindings(evaluateFlags(b)))
      const delivered = DELIVERED_STATUSES.has(b.book.status)
      const days = b.book.targetTurnoverDate && !delivered
        ? Math.round(
            (Date.parse(`${b.book.targetTurnoverDate}T00:00:00Z`) -
              Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86_400_000,
          )
        : null
      const turnoverState: JobBookSummary['turnoverState'] =
        delivered ? 'delivered'
          : !b.book.targetTurnoverDate ? 'no_target'
          : (days ?? 0) < 0 ? 'overdue'
          : 'upcoming'
      out.push({
        id: b.book.id,
        jobNumber: b.book.jobNumber,
        facilityName: b.book.facilityName ?? null,
        clientOrgName: b.clientOrg.name,
        bookType: b.book.bookType,
        status: b.book.status,
        overallPct: score.overallPct,
        criticalFlags: counts.critical,
        criticalRecords: counts.criticalRecords,
        targetTurnoverDate: b.book.targetTurnoverDate ?? null,
        daysToTurnover: days,
        turnoverState,
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

  async addDocuments(
    viewer: Viewer,
    jobBookId: string,
    sectionNumber: string,
    files: PrepareInput[],
  ): Promise<UploadResult> {
    // Mirrors the RLS write predicate. The database is the control; this
    // keeps a read-only viewer from reaching a button that would fail.
    const WRITERS = new Set(['fortress_admin', 'qaqc_manager', 'qaqc_tech'])
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, added: [], rejected: [], error: 'Not permitted to upload to this book.' }
    }

    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) {
      return { ok: false, added: [], rejected: [], error: 'Job book not found.' }
    }

    const def = b.sectionDefinitions.find((d) => d.sectionNumber === sectionNumber)
    const section = def && b.sections.find((x) => x.sectionDefinitionId === def.id)
    if (!def || !section) {
      return { ok: false, added: [], rejected: [], error: `No section ${sectionNumber} in this book.` }
    }

    const preview = previewUploads(files, {
      book: b.book, section: def, sectionId: section.id,
      existing: b.documents, expectedCount: section.expectedCount ?? null,
    })

    const now = new Date().toISOString()
    const added: UploadResult['added'] = []
    const rejected: UploadResult['rejected'] = []
    const documents = [...b.documents]

    for (const p of preview.files) {
      if (!p.willBeAdded) {
        rejected.push({
          originalFilename: p.originalFilename,
          reason: p.issues.find((i) => i.blocking)?.message ?? 'Rejected.',
        })
        continue
      }
      // A superseded document is marked, never removed. The turnover
      // package ships the current revision; the audit trail keeps both.
      if (p.supersedesDocumentId) {
        const i = documents.findIndex((d) => d.id === p.supersedesDocumentId)
        if (i >= 0) documents[i] = { ...documents[i]!, isSuperseded: true }
      }
      documents.push({
        id: `doc-${jobBookId}-${p.sha256.slice(0, 16)}`,
        jobBookId,
        sectionId: section.id,
        originalFilename: p.originalFilename,
        normalizedFilename: p.normalizedFilename,
        storagePath: `${jobBookId}/${sectionNumber}/${p.sha256}`,
        mimeType: p.mimeType,
        byteSize: p.byteSize,
        sha256: p.sha256,
        version: p.version,
        supersedesDocumentId: p.supersedesDocumentId,
        isSuperseded: false,
        visibility: 'internal',
        uploadedBy: viewer.id,
        uploadedAt: now,
      })
      added.push({
        originalFilename: p.originalFilename,
        normalizedFilename: p.normalizedFilename,
        sha256: p.sha256,
      })
    }

    // Uploading is evidence arriving, so the section is no longer untouched
    // and its folder is no longer unread.
    const sections = b.sections.map((x) =>
      x.id !== section.id ? x : {
        ...x,
        status: x.status === 'not_started' && added.length ? 'in_progress' as const : x.status,
        ingestionStatus: added.length ? 'imported' as const : x.ingestionStatus,
      },
    )

    // Re-stamped, so the cached percentage moves with the evidence rather
    // than going stale the moment a file lands.
    const updated = applyComputedScores({ ...b, documents, sections })
    if (this.created.has(jobBookId)) this.created.set(jobBookId, updated)
    else if (this.cache) this.cache[idx] = updated

    return { ok: true, added, rejected }
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

    this.created.set(book.id, applyComputedScores({
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
    }))
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
    // Marked, so `scoreBook` reads the cached figure instead of deriving a
    // new one from evidence that is no longer all here. Without this the
    // filtering below silently rewrites the completion percentage.
    redacted: true,
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
