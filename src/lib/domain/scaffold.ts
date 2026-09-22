/**
 * Creating a job book.
 *
 * Setting up a book is two acts, and the second is the one that matters.
 * First the header — who the operator is, which pads, which pipe spec —
 * lifted straight from the block the Noble weld log repeats on every line
 * sheet. Then the *scope*: how many joints, how many flanged connections,
 * how many heats this job is expected to produce when it is finished.
 *
 * The scope is not paperwork. It is the denominator every percentage on
 * the dashboard divides by, and without it a book scores itself against
 * only the rows already typed — so a tech who has entered 100 of 2,342
 * joints, every one of them complete, is told the section is finished.
 * Declaring the scope up front is what makes a mid-job percentage mean
 * "how far through the book are we" instead of "how tidy is my typing".
 *
 * Every quantity is an estimate off the drawing set and every one is
 * editable later. They are a floor, never a cap: enter more joints than
 * scoped and the denominator follows reality upward rather than letting
 * the section climb past 100%.
 */
import type {
  BookType, JobBook, JobBookSection, SectionDefinition, WeldLine,
} from './types'
import { appliesToBook, buildTemplateSections } from './checklist'

/** A quantity a job can declare at setup, keyed by section number. */
export interface ScopeDeclaration {
  sectionNumber: string
  expectedCount: number | null
}

export interface WeldLineDeclaration {
  lineCode: string
  lineDescription?: string
  workbook?: string
  wellName?: string
  expectedWeldCount?: number | null
  pipeSize?: string
  pipeSchedule?: string
  pipeGrade?: string
  serviceType?: string
}

export interface NewJobBookInput {
  jobNumber: string
  bookType: BookType
  projectId: string
  clientOrgId: string
  bookTemplateId: string
  facilityName?: string
  drillPadName?: string
  wellNames?: string[]
  constructionCompany?: string
  weldingCompany?: string
  cwiNames?: string[]
  operatorPicName?: string
  pipeSizeIn?: string
  pipeSchedule?: string
  pipeGrade?: string
  constructionStart?: string
  constructionEnd?: string
  targetTurnoverDate?: string
  requiredXrayPct?: number
  requiredTorqueInspectPct?: number
  torqueTolerancePct?: number
  certExpiryWarningDays?: number
  xrayCreditRule?: JobBook['xrayCreditRule']
  scope?: ScopeDeclaration[]
  weldLines?: WeldLineDeclaration[]
  /** Off-checklist sections this job delivers, by section number. */
  enabledOptionalSections?: string[]
  constructionAreas?: string[]
  businessUnit?: string
  qaqcRepresentative?: string
  defaultDesignPressurePsi?: number
  createdBy?: string
}

export interface ScaffoldResult {
  book: JobBook
  sections: JobBookSection[]
  weldLines: WeldLine[]
  sectionDefinitions: SectionDefinition[]
}

/**
 * Sections that take a declared quantity, with the unit the wizard should
 * ask for. Derived from the template's requirement type rather than
 * hard-coded per section number, so a new section inherits the behaviour.
 */
export interface ScopePrompt {
  sectionNumber: string
  title: string
  /** What is being counted, in the words a QA/QC tech would use. */
  unit: string
  /** Where the number comes from, so the estimate is grounded. */
  source: string
  suggested?: number
}

export function scopePrompts(bookType: BookType, bookTemplateId = 'tpl'): ScopePrompt[] {
  const UNITS: Record<string, { unit: string; source: string }> = {
    '2':  { unit: 'drawings',            source: 'the overview and redline drawing set' },
    '6':  { unit: 'welders',             source: 'the welding contractor’s crew list' },
    '7':  { unit: 'CWIs',                source: 'the inspectors assigned to this job' },
    '8':  { unit: 'NDT technicians',     source: 'the NDT vendor’s assigned personnel' },
    '9':  { unit: 'procedures',          source: 'one per examination method in use' },
    '10': { unit: 'NDE reports',         source: 'the examination schedule, or an estimate from the X-ray count' },
    '12': { unit: 'joints',              source: 'the isometrics — enter per line below if you have them' },
    '13': { unit: 'torque wrenches',     source: 'the wrench roster for this job' },
    '14': { unit: 'flanged connections', source: 'the isometrics' },
    '15': { unit: 'heat numbers',        source: 'the material take-off' },
    '16': { unit: 'documents',           source: 'the pressure test procedure and P&ID set' },
    '17': { unit: 'pressure tests',      source: 'the test packs' },
    '18': { unit: 'CP test points',      source: 'the cathodic protection design' },
    '19': { unit: 'UT locations',        source: 'the UT baseline plan' },
    '20': { unit: 'P&IDs',               source: 'the as-built drawing set' },
    '21': { unit: 'drawings',            source: 'the isometric weld and X-ray map set' },
    '22': { unit: 'drawings',            source: 'the isometric heat number and torque map set' },
    '19-22': { unit: 'drawings',         source: 'the combined weld, X-ray, heat number and torque map set' },
  }

  return buildTemplateSections(bookType, bookTemplateId)
    .filter((d) => !d.isSupplemental)
    .filter((d) => appliesToBook(d.appliesTo, bookType))
    // A derived section rolls up another and must never carry its own
    // scope, or the same records would be counted twice.
    .filter((d) => d.requirementType !== 'derived')
    // Section 1 is generated by the application.
    .filter((d) => d.weight > 0)
    .map((d) => {
      const u = UNITS[d.sectionNumber]
      return u
        ? { sectionNumber: d.sectionNumber, title: d.title, unit: u.unit, source: u.source }
        : { sectionNumber: d.sectionNumber, title: d.title, unit: 'documents',
            source: 'the checklist requirement for this section' }
    })
}

