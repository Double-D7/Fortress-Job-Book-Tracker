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
import type {
  AuditFinding, AuditTier, CompetencyLevel, CriterionResult, FindingClass,
  GateId, GateOutcome, GateReview, JobBookAudit, JobBookBundle, UserRole,
} from '@/lib/domain/types'
import { canPeerAudit, scoreAudit } from '@/lib/domain/audits'
import { aggregateFindings, evaluateFlags } from '@/lib/domain/flags'
import { scaffoldJobBook, validateNewJobBook, type NewJobBookInput } from '@/lib/domain/scaffold'
import { afterUpload, applyComputedScores, scoreBook } from '@/lib/domain/scoring'
import { previewUploads, type PrepareInput } from '@/lib/domain/upload'
import {
  checkWeldLogOverview, parseWeldLogOverviewPdf, type WeldLogOverview,
} from '@/lib/import/weldLogOverview'
import {
  planOverviewIngest, rowsForPlan, type OverviewIngestPlan,
} from '@/lib/import/overviewIngest'
import {
  parseFacilityWeldRows, planWeldLogIngest, readWeldLogGrid, rowsForWeldPlan,
  type WeldLogIngestPlan,
} from '@/lib/import/weldLogIngest'
import {
  parseFacilityTorqueRows, planTorqueLogIngest, readTorqueLogGrid,
  rowsForTorquePlan, type TorqueLogIngestPlan,
} from '@/lib/import/torqueLogIngest'
import {
  parsePressureTestRows, readPressureLogGrid, toPressureTestRecords,
  type ParsedPressureRow, type PressureRowIssue,
} from '@/lib/import/pressureTestLog'
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

/** Mirrors the RLS write predicate and `approve_section()`'s role check.
 *  Courtesy, not control — the database refuses either way. */
const WRITER_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'fortress_admin', 'qaqc_manager', 'qaqc_tech',
])
const APPROVER_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'fortress_admin', 'qaqc_manager',
])

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

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface DataProvider {
  /**
   * Mark a section ready for a second person to review.
   *
   * Records who submitted it, which is half of the two-person control —
   * `approve_section()` refuses anyone whose id matches.
   */
  markSectionReady(
    viewer: Viewer, jobBookId: string, sectionNumber: string,
  ): Promise<ActionResult>

  /**
   * Approve a section. Always routed through the database function, never
   * through a direct UPDATE: the rule that an approver may not be the
   * submitter lives there so it holds for any caller, and reimplementing it
   * here would create a second copy to drift from the first.
   */
  approveSection(
    viewer: Viewer, jobBookId: string, sectionNumber: string,
  ): Promise<ActionResult>

  /** Resolve or dismiss a flag. The note is not optional — the database
   *  constraint refuses a resolution without one, because auditors ask. */
  resolveFlag(
    viewer: Viewer, jobBookId: string, fingerprint: string,
    state: 'resolved' | 'dismissed' | 'acknowledged', note: string,
  ): Promise<ActionResult>

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

  // -- Gate reviews, FDS-JBMP-001 §7 -------------------------------------

  /** Every gate decision taken on this book, newest attempt first. */
  listGateReviews(viewer: Viewer, jobBookId: string): Promise<GateReview[]>

  /**
   * The facts a gate evaluation needs that do not live in the bundle —
   * chiefly the named Custodian's competency level, which is a property of
   * the person rather than the book.
   */
  gateContext(viewer: Viewer, jobBookId: string): Promise<GateSideFacts>

  /**
   * Record a gate decision. Always routed through `record_gate_review()`
   * so the chair check, the ten-day ceiling and the demand for a written
   * override on an unmet criterion hold for any caller — the same reason
   * section approval goes through its own function.
   */
  recordGateReview(
    viewer: Viewer, jobBookId: string, input: GateDecision,
  ): Promise<ActionResult>

  /** Name the Custodian. Refused by the database below competency JB-2. */
  assignCustodian(
    viewer: Viewer, jobBookId: string, userId: string,
  ): Promise<ActionResult>

  /** Fortress staff who could hold a role on a book, for the pickers. */
  listStaff(viewer: Viewer): Promise<StaffMember[]>

  // -- Record ingestion --------------------------------------------------

  /**
   * Read a Weld Log Overview Sheet and say what importing it would do,
   * without doing any of it.
   *
   * Separate from the commit on purpose. A tech pressing "import" on a
   * sheet that would create ten welders and skip one because its stamp
   * names two people should be told that first — after the fact it is an
   * apology, before it is information.
   */
  previewOverviewImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array,
  ): Promise<OverviewImportPreview>

  /** Commit the plan from `previewOverviewImport`, re-derived server-side
   *  against the book as it stands now rather than as the preview saw it. */
  commitOverviewImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<OverviewImportResult>

  /** The same two steps for the Detailed Weld Log (§12), which reads a
   *  workbook or a PDF export of one. */
  previewWeldLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<WeldLogImportPreview>
  commitWeldLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<WeldLogImportResult>

  /** And again for the Torque Log (§14). Same two steps, same two file
   *  formats; the wrench ids are what the preview exists to check. */
  previewTorqueLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<TorqueLogImportPreview>
  commitTorqueLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<TorqueLogImportResult>

  // -- Three-tier verification, FDS-JBMP-001 §10 -------------------------

  /**
   * Record an audit and its findings.
   *
   * Routed through `record_peer_audit()` for Tier 2 so the independence
   * rule and the JB-3 floor hold for any caller — a check constraint
   * cannot see `job_book.custodian_id` or a competency level, so a plain
   * INSERT would let a Custodian audit their own book and produce a score
   * the gate engine would then believe.
   */
  /** The same two steps for the pressure test hold sheet (§17). */
  previewPressureTestImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<PressureTestImportPreview>
  commitPressureTestImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<PressureTestImportCommit>

  recordAudit(
    viewer: Viewer, jobBookId: string, input: AuditInput,
  ): Promise<ActionResult>

  /**
   * Sign the Completeness Certification (§10.4, form FDS-JB-F07).
   *
   * "No job book leaves Fortress without this signature." The QA/QC
   * Manager check and the zero-open-findings rule live in the database.
   */
  certifyCompleteness(
    viewer: Viewer, jobBookId: string, statement: string | null,
  ): Promise<ActionResult>
}

