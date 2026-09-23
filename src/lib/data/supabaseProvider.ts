/**
 * The persistent data provider.
 *
 * Every query here runs through the caller's own Supabase session, so Row
 * Level Security is in force on every statement. That is not a convention
 * this file follows — it is the security model. `supabase/tests/security.sql`
 * proves the policies hold against a real Postgres: a client user reaches
 * one operator's books and no others, the audit trail cannot be rewritten
 * even by an admin, and a section cannot be approved by the person who
 * submitted it. None of those depend on this file being correct.
 *
 * So the role checks that appear below are courtesy, not control. They stop
 * a read-only viewer reaching a button whose write the database would
 * refuse anyway, and they produce a sentence a person can act on instead of
 * a PostgREST error code.
 */
import type {
  CompetencyLevel, GateReview, JobBookBundle, UserRole,
} from '@/lib/domain/types'
import type {
  ActionResult, AuditInput, BookNote, CreateResult, DataProvider, DirectoryUser,
  GateDecision, GateSideFacts, GrantInput, InspectorGrant, InviteInput,
  NoteInput, NotificationItem,
  PressureTestImportCommit, PressureTestImportPreview,
  JobBookSummary, OverviewImportPreview, OverviewImportResult, StaffMember,
  TorqueLogImportPreview, TorqueLogImportResult,
  UploadResult, Viewer, WeldLogImportPreview, WeldLogImportResult,
} from './provider'
import { can, rolesWith } from '@/lib/domain/roles'
import type { NoteSeverity } from '@/lib/domain/notifications'
import {
  buildOverviewPreview, buildPressureTestPreview, buildTorqueLogPreview,
  buildWeldLogPreview, redactForViewer, summarizeBook,
} from './provider'
import { rowsForPlan } from '@/lib/import/overviewIngest'
import { rowsForWeldPlan } from '@/lib/import/weldLogIngest'
import { rowsForTorquePlan } from '@/lib/import/torqueLogIngest'
import { toPressureTestRecords } from '@/lib/import/pressureTestLog'
import { randomUUID } from 'node:crypto'
import { scaffoldJobBook, validateNewJobBook, type NewJobBookInput } from '@/lib/domain/scaffold'
import { afterUpload, applyComputedScores, scoreBook } from '@/lib/domain/scoring'
import { aggregateFindings, countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import { latestOfTier, scoreAudit } from '@/lib/domain/audits'
import { previewUploads, type PrepareInput } from '@/lib/domain/upload'
import { createClient } from '@/lib/supabase/server'
import { COLUMNS, domainToRow, rowToDomain, rowsToDomain } from './rowMap'
import { DOCUMENT_BUCKET } from '@/lib/supabase/storage'

/** Statuses at or past hand-over. Countdowns stop here. */
const DELIVERED_STATUSES = new Set(['submitted', 'accepted', 'archived'])
// Derived from the capability table, not listed again. See the note on
// WRITER_ROLES in provider.ts: roles.test.ts pins the table to the RLS
// predicate text, so reading it here puts this file inside that check.
const WRITERS: ReadonlySet<UserRole> =
  new Set(rolesWith('edit_records').map((r) => r.role))
const BOOK_CREATORS: ReadonlySet<UserRole> =
  new Set(rolesWith('create_book').map((r) => r.role))

type Client = Awaited<ReturnType<typeof createClient>>

/**
 * Tables that hang off a job book, and the domain key each fills.
 *
 * Driven by a table rather than thirty hand-written awaits so a new entity
 * is one row here. `live` marks the tables carrying `deleted_at`: a soft
 * delete must not come back in a bundle, and ten of these tables have no
 * such column at all — the audit trigger learned that the hard way.
 */
const BOOK_TABLES = [
  { table: 'job_book_section',  key: 'sections',              live: false },
  { table: 'document',          key: 'documents',             live: true  },
  { table: 'weld_line',         key: 'weldLines',             live: true  },
  { table: 'weld',              key: 'welds',                 live: true  },
  { table: 'certificate',       key: 'certificates',          live: true  },
  { table: 'nde_report',        key: 'ndeReports',            live: true  },
  { table: 'material_heat',     key: 'materialHeats',         live: true  },
  { table: 'pressure_test',     key: 'pressureTests',         live: true  },
  { table: 'cp_test_point',     key: 'cpTestPoints',          live: true  },
  { table: 'ut_reading',        key: 'utReadings',            live: true  },
  { table: 'torque_connection', key: 'torqueConnections',     live: true  },
  { table: 'coating_inspection', key: 'coatingInspections',   live: true  },
  // The NCR register. Loaded with the book because gate criteria ask
  // "zero open NCRs past due date", and a criterion that cannot see the
  // register reports indeterminate rather than compliant.
  { table: 'compliance_flag',   key: 'complianceFlags',       live: false },
  // The §10 audit history. Loaded with the book for the same reason the
  // NCR register is: five gate criteria ask about audits, and one that
  // cannot see the history reports indeterminate rather than compliant.
  { table: 'job_book_audit',    key: 'audits',                live: false },
] as const

/** Tables shared across books rather than owned by one. */
const GLOBAL_TABLES = [
  { table: 'welder',               key: 'welders',               live: true },
  { table: 'welder_qualification', key: 'welderQualifications',  live: true },
  { table: 'cwi',                  key: 'cwis',                  live: true },
  { table: 'ndt_technician',       key: 'ndtTechnicians',        live: true },
  { table: 'torque_wrench',        key: 'torqueWrenches',        live: true },
] as const

export class SupabaseProvider implements DataProvider {
  async listJobBooks(viewer: Viewer): Promise<JobBookSummary[]> {
    const supabase = await createClient()

    // RLS already limits this to books the viewer may see, so there is no
    // `where client_org_id = …` here and there must not be: adding one
    // would imply the filter is this file's job, and the day it drifts
    // from the policy the policy is what still holds.
    const { data: books, error } = await supabase
      .from('job_book')
      .select('id, project_id')
      .is('deleted_at', null)
      .order('job_number')
    if (error || !books?.length) return []

    const { data: projects } = await supabase
      .from('project').select('id, name, client_org:client_org_id(id, name)')
      .in('id', books.map((b) => b.project_id as string))
    const orgByProject = new Map(
      (projects ?? []).map((p) => {
        const org = p.client_org as unknown as { id: string; name: string } | null
        return [p.id as string, org?.name ?? 'Unknown operator']
      }),
    )

    // A full bundle per book, and then the same engine the book's own
    // pages run.
    //
    // This replaced a cheaper version that read cached per-section
    // percentages and counted rows in `compliance_flag`. The cheap
    // version was wrong: that table is a resolution ledger, written only
    // when somebody resolves a finding, so the critical count on every
    // card was structurally zero. A dashboard that disagrees with the
    // page it links to is worse than no dashboard — see `summarizeBook`.
    //
    // The cost is real and worth naming: one bundle per book, each of
    // which is roughly twenty queries. Parallel, so it is latency rather
    // than a long serial wait, and fine at the tens of books this runs
    // against. If the portfolio ever reaches hundreds, the answer is to
    // persist derived findings the way section scores already are —
    // NOT to go back to reading a table that does not hold them.
    const summaries = await Promise.all(books.map(async (b) => {
      const bundle = await this.getBundle(viewer, b.id as string)
      if (!bundle) return null
      return summarizeBook(
        bundle, orgByProject.get(b.project_id as string) ?? 'Unknown operator')
    }))

    return summaries
      .filter((s): s is JobBookSummary => s !== null)
      .sort((a, c) => a.jobNumber.localeCompare(c.jobNumber))
  }

  async getBundle(viewer: Viewer, jobBookId: string): Promise<JobBookBundle | null> {
    const supabase = await createClient()

    const { data: book } = await supabase
      .from('job_book').select('*').eq('id', jobBookId).is('deleted_at', null).maybeSingle()
    // Not found and not permitted are the same answer on purpose. Telling
    // a client user that DP-318 exists but is not theirs leaks the client
    // list, which is the thing RLS is here to protect.
    if (!book) return null

    const { data: project } = await supabase
      .from('project').select('*').eq('id', book.project_id as string).maybeSingle()
    const { data: org } = project
      ? await supabase.from('client_org').select('*')
          .eq('id', project.client_org_id as string).maybeSingle()
      : { data: null }

    const { data: defs } = await supabase
      .from('section_definition').select('*')
      .eq('book_template_id', book.book_template_id as string)
      .order('sort_order')

    const scoped = await Promise.all(
      BOOK_TABLES.map(async ({ table, key, live }) => {
        let q = supabase.from(table).select('*').eq('job_book_id', jobBookId)
        if (live) q = q.is('deleted_at', null)
        const { data } = await q
        return [key, rowsToDomain(data)] as const
      }),
    )
    const global = await Promise.all(
      GLOBAL_TABLES.map(async ({ table, key, live }) => {
        let q = supabase.from(table).select('*')
        if (live) q = q.is('deleted_at', null)
        const { data } = await q
        return [key, rowsToDomain(data)] as const
      }),
    )

    // Findings hang off the audit, not the book, so they cannot ride in
    // BOOK_TABLES. Fetched by audit id rather than by a join so an empty
    // audit history costs no query at all.
    const auditIds = (
      (Object.fromEntries(scoped).audits as { id: string }[] | undefined) ?? []
    ).map((a) => a.id)
    const [findings, certification] = await Promise.all([
      auditIds.length
        ? supabase.from('audit_finding').select('*').in('audit_id', auditIds)
        : Promise.resolve({ data: [] as unknown[] }),
      supabase.from('completeness_certification').select('*')
        .eq('job_book_id', jobBookId).maybeSingle(),
    ])

    const bundle = {
      book: rowToDomain<JobBookBundle['book']>(book),
      project: project ? rowToDomain<JobBookBundle['project']>(project)
        : { id: '', clientOrgId: '', name: '' },
      clientOrg: org ? rowToDomain<JobBookBundle['clientOrg']>(org)
        : { id: '', name: 'Unknown operator' },
      sectionDefinitions: rowsToDomain<JobBookBundle['sectionDefinitions'][number]>(defs),
      ...Object.fromEntries([...scoped, ...global]),
      auditFindings: rowsToDomain(findings.data as Record<string, unknown>[] | null),
      // `null` rather than `undefined`: the query ran, and this book has
      // no certification. The gate engine reads the two differently.
      completenessCertification: certification.data
        ? rowToDomain<NonNullable<JobBookBundle['completenessCertification']>>(
            certification.data as Record<string, unknown>,
          )
        : null,
    } as JobBookBundle

    // Stamped before redaction, never after: the cached percentage a client
    // reads has to be the one computed from the complete record, and a
    // redacted bundle no longer holds the evidence to compute it.
    return redactForViewer(viewer, applyComputedScores(bundle))
  }

  async listClientOrgs(viewer: Viewer): Promise<{ id: string; name: string }[]> {
    const supabase = await createClient()
    const { data } = await supabase
      .from('client_org').select('id, name').is('deleted_at', null).order('name')
    return (data ?? []).map((o) => ({ id: o.id as string, name: o.name as string }))
  }

  async markSectionReady(
    viewer: Viewer, jobBookId: string, sectionNumber: string,
  ): Promise<ActionResult> {
    const supabase = await createClient()
    const found = await this.sectionRow(supabase, viewer, jobBookId, sectionNumber)
    if ('error' in found) return { ok: false, error: found.error }

    const { error } = await supabase.from('job_book_section').update({
      status: 'ready_for_review',
      ready_for_review_by: viewer.id,
      ready_for_review_at: new Date().toISOString(),
    }).eq('id', found.id)

    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  async approveSection(
    viewer: Viewer, jobBookId: string, sectionNumber: string,
  ): Promise<ActionResult> {
    const supabase = await createClient()
    const found = await this.sectionRow(supabase, viewer, jobBookId, sectionNumber)
    if ('error' in found) return { ok: false, error: found.error }

    // Through the function, never a direct UPDATE. The two-person rule and
    // the role check live inside it, and it writes the audit row.
    const { error } = await supabase.rpc('approve_section', { p_section_id: found.id })
    if (!error) {
      await this.refreshScores(jobBookId, viewer)
      return { ok: true }
    }
    // The function raises in the words an auditor would use; pass them
    // through rather than replacing them with something vaguer.
    return { ok: false, error: error.message.replace(/^.*?:\s*/, '') }
  }

  async resolveFlag(
    viewer: Viewer, jobBookId: string, fingerprint: string,
    state: 'resolved' | 'dismissed' | 'acknowledged', note: string,
  ): Promise<ActionResult> {
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to work on this book.' }
    }
    if (state !== 'acknowledged' && !note.trim()) {
      return { ok: false, error: 'A resolution needs a note saying why.' }
    }
    const supabase = await createClient()

    // Findings are derived, not stored, so the row may not exist yet. The
    // upsert is keyed on (job_book_id, fingerprint) — the same stable
    // fingerprint the engine produces — so resolving the same finding twice
    // updates one row rather than making two.
    const { error } = await supabase.from('compliance_flag').upsert({
      job_book_id: jobBookId,
      fingerprint,
      state,
      resolution_note: state === 'acknowledged' ? null : note.trim(),
      resolved_by: state === 'acknowledged' ? null : viewer.id,
      resolved_at: state === 'acknowledged' ? null : new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'job_book_id,fingerprint' })

    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  /** The section row id for a book + section number, or why not. */
  private async sectionRow(
    supabase: Client, viewer: Viewer, jobBookId: string, sectionNumber: string,
  ): Promise<{ id: string } | { error: string }> {
    if (!WRITERS.has(viewer.role)) return { error: 'Not permitted to work on this book.' }

    const { data } = await supabase
      .from('job_book')
      .select('book_template_id')
      .eq('id', jobBookId)
      .maybeSingle()
    if (!data) return { error: 'Job book not found.' }

    const { data: def } = await supabase
      .from('section_definition').select('id')
      .eq('book_template_id', data.book_template_id as string)
      .eq('section_number', sectionNumber)
      .maybeSingle()
    if (!def) return { error: `No section ${sectionNumber} in this book.` }

    const { data: section } = await supabase
      .from('job_book_section').select('id')
      .eq('job_book_id', jobBookId)
      .eq('section_definition_id', def.id as string)
      .maybeSingle()
    if (!section) return { error: `Section ${sectionNumber} is not on this book.` }

    return { id: section.id as string }
  }

  async createJobBook(viewer: Viewer, input: NewJobBookInput): Promise<CreateResult> {
    if (!BOOK_CREATORS.has(viewer.role)) {
      return { ok: false, errors: [{ field: 'role', message: 'Only a QA/QC Manager or Admin may create a job book.' }] }
    }
    const { errors, warnings } = validateNewJobBook(input)
    if (errors.length) return { ok: false, errors, warnings }

    const supabase = await createClient()
    const { book, sections, weldLines } = scaffoldJobBook(input, () => crypto.randomUUID())

    // The book and its sections must arrive together or not at all: a book
    // with no sections scores 0% against nothing and looks like a real
    // book. `create_job_book()` does this in one transaction; PostgREST
    // cannot, so the failure path cleans up after itself.
    const { error: bookErr } = await supabase
      .from('job_book')
      .insert(domainToRow({ ...book, createdBy: viewer.id }, COLUMNS.job_book))
    if (bookErr) {
      return { ok: false, errors: [{ field: 'book', message: describe(bookErr) }] }
    }

    const { error: secErr } = await supabase
      .from('job_book_section')
      .insert(sections.map((s) => domainToRow(s, COLUMNS.job_book_section)))
    if (secErr) {
      await supabase.from('job_book').delete().eq('id', book.id)
      return { ok: false, errors: [{ field: 'sections', message: describe(secErr) }] }
    }

    if (weldLines.length) {
      const { error } = await supabase
        .from('weld_line').insert(weldLines.map((l) => domainToRow(l, COLUMNS.weld_line)))
      if (error) {
        await supabase.from('job_book_section').delete().eq('job_book_id', book.id)
        await supabase.from('job_book').delete().eq('id', book.id)
        return { ok: false, errors: [{ field: 'weldLines', message: describe(error) }] }
      }
    }

    return { ok: true, jobBookId: book.id, warnings }
  }

  async addDocuments(
    viewer: Viewer,
    jobBookId: string,
    sectionNumber: string,
    files: PrepareInput[],
  ): Promise<UploadResult> {
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, added: [], rejected: [], error: 'Not permitted to upload to this book.' }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, added: [], rejected: [], error: 'Job book not found.' }

    const def = bundle.sectionDefinitions.find((d) => d.sectionNumber === sectionNumber)
    const section = def && bundle.sections.find((s) => s.sectionDefinitionId === def.id)
    if (!def || !section) {
      return { ok: false, added: [], rejected: [], error: `No section ${sectionNumber} in this book.` }
    }

    // Checked against the book as it is now, not as the preview saw it.
    const preview = previewUploads(files, {
      book: bundle.book, section: def, sectionId: section.id,
      existing: bundle.documents, expectedCount: section.expectedCount ?? null,
    })

    const supabase = await createClient()
    const added: UploadResult['added'] = []
    const rejected: UploadResult['rejected'] = []
    const now = new Date().toISOString()

    for (const p of preview.files) {
      if (!p.willBeAdded) {
        rejected.push({
          originalFilename: p.originalFilename,
          reason: p.issues.find((i) => i.blocking)?.message ?? 'Rejected.',
        })
        continue
      }
      const bytes = files.find((f) => f.sha256 === p.sha256)?.bytes
      if (!bytes) {
        rejected.push({ originalFilename: p.originalFilename, reason: 'File content was not received.' })
        continue
      }

      // Content-addressed: the same bytes land on the same path, so a
      // retry after a half-finished request overwrites rather than
      // orphaning. The row is what makes a document exist, and it is
      // written second — an object with no row is invisible, a row with no
      // object is a broken download.
      const storagePath = `${jobBookId}/${sectionNumber}/${p.sha256}`
      const up = await supabase.storage.from(DOCUMENT_BUCKET).upload(storagePath, bytes, {
        contentType: p.mimeType ?? 'application/octet-stream',
        upsert: true,
      })
      if (up.error) {
        rejected.push({ originalFilename: p.originalFilename, reason: `Storage: ${up.error.message}` })
        continue
      }

      if (p.supersedesDocumentId) {
        await supabase.from('document')
          .update({ is_superseded: true }).eq('id', p.supersedesDocumentId)
      }

      const { error } = await supabase.from('document').insert(domainToRow({
        id: crypto.randomUUID(),
        jobBookId, sectionId: section.id,
        originalFilename: p.originalFilename,
        normalizedFilename: p.normalizedFilename,
        storagePath, mimeType: p.mimeType, byteSize: p.byteSize, sha256: p.sha256,
        version: p.version, supersedesDocumentId: p.supersedesDocumentId,
        isSuperseded: false, visibility: 'internal',
        uploadedBy: viewer.id, uploadedAt: now,
      }, COLUMNS.document))

      if (error) {
        // Leave no object behind that no row points at.
        await supabase.storage.from(DOCUMENT_BUCKET).remove([storagePath])
        rejected.push({ originalFilename: p.originalFilename, reason: describe(error) })
        continue
      }
      added.push({
        originalFilename: p.originalFilename,
        normalizedFilename: p.normalizedFilename,
        sha256: p.sha256,
      })
    }

    if (added.length) {
      await supabase.from('job_book_section').update({
        status: section.status === 'not_started' ? 'in_progress' : section.status,
        ingestion_status: afterUpload(section.ingestionStatus),
      }).eq('id', section.id)
      await this.refreshScores(jobBookId, viewer)
    }
    return { ok: true, added, rejected }
  }

  /**
   * Recompute the cached section percentages after a write.
   *
   * The cache is what `client_section_v` hands an operator, so leaving it
   * behind means staff and client read two different books off one dataset.
   * `set_section_score()` stamps `computed_at` itself rather than trusting
   * a caller, so a hand-edited percentage cannot pass as a computed one.
   */
  private async refreshScores(jobBookId: string, viewer: Viewer): Promise<void> {
    const supabase = await createClient()
    const fresh = await this.getBundle(viewer, jobBookId)
    if (!fresh) return
    const score = scoreBook(fresh)
    const defsById = new Map(fresh.sectionDefinitions.map((d) => [d.id, d]))
    await Promise.all(fresh.sections.map((s) => {
      const def = defsById.get(s.sectionDefinitionId)
      const sc = def && score.sections.find((x) => x.sectionNumber === def.sectionNumber)
      if (!sc) return Promise.resolve()
      return supabase.rpc('set_section_score', {
        p_section_id: s.id,
        p_pct: sc.pct,
        p_collected_pct: sc.collectedPct ?? sc.pct,
      })
    }))
  }

  // -- Gate reviews, FDS-JBMP-001 §7 -------------------------------------

  async listGateReviews(viewer: Viewer, jobBookId: string): Promise<GateReview[]> {
    void viewer
    const supabase = await createClient()
    // RLS restricts gate_review to Fortress staff on a readable book, so
    // an unauthorised caller gets an empty list rather than a refusal —
    // the same answer as a book that has had no gate review.
    const { data } = await supabase
      .from('gate_review').select('*')
      .eq('job_book_id', jobBookId)
      .order('decided_at', { ascending: false })
    return rowsToDomain<GateReview>(data)
  }

  async gateContext(viewer: Viewer, jobBookId: string): Promise<GateSideFacts> {
    void viewer
    const supabase = await createClient()
    const { data: book } = await supabase
      .from('job_book').select('custodian_id').eq('id', jobBookId).maybeSingle()
    const custodianId = book?.custodian_id as string | undefined
    if (!custodianId) return { custodianName: null, custodianCompetency: null }

    const { data: user } = await supabase
      .from('app_user').select('full_name, competency_level')
      .eq('id', custodianId).maybeSingle()
    return {
      custodianName: (user?.full_name as string | undefined) ?? null,
      // Absent and unassessed are both null here, and the gate engine
      // reports either as indeterminate rather than as unqualified.
      custodianCompetency: (user?.competency_level as CompetencyLevel | null) ?? null,
    }
  }

  async recordGateReview(
    viewer: Viewer, jobBookId: string, input: GateDecision,
  ): Promise<ActionResult> {
    if (!BOOK_CREATORS.has(viewer.role)) {
      return { ok: false, error: 'Only a QA/QC manager or admin may chair a gate review.' }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('record_gate_review', {
      p_book: jobBookId,
      p_gate: input.gate,
      p_outcome: input.outcome,
      // The criteria travel as they were evaluated. `record_gate_review`
      // counts the unmet ones itself rather than trusting a flag from the
      // caller, so a client cannot talk a gate through by mislabelling
      // what it found.
      p_criteria: input.criteria,
      p_completion_pct: input.completionPct,
      p_project_manager: input.projectManagerId ?? null,
      p_conditional_due: input.conditionalDueAt ?? null,
      p_override_note: input.overrideNote ?? null,
      p_notes: input.notes ?? null,
    })
    if (error) {
      // The function raises in the words an auditor would use.
      return { ok: false, error: error.message.replace(/^.*?:\s*/, '') }
    }
    return { ok: true }
  }

  async assignCustodian(
    viewer: Viewer, jobBookId: string, userId: string,
  ): Promise<ActionResult> {
    if (!BOOK_CREATORS.has(viewer.role)) {
      return { ok: false, error: 'Only a QA/QC manager or admin may assign a Custodian.' }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('assign_custodian', {
      p_book: jobBookId, p_user: userId,
    })
    if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, '') }
    return { ok: true }
  }

  // -- Record ingestion --------------------------------------------------

  async previewOverviewImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array,
  ): Promise<OverviewImportPreview> {
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.' }
    return buildOverviewPreview(bundle, file)
  }

  async commitOverviewImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<OverviewImportResult> {
    void filename
    const empty = {
      weldersCreated: 0, weldersMatched: 0, qualificationsRecorded: 0,
      peopleCreated: 0, skipped: [] as { stamp: string; reason: string }[],
    }
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }

    // Re-planned here against the book as it stands NOW, never taken from
    // the browser. Two techs importing the same sheet a minute apart both
    // passed a preview built before the other committed, and the register
    // must not gain the same welder twice because of it.
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.', ...empty }
    const preview = buildOverviewPreview(bundle, file)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the sheet.', ...empty }
    }

    const rows = rowsForPlan(preview.plan, {
      enteredAt: new Date().toISOString(),
      entrySource: 'field_entry',
      newId: () => randomUUID(),
    })

    const supabase = await createClient()

    // The registers are shared across books, so a welder already on file
    // from another job is matched rather than duplicated — `initials` is
    // unique, and an upsert on it is what makes re-importing the same
    // sheet a no-op instead of a second roster.
    if (rows.welders.length > 0) {
      const { error } = await supabase.from('welder').upsert(
        rows.welders.map((w) => domainToRow(w, COLUMNS.welder)),
        { onConflict: 'initials', ignoreDuplicates: false },
      )
      if (error) return { ok: false, error: describe(error), ...empty }
    }

    if (rows.qualifications.length > 0) {
      // Re-resolve welder ids: an upsert on an existing stamp keeps the
      // row that was already there, so the id generated a moment ago is
      // not necessarily the one on file.
      const stamps = rows.welders.map((w) => w.initials)
      const { data: onFile } = await supabase
        .from('welder').select('id, initials').in('initials', stamps)
      const idByStamp = new Map(
        (onFile ?? []).map((w) => [w.initials as string, w.id as string]),
      )
      const remap = new Map(rows.welders.map((w) => [w.id, idByStamp.get(w.initials) ?? w.id]))

      const { error } = await supabase.from('welder_qualification').insert(
        rows.qualifications.map((q) => domainToRow(
          { ...q, welderId: remap.get(q.welderId) ?? q.welderId, source: 'overview_sheet' },
          COLUMNS.welder_qualification,
        )),
      )
      if (error) return { ok: false, error: describe(error), ...empty }
    }

    for (const [table, list, columns] of [
      ['cwi', rows.cwis, COLUMNS.cwi],
      ['ndt_technician', rows.ndtTechnicians, COLUMNS.ndt_technician],
    ] as const) {
      if (list.length === 0) continue
      const { error } = await supabase.from(table).insert(
        list.map((p) => domainToRow(p, columns)),
      )
      if (error) return { ok: false, error: describe(error), ...empty }
    }

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

  async previewWeldLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<WeldLogImportPreview> {
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.' }
    return buildWeldLogPreview(bundle, file, filename)
  }

  async commitWeldLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<WeldLogImportResult> {
    const empty = { weldLinesCreated: 0, weldsCreated: 0, weldsUpdated: 0 }
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.', ...empty }

    // Re-planned against the book as it stands now, never taken from the
    // browser. A plan supplied by a client is a client asserting what is
    // in a document it also supplied.
    const preview = buildWeldLogPreview(bundle, file, filename)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the log.', ...empty }
    }

    const rows = rowsForWeldPlan(preview.plan, bundle, {
      enteredAt: new Date().toISOString(),
      entrySource: 'field_entry',
      newId: () => randomUUID(),
    })

    const supabase = await createClient()

    if (rows.weldLines.length > 0) {
      const { error } = await supabase.from('weld_line').insert(
        rows.weldLines.map((l) => domainToRow(l, COLUMNS.weld_line)),
      )
      if (error) return { ok: false, error: describe(error), ...empty }
    }

    // `facilityWeldRecordId` derives the id from the book and the weld
    // number, so re-importing a corrected log updates the same rows rather
    // than laying a second copy of the book beside the first.
    const CHUNK = 500
    for (let i = 0; i < rows.welds.length; i += CHUNK) {
      const { error } = await supabase.from('weld').upsert(
        rows.welds.slice(i, i + CHUNK).map((w) => domainToRow(w, COLUMNS.weld)),
        { onConflict: 'id' },
      )
      if (error) return { ok: false, error: describe(error), ...empty }
    }

    await this.refreshScores(jobBookId, viewer)

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
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.' }
    return buildTorqueLogPreview(bundle, file, filename)
  }

  async commitTorqueLogImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<TorqueLogImportResult> {
    const empty = { connectionsCreated: 0, connectionsUpdated: 0 }
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.', ...empty }

    // Re-planned against the book as it stands now, never taken from the
    // browser. A plan supplied by a client is a client asserting what is
    // in a document it also supplied.
    const preview = buildTorqueLogPreview(bundle, file, filename)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the log.', ...empty }
    }

    const rows = rowsForTorquePlan(preview.plan, bundle, {
      enteredAt: new Date().toISOString(),
      entrySource: 'field_entry',
    })

    const supabase = await createClient()
    // `facilityTorqueRecordId` derives the id from the book, the ISO
    // number and the flange, so re-importing a corrected log updates the
    // same rows rather than filing a second copy beside the first.
    const CHUNK = 500
    for (let i = 0; i < rows.torqueConnections.length; i += CHUNK) {
      const { error } = await supabase.from('torque_connection').upsert(
        rows.torqueConnections.slice(i, i + CHUNK)
          .map((c) => domainToRow(c, COLUMNS.torque_connection)),
        { onConflict: 'id' },
      )
      if (error) return { ok: false, error: describe(error), ...empty }
    }

    await this.refreshScores(jobBookId, viewer)

    return {
      ok: true,
      connectionsCreated: preview.plan.connectionsToCreate,
      connectionsUpdated: preview.plan.connectionsToUpdate,
    }
  }

  async previewPressureTestImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<PressureTestImportPreview> {
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.' }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.' }
    return buildPressureTestPreview(bundle, file, filename)
  }

  async commitPressureTestImport(
    viewer: Viewer, jobBookId: string, file: Uint8Array, filename: string,
  ): Promise<PressureTestImportCommit> {
    const empty = { testsCreated: 0, testsUpdated: 0 }
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to import into this book.', ...empty }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.', ...empty }

    // Re-planned against the book as it stands now, never taken from the
    // browser — the same rule the weld and torque imports follow.
    const preview = buildPressureTestPreview(bundle, file, filename)
    if (!preview.ok || !preview.plan) {
      return { ok: false, error: preview.error ?? 'Could not read the sheet.', ...empty }
    }

    const now = new Date().toISOString()
    const records = toPressureTestRecords(preview.plan.rows, { jobBookId })
      .map((t) => ({ ...t, enteredAt: now, entrySource: 'field_entry' as const }))

    const supabase = await createClient()
    const { error } = await supabase.from('pressure_test').upsert(
      records.map((t) => domainToRow(t, COLUMNS.pressure_test)),
      { onConflict: 'id' },
    )
    if (error) return { ok: false, error: describe(error), ...empty }

    await this.refreshScores(jobBookId, viewer)
    return {
      ok: true,
      testsCreated: preview.plan.testsToCreate,
      testsUpdated: preview.plan.testsToUpdate,
    }
  }

  async recordAudit(
    viewer: Viewer, jobBookId: string, input: AuditInput,
  ): Promise<ActionResult> {
    if (!WRITERS.has(viewer.role)) {
      return { ok: false, error: 'Not permitted to record an audit on this book.' }
    }
    const supabase = await createClient()

    let auditId: string
    if (input.tier === 'tier_2_peer') {
      // Through the function, never a direct INSERT. §10.2's independence
      // rule and the JB-3 floor cannot be expressed as check constraints
      // — neither can see the book's Custodian or a competency level —
      // so they live in `record_peer_audit()` and hold for any caller.
      const verdict = scoreAudit(input.findings)
      const { data, error } = await supabase.rpc('record_peer_audit', {
        p_book: jobBookId,
        p_auditor: input.auditorId,
        p_score: verdict.score,
        p_lot_size: input.lotSize ?? null,
        p_sample_size: input.sampleSize ?? null,
        p_sample_plan: input.samplePlan ?? null,
        p_double_sample: input.doubleSample ?? false,
        p_notes: input.notes ?? null,
      })
      if (error) return { ok: false, error: describe(error) }
      auditId = (data as { id: string }).id
    } else {
      // §10 reserves Tier 3 to the QA/QC Manager, and Gate 4 reads that
      // row as satisfying g4.tier3 — so anyone else filing one clears a
      // criterion the program does not give them. The trigger on
      // job_book_audit refuses it regardless; this is here so the caller
      // meets the refusal as a sentence rather than a Postgres error.
      if (input.tier === 'tier_3_manager' && !BOOK_CREATORS.has(viewer.role)) {
        return {
          ok: false,
          error: 'Tier 3 verification is performed by the QA/QC manager or an admin (§10).',
        }
      }
      const { data: prior } = await supabase
        .from('job_book_audit').select('attempt')
        .eq('job_book_id', jobBookId).eq('tier', input.tier)
        .order('attempt', { ascending: false }).limit(1)
      const attempt = ((prior?.[0]?.attempt as number | undefined) ?? 0) + 1
      const now = new Date().toISOString()

      const { data, error } = await supabase.from('job_book_audit').insert({
        job_book_id: jobBookId,
        tier: input.tier,
        attempt,
        auditor_id: input.auditorId,
        started_at: now,
        completed_at: now,
        outcome: 'pass',
        notes: input.notes ?? null,
        created_by: viewer.id,
      }).select('id').single()
      if (error) return { ok: false, error: describe(error) }
      auditId = data.id as string
    }

    if (input.findings.length > 0) {
      const { error } = await supabase.from('audit_finding').insert(
        input.findings.map((f) => ({
          audit_id: auditId,
          classification: f.classification,
          section_number: f.sectionNumber ?? null,
          summary: f.summary,
          detail: f.detail ?? null,
          due_at: f.dueAt ?? null,
        })),
      )
      // The audit row is already written and is the record that matters.
      // Reporting a partial write is more useful than pretending the
      // whole thing failed, because the audit did happen.
      if (error) {
        return {
          ok: false,
          error: `The audit was recorded but its findings were not: ${describe(error)}`,
        }
      }
    }
    return { ok: true }
  }

  async certifyCompleteness(
    viewer: Viewer, jobBookId: string, statement: string | null,
  ): Promise<ActionResult> {
    if (!BOOK_CREATORS.has(viewer.role)) {
      return {
        ok: false,
        error: 'The Completeness Certification is signed by the QA/QC manager or an admin (§10.4).',
      }
    }
    const bundle = await this.getBundle(viewer, jobBookId)
    if (!bundle) return { ok: false, error: 'Job book not found.' }

    // The figures are derived here and passed in, rather than left for
    // the database to look up, because §10.4 certifies a state of the
    // book on a day — and the engine is what knows that state.
    // The register is loaded with the book, so `undefined` here means the
    // load failed rather than that the book is clean. Signing on that
    // would be signing on a question nobody asked — §10.4 is the last
    // check before a book leaves the building, so it refuses instead.
    if (!bundle.complianceFlags) {
      return {
        ok: false,
        error: 'The findings register could not be read, so the book cannot be certified. ' +
          'Gate 4 requires zero open Critical and zero open Major findings, and that cannot ' +
          'be confirmed from a register that did not load.',
      }
    }

    const score = scoreBook(bundle)
    const counted = bundle.sections.filter((s) => s.status !== 'na')
    const open = bundle.complianceFlags.filter(
      (f) => f.state === 'open' || f.state === 'acknowledged',
    )

    const supabase = await createClient()
    const { error } = await supabase.rpc('certify_completeness', {
      p_book: jobBookId,
      p_completion_pct: score.overallPct,
      p_sections_total: counted.length,
      p_sections_approved: counted.filter((s) => s.status === 'approved').length,
      p_open_critical: open.filter((f) => f.severity === 'critical').length,
      p_open_major: open.filter((f) => f.severity === 'warning').length,
      p_tier_2_audit: latestOfTier(bundle.audits ?? [], 'tier_2_peer')?.id ?? null,
      p_tier_3_audit: latestOfTier(bundle.audits ?? [], 'tier_3_manager')?.id ?? null,
      p_statement: statement,
    })
    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  async listStaff(viewer: Viewer): Promise<StaffMember[]> {
    if (!WRITERS.has(viewer.role)) return []
    const supabase = await createClient()
    const { data } = await supabase
      .from('app_user')
      .select('id, full_name, email, role, competency_level')
      .is('deleted_at', null)
      .eq('is_active', true)
      .in('role', ['fortress_admin', 'qaqc_manager', 'qaqc_tech'])
      .order('full_name')
    return (data ?? []).map((u) => ({
      id: u.id as string,
      fullName: u.full_name as string,
      email: u.email as string,
      role: u.role as UserRole,
      competencyLevel: (u.competency_level as CompetencyLevel | null) ?? null,
    }))
  }

  // -- People ------------------------------------------------------------
  //
  // Every write here goes through an RPC rather than a table write. The
  // `app_user_write` policy would permit an admin to UPDATE the row
  // directly, but it cannot see that the row is the last admin, so a
  // direct write would be a way around the guard that exists precisely
  // because nothing outside the database could undo it.

  async listUsers(viewer: Viewer): Promise<DirectoryUser[]> {
    if (!can(viewer.role, 'view_internal')) return []
    const supabase = await createClient()
    // Two plain queries joined here rather than one embedded select. The
    // rest of this file does the same, and the select string would have
    // to be a single literal for PostgREST's type parser to read it.
    const [{ data }, { data: orgs }] = await Promise.all([
      supabase
        .from('app_user')
        .select('id, full_name, email, role, client_org_id, is_active, auth_user_id, created_at')
        .is('deleted_at', null)
        .order('full_name'),
      supabase.from('client_org').select('id, name'),
    ])
    const orgName = new Map(
      (orgs ?? []).map((o) => [o.id as string, o.name as string]))
    return (data ?? []).map((u) => {
      const orgId = (u.client_org_id as string | null) ?? null
      return {
        id: u.id as string,
        fullName: u.full_name as string,
        email: u.email as string,
        role: u.role as UserRole,
        clientOrgId: orgId,
        clientOrgName: orgId ? orgName.get(orgId) ?? null : null,
        isActive: u.is_active as boolean,
        linked: u.auth_user_id != null,
        createdAt: u.created_at as string,
      }
    })
  }

  async inviteUser(viewer: Viewer, input: InviteInput): Promise<ActionResult> {
    if (!can(viewer.role, 'manage_users')) {
      return { ok: false, error: 'Only a Fortress Admin may invite a user.' }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('invite_user', {
      p_email: input.email.trim().toLowerCase(),
      p_full_name: input.fullName.trim(),
      p_role: input.role,
      p_client_org_id: input.clientOrgId ?? null,
    })
    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  async setUserRole(
    viewer: Viewer, userId: string, role: UserRole, clientOrgId: string | null,
  ): Promise<ActionResult> {
    if (!can(viewer.role, 'manage_users')) {
      return { ok: false, error: 'Only a Fortress Admin may change a role.' }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('set_user_role', {
      p_user_id: userId,
      p_role: role,
      p_client_org_id: clientOrgId,
    })
    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  async setUserActive(
    viewer: Viewer, userId: string, active: boolean,
  ): Promise<ActionResult> {
    if (!can(viewer.role, 'manage_users')) {
      return { ok: false, error: 'Only a Fortress Admin may deactivate a user.' }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('set_user_active', {
      p_user_id: userId, p_active: active,
    })
    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  // -- Client Inspector access -------------------------------------------

  async listInspectorGrants(
    viewer: Viewer, jobBookId?: string,
  ): Promise<InspectorGrant[]> {
    if (!can(viewer.role, 'view_internal') && viewer.role !== 'third_party_inspector') {
      return []
    }
    const supabase = await createClient()
    let q = supabase
      .from('inspector_grant')
      .select('job_book_id, user_id, expires_at, can_comment, granted_at, granted_by, revoked_at')
      .order('granted_at', { ascending: false })
    if (jobBookId) q = q.eq('job_book_id', jobBookId)
    const { data } = await q
    const grants = data ?? []
    if (grants.length === 0) return []

    // `inspector_grant` references `app_user` twice — as the grantee and
    // as the granter — so an embedded select would need a foreign-key
    // hint on each. Two lookups keyed by id say the same thing without
    // naming a constraint that a later migration could rename.
    const userIds = [...new Set(grants.flatMap(
      (g) => [g.user_id as string, g.granted_by as string | null]
        .filter((x): x is string => x != null)))]
    const bookIds = [...new Set(grants.map((g) => g.job_book_id as string))]
    const [{ data: users }, { data: books }] = await Promise.all([
      supabase.from('app_user').select('id, full_name, email').in('id', userIds),
      supabase.from('job_book').select('id, job_number, facility_name').in('id', bookIds),
    ])
    const person = new Map((users ?? []).map((u) => [u.id as string, u]))
    const book = new Map((books ?? []).map((b) => [b.id as string, b]))

    const now = Date.now()
    return grants.map((g) => {
      const who = person.get(g.user_id as string)
      const granter = g.granted_by ? person.get(g.granted_by as string) : null
      const bk = book.get(g.job_book_id as string)
      const expiresAt = (g.expires_at as string | null) ?? null
      const revokedAt = (g.revoked_at as string | null) ?? null
      return {
        jobBookId: g.job_book_id as string,
        jobNumber: (bk?.job_number as string) ?? '—',
        facilityName: (bk?.facility_name as string | null) ?? null,
        userId: g.user_id as string,
        userName: (who?.full_name as string) ?? 'Unknown',
        userEmail: (who?.email as string) ?? '',
        expiresAt,
        canComment: g.can_comment as boolean,
        grantedAt: g.granted_at as string,
        grantedByName: (granter?.full_name as string | null) ?? null,
        revokedAt,
        live: !revokedAt && (!expiresAt || Date.parse(expiresAt) > now),
      }
    })
  }

  async issueInspectorGrant(
    viewer: Viewer, jobBookId: string, input: GrantInput,
  ): Promise<ActionResult> {
    if (!can(viewer.role, 'manage_inspector_grants')) {
      return {
        ok: false,
        error: 'Only a QA/QC Manager or an Admin may grant access to a book.',
      }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('issue_inspector_grant', {
      p_job_book_id: jobBookId,
      p_user_id: input.userId,
      p_expires_at: input.expiresAt ?? null,
      p_can_comment: input.canComment ?? false,
    })
    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  async revokeInspectorGrant(
    viewer: Viewer, jobBookId: string, userId: string,
  ): Promise<ActionResult> {
    if (!can(viewer.role, 'manage_inspector_grants')) {
      return { ok: false, error: 'Only a QA/QC Manager or an Admin may withdraw access.' }
    }
    const supabase = await createClient()
    const { error } = await supabase.rpc('revoke_inspector_grant', {
      p_job_book_id: jobBookId, p_user_id: userId,
    })
    return error ? { ok: false, error: describe(error) } : { ok: true }
  }

  // -- Notes -------------------------------------------------------------

  async listNotes(viewer: Viewer, jobBookId: string): Promise<BookNote[]> {
    const supabase = await createClient()
    // No visibility filter here on purpose. `inspector_comment_read`
    // applies it server-side, and re-stating it would create a second
    // copy to drift from the first — the mistake this whole exercise
    // keeps finding.
    const { data } = await supabase
      .from('inspector_comment')
      .select('id, job_book_id, body, visibility, severity, created_at, author_id, section_id')
      .eq('job_book_id', jobBookId)
      .order('created_at')
    const notes = data ?? []
    if (notes.length === 0) return []

    const authorIds = [...new Set(notes.map((n) => n.author_id as string))]
    const [{ data: authors }, { data: sections }, { data: defs }] = await Promise.all([
      supabase.from('app_user').select('id, full_name, role').in('id', authorIds),
      supabase.from('job_book_section')
        .select('id, section_definition_id').eq('job_book_id', jobBookId),
      supabase.from('section_definition').select('id, section_number'),
    ])
    const person = new Map((authors ?? []).map((a) => [a.id as string, a]))
    const defNumber = new Map(
      (defs ?? []).map((d) => [d.id as string, d.section_number as string]))
    const sectionNumber = new Map((sections ?? []).map(
      (s) => [s.id as string, defNumber.get(s.section_definition_id as string) ?? null]))

    return notes.map((n) => {
      const author = person.get(n.author_id as string)
      const sid = n.section_id as string | null
      return {
        id: n.id as string,
        jobBookId: n.job_book_id as string,
        sectionNumber: sid ? sectionNumber.get(sid) ?? null : null,
        authorId: n.author_id as string,
        authorName: (author?.full_name as string) ?? 'Unknown',
        // An author whose row this viewer cannot read — a client user
        // sees only their own org's people — leaves the name unresolved.
        // Falling back to the least-privileged role keeps the note
        // rendering without implying an authority nobody confirmed.
        authorRole: (author?.role as UserRole) ?? 'fortress_read_only',
        body: n.body as string,
        visibility: n.visibility as BookNote['visibility'],
        severity: n.severity as NoteSeverity,
        createdAt: n.created_at as string,
      }
    })
  }

  async addNote(
    viewer: Viewer, jobBookId: string, input: NoteInput,
  ): Promise<ActionResult> {
    const body = input.body.trim()
    if (!body) return { ok: false, error: 'A note needs something in it.' }

    // Whether this viewer may comment at all is the database's answer —
    // for an inspector it depends on a grant row this provider would
    // have to fetch and re-interpret. The insert simply carries the
    // right shape and lets the policy decide.
    const internal = can(viewer.role, 'view_internal')
    const visibility: BookNote['visibility'] =
      internal ? (input.visibility ?? 'internal') : 'client'

    const supabase = await createClient()
    let sectionId: string | null = null
    if (input.sectionNumber) {
      // Not `sectionRow()`, which gates on WRITERS because its callers
      // are all writes to the section. Citing a section in a note is
      // something an inspector does, and the read below is governed by
      // can_read_job_book() anyway — an inspector without a grant on
      // this book resolves nothing and gets the not-found sentence.
      const { data: defs } = await supabase
        .from('section_definition').select('id')
        .eq('section_number', input.sectionNumber)
      const defIds = (defs ?? []).map((d) => d.id as string)
      const { data: row } = defIds.length
        ? await supabase
            .from('job_book_section').select('id')
            .eq('job_book_id', jobBookId)
            .in('section_definition_id', defIds)
            .maybeSingle()
        : { data: null }
      if (!row) return { ok: false, error: 'That section is not part of this book.' }
      sectionId = row.id as string
    }

    const { error } = await supabase.from('inspector_comment').insert({
      job_book_id: jobBookId,
      section_id: sectionId,
      author_id: viewer.id,
      body,
      visibility,
      // Quiet unless the author says otherwise. The trigger fans a note
      // out on insert, so this value decides who is interrupted.
      severity: input.severity ?? 'info',
    })
    if (error) {
      // The policy's refusal is the common case here and its generic
      // wording would be baffling: an inspector whose grant is read-only
      // has done nothing wrong and needs to be told which half is missing.
      if (error.code === '42501' || /row-level security/i.test(error.message)) {
        return {
          ok: false,
          error: viewer.role === 'third_party_inspector'
            ? 'Your access to this book does not include adding notes. A QA/QC ' +
              'Manager can enable that on your grant.'
            : 'Your role does not include adding notes to this book.',
        }
      }
      return { ok: false, error: describe(error) }
    }
    return { ok: true }
  }

  // -- Notifications -----------------------------------------------------

  async listNotifications(
    viewer: Viewer, opts?: { unreadOnly?: boolean; limit?: number },
  ): Promise<NotificationItem[]> {
    const supabase = await createClient()
    // No `user_id` filter: `notification_read` is `user_id =
    // current_app_user_id()`, so the database has already answered it.
    // Adding one here would be a second copy of the rule, and the kind
    // that looks like the control.
    let q = supabase
      .from('notification')
      .select('id, job_book_id, note_id, created_at, read_at')
      .order('created_at', { ascending: false })
      .limit(opts?.limit ?? 50)
    if (opts?.unreadOnly) q = q.is('read_at', null)
    const { data } = await q
    const rows = data ?? []
    if (rows.length === 0) return []

    // The note is read through `inspector_comment` under its own policy,
    // so a notification can never surface more than the note would. A
    // note whose visibility later excluded this reader simply drops out
    // of the join, which is the behaviour we want.
    const noteIds = [...new Set(rows.map((r) => r.note_id as string))]
    const bookIds = [...new Set(rows.map((r) => r.job_book_id as string))]
    const [{ data: notes }, { data: books }] = await Promise.all([
      supabase.from('inspector_comment')
        .select('id, body, severity, author_id, section_id').in('id', noteIds),
      supabase.from('job_book').select('id, job_number').in('id', bookIds),
    ])
    const note = new Map((notes ?? []).map((n) => [n.id as string, n]))

    const authorIds = [...new Set((notes ?? []).map((n) => n.author_id as string))]
    const [{ data: authors }, { data: sections }, { data: defs }] = await Promise.all([
      authorIds.length
        ? supabase.from('app_user').select('id, full_name').in('id', authorIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
      supabase.from('job_book_section')
        .select('id, section_definition_id').in('job_book_id', bookIds),
      supabase.from('section_definition').select('id, section_number'),
    ])
    const person = new Map((authors ?? []).map((a) => [a.id as string, a.full_name as string]))
    const jobNumber = new Map((books ?? []).map((b) => [b.id as string, b.job_number as string]))
    const defNumber = new Map(
      (defs ?? []).map((d) => [d.id as string, d.section_number as string]))
    const sectionNumber = new Map((sections ?? []).map(
      (s) => [s.id as string, defNumber.get(s.section_definition_id as string) ?? null]))

    const out: NotificationItem[] = []
    for (const r of rows) {
      const n = note.get(r.note_id as string)
      // The note is gone, or this reader may no longer see it. Either
      // way there is nothing to show, and a row saying "a note you
      // cannot read" would be worse than silence.
      if (!n) continue
      const sid = n.section_id as string | null
      out.push({
        id: r.id as string,
        jobBookId: r.job_book_id as string,
        jobNumber: jobNumber.get(r.job_book_id as string) ?? '—',
        noteId: n.id as string,
        severity: n.severity as NoteSeverity,
        sectionNumber: sid ? sectionNumber.get(sid) ?? null : null,
        authorName: person.get(n.author_id as string) ?? 'Unknown',
        body: n.body as string,
        createdAt: r.created_at as string,
        readAt: (r.read_at as string | null) ?? null,
      })
    }
    return out
  }

  async markNotificationsRead(
    viewer: Viewer, jobBookId?: string,
  ): Promise<ActionResult> {
    const supabase = await createClient()
    const { error } = await supabase.rpc('mark_notifications_read', {
      p_job_book_id: jobBookId ?? null,
    })
    return error ? { ok: false, error: describe(error) } : { ok: true }
  }
}

/** A PostgREST error a person can act on. */
function describe(error: { message: string; code?: string; details?: string }): string {
  if (error.code === '42501' || /row-level security/i.test(error.message)) {
    return 'The database refused this write for your role. If you believe you should be able ' +
      'to do this, your account may not be assigned to this job book.'
  }
  if (error.code === '23505') return 'That record already exists in this book.'
  if (error.code === '23514') return `A database rule rejected this: ${error.details ?? error.message}`
  return error.message
}
