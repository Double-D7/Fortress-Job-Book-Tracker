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
  ActionResult, CreateResult, DataProvider, GateDecision, GateSideFacts,
  JobBookSummary, OverviewImportPreview, OverviewImportResult, StaffMember,
  TorqueLogImportPreview, TorqueLogImportResult,
  UploadResult, Viewer, WeldLogImportPreview, WeldLogImportResult,
} from './provider'
import {
  buildOverviewPreview, buildTorqueLogPreview, buildWeldLogPreview, redactForViewer,
} from './provider'
import { rowsForPlan } from '@/lib/import/overviewIngest'
import { rowsForWeldPlan } from '@/lib/import/weldLogIngest'
import { rowsForTorquePlan } from '@/lib/import/torqueLogIngest'
import { randomUUID } from 'node:crypto'
import { scaffoldJobBook, validateNewJobBook, type NewJobBookInput } from '@/lib/domain/scaffold'
import { afterUpload, applyComputedScores, scoreBook } from '@/lib/domain/scoring'
import { aggregateFindings, countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import { previewUploads, type PrepareInput } from '@/lib/domain/upload'
import { createClient } from '@/lib/supabase/server'
import { COLUMNS, domainToRow, rowToDomain, rowsToDomain } from './rowMap'
import { DOCUMENT_BUCKET } from '@/lib/supabase/storage'

/** Statuses at or past hand-over. Countdowns stop here. */
const DELIVERED_STATUSES = new Set(['submitted', 'accepted', 'archived'])
const WRITERS: ReadonlySet<UserRole> = new Set<UserRole>([
  'fortress_admin', 'qaqc_manager', 'qaqc_tech',
])
const BOOK_CREATORS: ReadonlySet<UserRole> = new Set<UserRole>([
  'fortress_admin', 'qaqc_manager',
])

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
      .select('id, job_number, facility_name, book_type, status, target_turnover_date, project_id')
      .is('deleted_at', null)
      .order('job_number')
    if (error || !books?.length) return []

    const ids = books.map((b) => b.id as string)
    const [orgs, sections, flags] = await Promise.all([
      supabase.from('project').select('id, name, client_org:client_org_id(id, name)')
        .in('id', books.map((b) => b.project_id as string)),
      supabase.from('job_book_section')
        .select('job_book_id, computed_pct, collected_pct, status, section_definition_id')
        .in('job_book_id', ids),
      supabase.from('compliance_flag')
        .select('job_book_id, severity, state, fingerprint')
        .in('job_book_id', ids).eq('state', 'open'),
    ])

    const orgByProject = new Map(
      (orgs.data ?? []).map((p) => {
        const org = p.client_org as unknown as { id: string; name: string } | null
        return [p.id as string, org?.name ?? 'Unknown operator']
      }),
    )

    const today = new Date().toISOString().slice(0, 10)
    return books.map((b) => {
      const bookId = b.id as string
      // The score is a weighted figure over section definitions, so the
      // honest way to compute it is the engine over a full bundle. A list
      // of twenty books does not warrant twenty bundles, so the cached
      // per-section percentage is used — which is exactly what that cache
      // exists for, and why `applyComputedScores` keeps it current.
      const mine = (sections.data ?? []).filter((s) => s.job_book_id === bookId)
      const counted = mine.filter((s) => s.status !== 'na')
      const overallPct = counted.length
        ? Math.round(
            (counted.reduce((a, s) => a + Number(s.computed_pct ?? 0), 0) / counted.length) * 100,
          ) / 100
        : 0

      const open = (flags.data ?? []).filter((f) => f.job_book_id === bookId)
      const criticals = open.filter((f) => f.severity === 'critical')
      const target = (b.target_turnover_date as string | null) ?? null
      const delivered = DELIVERED_STATUSES.has(b.status as string)
      const days = target && !delivered
        ? Math.round(
            (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
          )
        : null

      return {
        id: bookId,
        jobNumber: b.job_number as string,
        facilityName: (b.facility_name as string | null) ?? null,
        clientOrgName: orgByProject.get(b.project_id as string) ?? 'Unknown operator',
        bookType: b.book_type as 'flowline' | 'facility',
        status: b.status as string,
        overallPct,
        criticalFlags: new Set(criticals.map((f) => f.fingerprint)).size,
        criticalRecords: criticals.length,
        targetTurnoverDate: target,
        daysToTurnover: days,
        turnoverState: delivered ? 'delivered'
          : !target ? 'no_target'
          : (days ?? 0) < 0 ? 'overdue'
          : 'upcoming',
      }
    })
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