/** One audit, as a person records it. */
export interface AuditInput {
  tier: AuditTier
  auditorId: string
  /** Tier 2 only. Derived from the findings rather than typed, so the
   *  number and the reasons for it cannot disagree. */
  lotSize?: number | null
  sampleSize?: number | null
  samplePlan?: string | null
  doubleSample?: boolean
  notes?: string | null
  findings: {
    classification: FindingClass
    sectionNumber?: string | null
    summary: string
    detail?: string | null
    dueAt?: string | null
  }[]
}

export interface OverviewImportPreview {
  ok: boolean
  error?: string
  sheet?: WeldLogOverview
  plan?: OverviewIngestPlan
}

export interface OverviewImportResult {
  ok: boolean
  error?: string
  weldersCreated: number
  weldersMatched: number
  qualificationsRecorded: number
  peopleCreated: number
  skipped: { stamp: string; reason: string }[]
}

export interface WeldLogImportPreview {
  ok: boolean
  error?: string
  plan?: WeldLogIngestPlan
}

export interface WeldLogImportResult {
  ok: boolean
  error?: string
  weldLinesCreated: number
  weldsCreated: number
  weldsUpdated: number
}

/**
 * Parse a detailed weld log and plan its import against one book.
 *
 * Shared by both providers so the preview a tech reads is the same
 * computation the commit performs — the one place where a divergence
 * would be invisible and would matter.
 */
export function buildWeldLogPreview(
  bundle: JobBookBundle, file: Uint8Array, filename: string,
): WeldLogImportPreview {
  const read = readWeldLogGrid(file, filename)
  if (read.error) return { ok: false, error: read.error }
  if (read.grid.length === 0) {
    return { ok: false, error: 'No rows found in that file.' }
  }

  const parsed = parseFacilityWeldRows(read.grid, {
    sheetName: read.sheetsParsed[0] ?? 'Weld Log',
    defaultDesignPressurePsi: bundle.book.defaultDesignPressurePsi ?? null,
  })
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      error: parsed.issues[0]?.message
        ?? 'No weld rows could be read. The column headers did not match anything this reader knows.',
    }
  }
  return { ok: true, plan: planWeldLogIngest(parsed, bundle, read.format) }
}

export interface TorqueLogImportPreview {
  ok: boolean
  error?: string
  plan?: TorqueLogIngestPlan
}

export interface TorqueLogImportResult {
  ok: boolean
  error?: string
  connectionsCreated: number
  connectionsUpdated: number
}

/**
 * Parse a torque log and plan its import against one book.
 *
 * Shared by both providers, for the same reason the weld log builder is:
 * the plan a tech reads before committing has to be the same computation
 * the commit performs, and a divergence there would be invisible.
 */