/**
 * Build a new book with all 22 checklist sections scaffolded.
 *
 * Sections that do not apply to this book type are created and marked N/A
 * with the reason recorded, never omitted — an operator auditing against
 * the checklist should see that a section was considered and ruled out
 * rather than find a gap in the numbering.
 */
export function scaffoldJobBook(
  input: NewJobBookInput,
  idFor: (kind: string, key: string) => string,
): ScaffoldResult {
  const bookId = idFor('book', input.jobNumber)
  const sectionDefinitions = buildTemplateSections(input.bookType, input.bookTemplateId)
  const scopeByNumber = new Map(
    (input.scope ?? []).map((s) => [s.sectionNumber, s.expectedCount]),
  )

  const book: JobBook = {
    id: bookId,
    projectId: input.projectId,
    bookTemplateId: input.bookTemplateId,
    bookType: input.bookType,
    jobNumber: input.jobNumber.trim(),
    facilityName: input.facilityName?.trim() || null,
    drillPadName: input.drillPadName?.trim() || null,
    wellNames: (input.wellNames ?? []).map((w) => w.trim()).filter(Boolean),
    constructionCompany: input.constructionCompany?.trim() || null,
    weldingCompany: input.weldingCompany?.trim() || null,
    cwiNames: (input.cwiNames ?? []).map((c) => c.trim()).filter(Boolean),
    pipeSizeIn: input.pipeSizeIn?.trim() || null,
    pipeSchedule: input.pipeSchedule?.trim() || null,
    pipeGrade: input.pipeGrade?.trim() || null,
    status: 'setup',
    targetTurnoverDate: input.targetTurnoverDate || null,
    constructionStart: input.constructionStart || null,
    constructionEnd: input.constructionEnd || null,
    // A new book is current as of today; the field logs have not been
    // closed against an earlier date yet.
    dataAsOfDate: null,
    requiredXrayPct: input.requiredXrayPct ?? 10,
    requiredTorqueInspectPct: input.requiredTorqueInspectPct ?? 10,
    torqueTolerancePct: input.torqueTolerancePct ?? 5,
    certExpiryWarningDays: input.certExpiryWarningDays ?? 60,
    xrayCreditRule: input.xrayCreditRule ?? 'all_passes',
    enabledOptionalSections: input.enabledOptionalSections ?? [],
    constructionAreas: input.constructionAreas ?? [],
    businessUnit: input.businessUnit ?? null,
    qaqcRepresentative: input.qaqcRepresentative ?? null,
    defaultDesignPressurePsi: input.defaultDesignPressurePsi ?? null,
  }

  const enabledOptional = new Set(input.enabledOptionalSections ?? [])
  const sections: JobBookSection[] = sectionDefinitions.map((def) => {
    // An optional section is off unless the job turns it on, and off means
    // N/A — out of both sides of the division, so a job that does no
    // coating work is not penalised for having no coating records.
    const applicable = appliesToBook(def.appliesTo, input.bookType) &&
      (!def.isOptional || enabledOptional.has(def.sectionNumber))
    const declared = scopeByNumber.get(def.sectionNumber) ?? null
    // A scope of zero is a statement that the section has no work in it,
    // which is what N/A means. Recording it as a zero denominator instead
    // would park the section at 0% forever.
    const scopedToNothing = applicable && declared === 0
    return {
      id: idFor('section', `${bookId}:${def.sectionNumber}`),
      jobBookId: bookId,
      sectionDefinitionId: def.id,
      status: !applicable || scopedToNothing ? 'na' : 'not_started',
      naReason: !applicable
        ? (def.isOptional
            ? `Off-checklist optional section; not enabled for this job.`
            : `${def.appliesTo === 'facility' ? 'Facility' : 'Flowline'}-only section; not applicable to a ` +
              `${input.bookType} book.`)
        : scopedToNothing
          ? 'Scoped to zero at job setup — this job has no work of this kind.'
          : null,
      readyForReviewBy: null,
      approvedBy: null,
      approvedAt: null,
      computedPct: 0,
      expectedCount: declared && declared > 0 ? declared : null,
      // A book born here has no external source folder to be behind on.
      // Evidence arrives by upload, so what the application holds is all
      // there is, and a zero means absent rather than unread. Leaving this
      // `unknown` would make a brand new book report 0% evidence coverage
      // on contents that provably do not exist yet.
      ingestionStatus: 'imported',
      sourceFileCount: null,
      sourceBytes: null,
      internalNotes: null,
    }
  })

  const weldLines: WeldLine[] = (input.weldLines ?? []).map((l, i) => ({
    id: idFor('line', `${bookId}:${l.lineCode}`),
    jobBookId: bookId,
    lineCode: l.lineCode.trim(),
    lineDescription: l.lineDescription?.trim() || null,
    workbook: l.workbook?.trim() || null,
    wellName: l.wellName?.trim() || null,
    drillPadName: book.drillPadName,
    facilityName: book.facilityName,
    operatorPic: input.operatorPicName?.trim() || null,
    weldingCompany: book.weldingCompany,
    pipeSize: l.pipeSize?.trim() || book.pipeSizeIn,
    pipeSchedule: l.pipeSchedule?.trim() || book.pipeSchedule,
    pipeGrade: l.pipeGrade?.trim() || book.pipeGrade,
    serviceType: l.serviceType?.trim() || null,
    sortOrder: i,
    expectedWeldCount: l.expectedWeldCount ?? null,
  }))

  return { book, sections, weldLines, sectionDefinitions }
}