export function buildTorqueLogPreview(
  bundle: JobBookBundle, file: Uint8Array, filename: string,
): TorqueLogImportPreview {
  const read = readTorqueLogGrid(file, filename)
  if (read.error) return { ok: false, error: read.error }
  if (read.grid.length === 0) {
    return { ok: false, error: 'No rows found in that file.' }
  }

  const parsed = parseFacilityTorqueRows(read.grid, read.sheetsParsed[0] ?? 'Torque Log')
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      error: parsed.issues[0]?.message
        ?? 'No torque rows could be read. The column headers did not match anything this reader knows.',
    }
  }
  return { ok: true, plan: planTorqueLogIngest(parsed, bundle, read.format) }
}

export interface PressureTestImportPreview {
  ok: boolean
  error?: string
  plan?: PressureTestIngestPlan
}

export interface PressureTestImportCommit {
  ok: boolean
  error?: string
  testsCreated: number
  testsUpdated: number
}

export interface PressureTestIngestPlan {
  format: 'xlsx' | 'pdf'
  sheetsParsed: string[]
  parsedRows: number
  /** Numbered rows the sheet holds that record no test. Named, never
   *  imported: a template placeholder is not a test that happened. */
  emptyRows: { testIdentifier: string; rowNumber: number }[]
  testsToCreate: number
  testsToUpdate: number
  /** Tests with no date, which §11.1 cannot check at all. */
  undated: number
  /** Tests whose hold ended below where it started. Reported, never
   *  judged — ambient temperature moves a reading and the result
   *  document is what settles it. */
  pressureDropped: number
  issues: PressureRowIssue[]
  rows: ParsedPressureRow[]
}

/**
 * Parse a pressure test hold sheet and plan its import against one book.
 *
 * Shared by both providers so the plan a tech reads is the computation
 * the commit performs.
 */
export function buildPressureTestPreview(
  bundle: JobBookBundle, file: Uint8Array, filename: string,
): PressureTestImportPreview {
  const read = readPressureLogGrid(file, filename)
  if (read.error) return { ok: false, error: read.error }
  if (read.grid.length === 0) return { ok: false, error: 'No rows found in that file.' }

  const parsed = parsePressureTestRows(read.grid, read.sheetsParsed[0] ?? 'Pressure Tests')
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      error: parsed.issues[0]?.message
        ?? 'No pressure tests could be read. The column headers did not match anything this reader knows.',
    }
  }

  const existing = new Set(
    bundle.pressureTests.map((t) => (t.testIdentifier ?? '').trim().toUpperCase()),
  )
  let create = 0
  let update = 0
  for (const r of parsed.rows) {
    if (existing.has(r.testIdentifier.trim().toUpperCase())) update += 1
    else create += 1
  }

  return {
    ok: true,
    plan: {
      format: read.format,
      sheetsParsed: read.sheetsParsed,
      parsedRows: parsed.rows.length,
      emptyRows: parsed.emptyRows.map((e) => ({
        testIdentifier: e.testIdentifier, rowNumber: e.rowNumber,
      })),
      testsToCreate: create,
      testsToUpdate: update,
      undated: parsed.rows.filter((r) => !r.testDate).length,
      pressureDropped: parsed.rows.filter(
        (r) => r.startPressurePsi != null && r.endPressurePsi != null &&
               r.endPressurePsi < r.startPressurePsi).length,
      issues: parsed.issues,
      rows: parsed.rows,
    },
  }
}

export interface StaffMember {
  id: string
  fullName: string
  email: string
  role: UserRole
  competencyLevel: CompetencyLevel | null
}

/** Facts a gate evaluation needs that the bundle does not carry. */
export interface GateSideFacts {
  custodianName: string | null
  custodianCompetency: CompetencyLevel | null
}

export interface GateDecision {
  gate: GateId
  outcome: GateOutcome
  criteria: CriterionResult[]
  completionPct: number
  projectManagerId?: string | null
  /** Conditional Pass only; the database caps it at ten calendar days. */
  conditionalDueAt?: string | null
  overrideNote?: string | null
  notes?: string | null
}

/** The demo/seed provider. Builds the reference book once per process. */
/**
 * The demo roster, with competency levels from FDS-JBMP-004.
 *
 * Deliberately mixed: one JB-4, one JB-3, one JB-2 and one unassessed, so
 * the Custodian picker demonstrates the refusal as well as the happy path.
 * A user with no assessed level is not a user at JB-1 — §5.1 treats the
 * two the same way for eligibility, and the app says which it is.
 */
/**
 * Parse a sheet and plan its import against one book.
 *
 * Shared by both providers so the seed demo and the live database agree
 * about what a given file would do — the preview a tech reads has to be
 * the same computation the commit performs.
 */
export function buildOverviewPreview(
  bundle: JobBookBundle, file: Uint8Array,
): OverviewImportPreview {
  let sheet: WeldLogOverview
  try {
    sheet = parseWeldLogOverviewPdf(file)
  } catch {
    return { ok: false, error: 'That file could not be read as a PDF.' }
  }
  if (sheet.parseIssues.length > 0 && sheet.welders.length === 0) {
    return { ok: false, error: sheet.parseIssues[0] }
  }

  const findings = checkWeldLogOverview(sheet, {
    constructionStart: bundle.book.constructionStart,
    constructionEnd: bundle.book.constructionEnd,
    recordedOperator: bundle.book.pipingSpecReference ?? bundle.clientOrg.name,
  })
  return { ok: true, sheet, plan: planOverviewIngest(sheet, bundle, findings) }
}

const SEED_STAFF: StaffMember[] = [
  { id: 'seed-user-manager', fullName: 'D. Devitt', email: 'qaqc.manager@fortressds.com',
    role: 'qaqc_manager', competencyLevel: 'JB-4' },
  { id: 'seed-user-auditor', fullName: 'M. Salas', email: 'peer.auditor@fortressds.com',
    role: 'qaqc_tech', competencyLevel: 'JB-3' },
  { id: 'seed-user-custodian', fullName: 'R. Vance', email: 'custodian@fortressds.com',
    role: 'qaqc_tech', competencyLevel: 'JB-2' },
  { id: 'seed-user-new', fullName: 'T. Okafor', email: 'new.tech@fortressds.com',
    role: 'qaqc_tech', competencyLevel: null },
]

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
  /** Flag resolutions, per process. See `resolveFlag`. */
  private flagStates = new Map<string,
    { state: string; note: string; by: string; at: string }>()

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

    // Uploading is evidence arriving, so the section is no longer
    // untouched. Whether its folder is still unread is a separate
    // question, and `afterUpload` is where that is decided.
    const sections = b.sections.map((x) =>
      x.id !== section.id ? x : {
        ...x,
        status: x.status === 'not_started' && added.length ? 'in_progress' as const : x.status,
        ingestionStatus: added.length ? afterUpload(x.ingestionStatus) : x.ingestionStatus,
      },
    )

    // Re-stamped, so the cached percentage moves with the evidence rather
    // than going stale the moment a file lands.
    const updated = applyComputedScores({ ...b, documents, sections })
    if (this.created.has(jobBookId)) this.created.set(jobBookId, updated)
    else if (this.cache) this.cache[idx] = updated

    return { ok: true, added, rejected }
  }

  private findSection(jobBookId: string, sectionNumber: string) {
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b) return null
    const def = b.sectionDefinitions.find((d) => d.sectionNumber === sectionNumber)
    const section = def && b.sections.find((x) => x.sectionDefinitionId === def.id)
    if (!def || !section) return null
    return { b, idx, def, section }
  }

  private commit(jobBookId: string, idx: number, updated: JobBookBundle) {
    const stamped = applyComputedScores(updated)
    if (this.created.has(jobBookId)) this.created.set(jobBookId, stamped)
    else if (this.cache) this.cache[idx] = stamped
  }

  async markSectionReady(
    viewer: Viewer, jobBookId: string, sectionNumber: string,
  ): Promise<ActionResult> {
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to work on this book.' }
    }
    const found = this.findSection(jobBookId, sectionNumber)
    if (!found) return { ok: false, error: 'Section not found.' }
    const { b, idx, section } = found
    if (section.status === 'approved') {
      return { ok: false, error: 'This section is already approved.' }
    }
    this.commit(jobBookId, idx, {
      ...b,
      sections: b.sections.map((x) => x.id !== section.id ? x : {
        ...x,
        status: 'ready_for_review' as const,
        readyForReviewBy: viewer.id,
        readyForReviewAt: new Date().toISOString(),
      }),
    })
    return { ok: true }
  }

  async approveSection(
    viewer: Viewer, jobBookId: string, sectionNumber: string,
  ): Promise<ActionResult> {
    const found = this.findSection(jobBookId, sectionNumber)
    if (!found) return { ok: false, error: 'Section not found.' }
    const { b, idx, section } = found

    // The same three refusals `approve_section()` makes, in the same order,
    // so the demo behaves like the real thing rather than merely looking
    // like it.
    if (!APPROVER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Section approval requires a QA/QC Manager or Admin.' }
    }
    if (section.readyForReviewBy === viewer.id) {
      return { ok: false, error: 'A section may not be approved by the person who submitted it.' }
    }
    if (section.status === 'na') {
      return { ok: false, error: 'This section is marked not applicable.' }
    }
    this.commit(jobBookId, idx, {
      ...b,
      sections: b.sections.map((x) => x.id !== section.id ? x : {
        ...x,
        status: 'approved' as const,
        approvedBy: viewer.id,
        approvedAt: new Date().toISOString(),
      }),
    })
    return { ok: true }
  }

  async resolveFlag(
    viewer: Viewer, jobBookId: string, fingerprint: string,
    state: 'resolved' | 'dismissed' | 'acknowledged', note: string,
  ): Promise<ActionResult> {
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to work on this book.' }
    }
    // Mirrors the resolution_has_note constraint. Auditors ask why a
    // finding was closed, and "it was closed" is not an answer.
    if (state !== 'acknowledged' && !note.trim()) {
      return { ok: false, error: 'A resolution needs a note saying why.' }
    }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    if (idx < 0) return { ok: false, error: 'Job book not found.' }

    // The seed provider holds no flag table — findings are derived on every
    // request. Resolutions are kept per process so the queue behaves, and
    // the persistent provider writes them properly.
    const key = `${jobBookId}:${fingerprint}`
    this.flagStates.set(key, { state, note: note.trim(), by: viewer.id, at: new Date().toISOString() })
    return { ok: true }
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

  // -- Gate reviews ------------------------------------------------------
  //
  // The seed provider is the reference book, and the reference books are
  // historical: DP452 was delivered and DP-318 was in progress long before
  // this program existed, so neither carries a gate decision. Returning an
  // empty list is the honest answer, and it is also the useful one — the
  // gate screen then shows what each gate WOULD say about a real book,
  // which is exactly what a crew being trained on the program needs to see.

  private gateReviews = new Map<string, GateReview[]>()

  async listGateReviews(viewer: Viewer, jobBookId: string): Promise<GateReview[]> {
    const b = this.all().find((x) => x.book.id === jobBookId)
    if (!b || !this.canSee(viewer, b)) return []
    // Fortress governance: a client sees the book, not the minutes of the
    // meeting where Fortress decided whether to let it advance.
    if (!WRITER_ROLES.has(viewer.role) && viewer.role !== 'fortress_read_only') return []
    return [...(this.gateReviews.get(jobBookId) ?? [])].sort(
      (x, y) => y.decidedAt.localeCompare(x.decidedAt),
    )
  }

  async gateContext(viewer: Viewer, jobBookId: string): Promise<GateSideFacts> {
    const b = this.all().find((x) => x.book.id === jobBookId)
    if (!b || !this.canSee(viewer, b) || !b.book.custodianId) {
      return { custodianName: null, custodianCompetency: null }
    }
    const staff = SEED_STAFF.find((u) => u.id === b.book.custodianId)
    return {
      custodianName: staff?.fullName ?? null,
      custodianCompetency: staff?.competencyLevel ?? null,
    }
  }

  async recordGateReview(
    viewer: Viewer, jobBookId: string, input: GateDecision,
  ): Promise<ActionResult> {
    // Mirrors `record_gate_review()`. The database is the control; every
    // check here exists so a chair meets the refusal before the round trip
    // rather than after it.
    if (!APPROVER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Only a QA/QC manager or admin may chair a gate review.' }
    }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }

    if (b.book.custodianId && b.book.custodianId === viewer.id) {
      return { ok: false, error: 'The Custodian of a book may not chair its gate review.' }
    }

    const unresolved = input.criteria.filter(
      (c) => c.state === 'not_met' || c.state === 'indeterminate',
    ).length
    if (input.outcome !== 'fail' && unresolved > 0 && !input.overrideNote?.trim()) {
      return {
        ok: false,
        error: `Gate ${input.gate} has ${unresolved} unmet or unevaluable criteria; an override note is required.`,
      }
    }
    if (input.outcome === 'conditional_pass' && !input.conditionalDueAt) {
      return { ok: false, error: 'A Conditional Pass carries a dated action list.' }
    }

    const existing = this.gateReviews.get(jobBookId) ?? []
    if (
      input.outcome === 'conditional_pass' &&
      existing.some((r) => r.gate === input.gate && r.outcome === 'conditional_pass')
    ) {
      return {
        ok: false,
        error: `A Conditional Pass may be issued once per gate (§7); ${input.gate} already carries one.`,
      }
    }

    const attempt = existing.filter((r) => r.gate === input.gate).length + 1
    const review: GateReview = {
      id: `gate-${jobBookId}-${input.gate}-${attempt}`,
      jobBookId,
      gate: input.gate,
      attempt,
      outcome: input.outcome,
      chairedBy: viewer.id,
      custodianId: b.book.custodianId ?? null,
      projectManagerId: input.projectManagerId ?? null,
      decidedAt: new Date().toISOString(),
      criteriaSnapshot: input.criteria,
      completionPct: input.completionPct,
      conditionalDueAt: input.conditionalDueAt ?? null,
      overrideNote: input.overrideNote?.trim() || null,
      notes: input.notes?.trim() || null,
    }
    this.gateReviews.set(jobBookId, [...existing, review])

    // Only a clean Pass advances the book, for the reason §7 gives: a
    // Conditional Pass that lapses becomes a Fail, and a book that had
    // already moved on would be standing past a gate it never passed.
    if (input.outcome === 'pass') {
      this.commit(jobBookId, idx, {
        ...b,
        book: { ...b.book, currentGate: input.gate, currentGateAt: review.decidedAt },
      })
    }
    return { ok: true }
  }

  async previewWeldLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<WeldLogImportPreview> {
    const b = this.all().find((x) => x.book.id === jobBookId)
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    return buildWeldLogPreview(b, file, filename)
  }

  async commitWeldLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<WeldLogImportResult> {
    const empty = { weldLinesCreated: 0, weldsCreated: 0, weldsUpdated: 0 }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.', ...empty }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }

    const preview = buildWeldLogPreview(b, file, filename)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the log.', ...empty }
    }

    let n = 0
    const rows = rowsForWeldPlan(preview.plan, b, {
      enteredAt: new Date().toISOString(),
      entrySource: 'field_entry',
      newId: () => `seed-line-${jobBookId}-${(n += 1)}`,
    })

    // Welds are keyed by a stable id derived from the weld number, so a
    // re-import replaces rather than duplicates — the same property the
    // database relies on.
    const byId = new Map(b.welds.map((w) => [w.id, w]))
    for (const w of rows.welds) byId.set(w.id, w)

    this.commit(jobBookId, idx, {
      ...b,
      weldLines: [...b.weldLines, ...rows.weldLines],
      welds: [...byId.values()],
    })

    return {
      ok: true,
      weldLinesCreated: rows.weldLines.length,
      weldsCreated: preview.plan.weldsToCreate,
      weldsUpdated: preview.plan.weldsToUpdate,
    }
  }

  async previewTorqueLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<TorqueLogImportPreview> {
    const b = this.all().find((x) => x.book.id === jobBookId)
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    return buildTorqueLogPreview(b, file, filename)
  }

  async commitTorqueLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<TorqueLogImportResult> {
    const empty = { connectionsCreated: 0, connectionsUpdated: 0 }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.', ...empty }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }

    const preview = buildTorqueLogPreview(b, file, filename)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the log.', ...empty }
    }

    const rows = rowsForTorquePlan(preview.plan, b, {
      enteredAt: new Date().toISOString(),
      entrySource: 'field_entry',
    })

    // Keyed on ISO number and flange, so a re-import of a corrected log
    // replaces the connection rather than filing a second one beside it.
    const byId = new Map(b.torqueConnections.map((c) => [c.id, c]))
    for (const c of rows.torqueConnections) byId.set(c.id, c)

    this.commit(jobBookId, idx, { ...b, torqueConnections: [...byId.values()] })

    return {
      ok: true,
      connectionsCreated: preview.plan.connectionsToCreate,
      connectionsUpdated: preview.plan.connectionsToUpdate,
    }
  }

  async previewPressureTestImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<PressureTestImportPreview> {
    const b = this.all().find((x) => x.book.id === jobBookId)
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    return buildPressureTestPreview(b, file, filename)
  }

  async commitPressureTestImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<PressureTestImportCommit> {
    const empty = { testsCreated: 0, testsUpdated: 0 }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.', ...empty }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }

    const preview = buildPressureTestPreview(b, file, filename)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the sheet.', ...empty }
    }

    const now = new Date().toISOString()
    const records = toPressureTestRecords(preview.plan.rows, { jobBookId })
      .map((t) => ({ ...t, enteredAt: now, entrySource: 'field_entry' as const }))
    const byId = new Map(b.pressureTests.map((t) => [t.id, t]))
    for (const t of records) byId.set(t.id, t)

    this.commit(jobBookId, idx, { ...b, pressureTests: [...byId.values()] })
    return {
      ok: true,
      testsCreated: preview.plan.testsToCreate,
      testsUpdated: preview.plan.testsToUpdate,
    }
  }

  async recordAudit(
    viewer: Viewer, jobBookId: string, input: AuditInput,
  ): Promise<ActionResult> {
    // Mirrors `record_peer_audit()`. The database is the control; this
    // exists so an auditor meets the refusal before the round trip.
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to record an audit on this book.' }
    }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }

    if (input.tier === 'tier_2_peer') {
      const auditor = SEED_STAFF.find((u) => u.id === input.auditorId)
      const check = canPeerAudit(b, input.auditorId, auditor?.competencyLevel ?? null)
      if (!check.ok) return { ok: false, error: check.reason }
    }
    if (input.tier === 'tier_3_manager' && !APPROVER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Tier 3 verification is the QA/QC Manager\'s (§10).' }
    }

    const existing = b.audits ?? []
    const attempt =
      existing.filter((a) => a.tier === input.tier)
        .reduce((m, a) => Math.max(m, a.attempt), 0) + 1
    const id = `audit-${jobBookId}-${input.tier}-${attempt}`
    const now = new Date().toISOString()

    // §10.3 decides the outcome, not the caller: any Critical fails the
    // audit outright whatever the score says.
    const verdict = scoreAudit(input.findings)
    const scored = input.tier === 'tier_2_peer'

    const audit: JobBookAudit = {
      id,
      jobBookId,
      tier: input.tier,
      attempt,
      auditorId: input.auditorId,
      startedAt: now,
      completedAt: now,
      outcome: scored ? (verdict.passes ? 'pass' : 'fail') : 'pass',
      score: scored ? verdict.score : null,
      samplePlan: input.samplePlan ?? null,
      lotSize: input.lotSize ?? null,
      sampleSize: input.sampleSize ?? null,
      doubleSample: input.doubleSample ?? false,
      notes: input.notes ?? null,
    }

    const findings: AuditFinding[] = input.findings.map((f, i) => ({
      id: `${id}-f${i + 1}`,
      auditId: id,
      classification: f.classification,
      sectionNumber: f.sectionNumber ?? null,
      summary: f.summary,
      detail: f.detail ?? null,
      dueAt: f.dueAt ?? null,
    }))

    this.commit(jobBookId, idx, {
      ...b,
      audits: [...existing, audit],
      auditFindings: [...(b.auditFindings ?? []), ...findings],
    })
    return { ok: true }
  }

  async certifyCompleteness(
    viewer: Viewer, jobBookId: string, statement: string | null,
  ): Promise<ActionResult> {
    if (!APPROVER_ROLES.has(viewer.role)) {
      return {
        ok: false,
        error: 'The Completeness Certification is signed by the QA/QC manager or an admin (§10.4).',
      }
    }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }

    // Derived, not read off the bundle. This provider builds its books
    // from the seed and never stores a flag register, so reading one
    // would find `undefined` — and `?? []` would then turn "nobody
    // looked" into "there are none" and sign a book with open
    // Criticals. The flags engine is what knows.
    // No state filter: a derived finding is open by construction. It
    // exists because the data still says so, and it stops existing when
    // the data stops saying so — there is nothing here to resolve.
    const open = aggregateFindings(evaluateFlags(b))
    const criticals = open.filter((f) => f.severity === 'critical').length
    const majors = open.filter((f) => f.severity === 'warning').length
    if (criticals > 0 || majors > 0) {
      return {
        ok: false,
        error: `Gate 4 requires zero open Critical and zero open Major findings; this book has ` +
          `${criticals} Critical and ${majors} Major.`,
      }
    }

    const score = scoreBook(b)
    const counted = b.sections.filter((s) => s.status !== 'na')

    this.commit(jobBookId, idx, {
      ...b,
      completenessCertification: {
        jobBookId,
        certifiedBy: viewer.id,
        certifiedAt: new Date().toISOString(),
        // The figures as they stand at signature, not a pointer to
        // today's. A certification that merely pointed at the current
        // numbers would certify nothing.
        completionPct: score.overallPct,
        sectionsTotal: counted.length,
        sectionsApproved: counted.filter((s) => s.status === 'approved').length,
        openCritical: 0,
        openMajor: 0,
        statement,
      },
    })
    return { ok: true }
  }

  async assignCustodian(
    viewer: Viewer, jobBookId: string, userId: string,
  ): Promise<ActionResult> {
    if (!APPROVER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Only a QA/QC manager or admin may assign a Custodian.' }
    }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }

    const staff = SEED_STAFF.find((u) => u.id === userId)
    if (!staff) return { ok: false, error: 'No such active user.' }
    // Null is "not assessed", and not assessed is not qualified.
    if (!staff.competencyLevel || staff.competencyLevel === 'JB-1') {
      return {
        ok: false,
        error: `Custodian requires competency JB-2 or above (§5.1); ${staff.fullName} holds ${staff.competencyLevel ?? 'no assessed level'}.`,
      }
    }
    this.commit(jobBookId, idx, {
      ...b,
      book: {
        ...b.book,
        custodianId: userId,
        custodianAssignedAt: new Date().toISOString(),
      },
    })
    return { ok: true }
  }

  async listStaff(viewer: Viewer): Promise<StaffMember[]> {
    if (!WRITER_ROLES.has(viewer.role)) return []
    return SEED_STAFF
  }


  // -- Record ingestion --------------------------------------------------

  async previewOverviewImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array,
  ): Promise<OverviewImportPreview> {
    const b = this.all().find((x) => x.book.id === jobBookId)
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.' }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    return buildOverviewPreview(b, file)
  }

  async commitOverviewImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<OverviewImportResult> {
    void filename
    const empty = {
      weldersCreated: 0, weldersMatched: 0, qualificationsRecorded: 0,
      peopleCreated: 0, skipped: [] as { stamp: string; reason: string }[],
    }
    const idx = this.all().findIndex((x) => x.book.id === jobBookId)
    const b = this.all()[idx]
    if (!b || !this.canSee(viewer, b)) return { ok: false, error: 'Job book not found.', ...empty }
    if (!WRITER_ROLES.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }

    const preview = buildOverviewPreview(b, file)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the sheet.', ...empty }
    }

    let n = 0
    const rows = rowsForPlan(preview.plan, {
      enteredAt: new Date().toISOString(),
      // Entered through the application against a sheet the crew produced,
      // so §8 can measure it. A migration of a delivered book is the other
      // kind, and the two are not conflated.
      entrySource: 'field_entry',
      newId: () => `seed-import-${jobBookId}-${(n += 1)}`,
    })

    this.commit(jobBookId, idx, {
      ...b,
      welders: [...b.welders, ...rows.welders],
      welderQualifications: [...b.welderQualifications, ...rows.qualifications],
      cwis: [...b.cwis, ...rows.cwis],
      ndtTechnicians: [...b.ndtTechnicians, ...rows.ndtTechnicians],
    })

    return {
      ok: true,
      weldersCreated: rows.welders.length,
      weldersMatched: preview.plan.summary.weldersMatched,
      qualificationsRecorded: rows.qualifications.length,
      peopleCreated: rows.cwis.length + rows.ndtTechnicians.length,
      skipped: preview.plan.welders
        .filter((w) => w.action === 'skip')
        .map((w) => ({ stamp: w.stamp || w.name, reason: w.skipReason ?? '' })),
    }
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