export interface ValidationIssue { field: string; message: string }

/** Validate before anything is written. Errors block creation; the wizard
 *  shows warnings but lets a book through, since a job often starts before
 *  every quantity is known. */
export function validateNewJobBook(input: NewJobBookInput): {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
} {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (!input.jobNumber?.trim()) {
    errors.push({ field: 'jobNumber', message: 'A job number is required — it identifies the book everywhere.' })
  }
  if (!input.clientOrgId) {
    errors.push({ field: 'clientOrgId', message: 'Select the operator this book belongs to.' })
  }
  if (input.constructionStart && input.constructionEnd &&
      input.constructionStart > input.constructionEnd) {
    errors.push({ field: 'constructionEnd', message: 'Construction cannot end before it starts.' })
  }
  for (const s of input.scope ?? []) {
    if (s.expectedCount != null && s.expectedCount < 0) {
      errors.push({ field: `scope.${s.sectionNumber}`, message: 'A quantity cannot be negative.' })
    }
  }
  for (const l of input.weldLines ?? []) {
    if (!l.lineCode?.trim()) {
      errors.push({ field: 'weldLines', message: 'Every line needs a code, e.g. FL1.' })
    }
  }
  const codes = (input.weldLines ?? []).map((l) => l.lineCode.trim().toUpperCase())
  const dupes = codes.filter((c, i) => c && codes.indexOf(c) !== i)
  if (dupes.length) {
    errors.push({ field: 'weldLines', message: `Duplicate line code(s): ${[...new Set(dupes)].join(', ')}.` })
  }

  const scoped = (input.scope ?? []).filter((s) => s.expectedCount != null && s.expectedCount > 0)
  if (scoped.length === 0) {
    warnings.push({
      field: 'scope',
      message: 'No expected quantities declared. The book will score against the records entered so ' +
        'far rather than against its full scope, so a partly-entered section will read as complete. ' +
        'You can add quantities later, but the percentages will be misleading until you do.',
    })
  }
  if (!input.constructionStart || !input.constructionEnd) {
    warnings.push({
      field: 'constructionWindow',
      message: 'Without a construction window, reports dated outside the job cannot be flagged.',
    })
  }
  const lineTotal = (input.weldLines ?? []).reduce((t, l) => t + (l.expectedWeldCount ?? 0), 0)
  const weldScope = (input.scope ?? []).find((s) => s.sectionNumber === '12')?.expectedCount ?? 0
  if (lineTotal > 0 && weldScope > 0 && Math.abs(lineTotal - weldScope) / weldScope > 0.1) {
    warnings.push({
      field: 'weldLines',
      message: `Per-line joints total ${lineTotal.toLocaleString()} but section 12 is scoped to ` +
        `${weldScope.toLocaleString()}. The larger figure (${Math.max(lineTotal, weldScope).toLocaleString()}) ` +
        `will be used, so the section cannot flatter itself either way — but check which is right, ` +
        `and add the remaining lines if the per-line list is incomplete.`,
    })
  }
  return { errors, warnings }
}