/**
 * Which provider is serving this process.
 *
 * `seed` is the in-memory reference book — no database, no credentials,
 * every screen reachable. `supabase` is the persistent one. The default is
 * deliberately `seed`: a missing environment variable should start a
 * working demo, not a broken production instance that appears to lose
 * every upload.
 */
export function providerKind(): 'seed' | 'supabase' {
  return process.env.DATA_PROVIDER === 'supabase' ? 'supabase' : 'seed'
}

export function getDataProvider(): DataProvider {
  if (provider) return provider
  if (providerKind() === 'supabase') {
    // Required at the point of use rather than imported at module load, so
    // a seed-mode process never evaluates the Supabase client and never
    // needs its environment variables.

    const { SupabaseProvider } = require('./supabaseProvider') as
      typeof import('./supabaseProvider')
    provider = new SupabaseProvider()
    return provider
  } else {
    provider = new SeedProvider()
  }
  return provider
}

/**
 * The viewer for the current request.
 *
 * In `supabase` mode this is the signed-in user, resolved from the session
 * cookie through `app_user`; a request with no session gets null and the
 * caller sends them to sign in. In `seed` mode there is no auth and no
 * database, so the demo viewer stands in — which is safe precisely because
 * seed mode holds no real book.
 *
 * Nothing downstream may assume a viewer: returning null is how an
 * unauthenticated request is supposed to end.
 */
export async function currentViewer(): Promise<Viewer | null> {
  if (providerKind() !== 'supabase') return DEMO_VIEWER

  const { getViewer } = await import('@/lib/supabase/server')
  return getViewer()
}

/** The stand-in viewer for seed mode. Never reached when a database is
 *  configured — see `currentViewer`. */
export const DEMO_VIEWER: Viewer = {
  id: 'user-mgr-1',
  email: 'david.devitt@fortressds.com',
  fullName: 'David Devitt',
  role: 'qaqc_manager',
  clientOrgId: null,
}
