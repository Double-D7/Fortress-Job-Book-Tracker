/**
 * Domain types for the Fortress job book.
 *
 * These mirror the Postgres schema in `supabase/migrations/0001_schema.sql`
 * but are deliberately independent of any data source: every rule in this
 * folder is a pure function over these shapes, so the scoring and flag
 * engines can be tested without a database and reused on the server, in the
 * browser, and inside the Excel import preview.
 */

export type BookType = 'flowline' | 'facility'
/** Re-exported from ./divisions, which owns the grouping logic. */
export type Division = 'flowline' | 'facility' | 'maintenance'
export type AppliesTo = BookType | 'both'

export type JobBookStatus =
  | 'setup' | 'in_progress' | 'ready_for_review' | 'submitted' | 'accepted' | 'archived'

export type SectionStatus =
  | 'not_started' | 'in_progress' | 'ready_for_review' | 'approved' | 'na'

export type RequirementType =
  | 'document' | 'personnel_certs' | 'equipment_certs' | 'records' | 'derived' | 'supplemental'

export type UserRole =
  | 'fortress_admin' | 'qaqc_manager' | 'qaqc_tech'
  | 'fortress_read_only' | 'client_user' | 'third_party_inspector'

export type NdtMethod = 'RT' | 'PT' | 'MT' | 'UT'
export type PassFail = 'Pass' | 'Fail'
export type JointType = 'Butt' | 'O-let' | 'Socket' | 'Branch'
export type WeldStatus =
  | 'planned' | 'welded' | 'visual_complete' | 'ndt_complete' | 'not_used' | 'cut_out'
export type QualificationCode = 'ASME_IX' | 'API_1104'
export type MtrStatus = 'on_file' | 'missing' | 'illegible' | 'unidentified'
export type DocVisibility = 'internal' | 'client' | 'inspector'
export type FlagSeverity = 'critical' | 'warning' | 'info'
export type FlagState = 'open' | 'acknowledged' | 'resolved' | 'dismissed'
export type CertSubjectType =
  | 'welder' | 'cwi' | 'ndt_technician' | 'torque_wrench' | 'pressure_recorder'

/** ISO date, `YYYY-MM-DD`. Dates in this domain are calendar dates, never
 *  instants: a weld happened on a day, in a field, not at a timestamp. */
export type IsoDate = string

export interface ClientOrg { id: string; name: string; logoUrl?: string | null }

export interface Project {
  id: string
  clientOrgId: string
  name: string
  operatorPicName?: string | null
  afeNumber?: string | null
}

export interface JobBook {
  id: string
  projectId: string
  bookTemplateId: string
  /** Which checklist this book is scored against. */
  bookType: BookType
  /**
   * Which part of the business runs the job.
   *
   * Distinct from `bookType`: a maintenance job is scored against the
   * facility checklist. Null on a book recorded before divisions
   * existed, and `divisionOf()` falls back to `bookType` for those.
   */
  division?: Division | null
  jobNumber: string
  facilityName?: string | null
  drillPadName?: string | null
  wellNames: string[]
  constructionCompany?: string | null
  weldingCompany?: string | null
  cwiNames: string[]
  pipeSizeIn?: string | null
  pipeSchedule?: string | null
  pipeGrade?: string | null
  status: JobBookStatus
  targetTurnoverDate?: IsoDate | null
  constructionStart?: IsoDate | null
  constructionEnd?: IsoDate | null
  /** The as-of date the field logs were closed against. Records dated after
   *  this are future-dated relative to the log that reports them. */
  dataAsOfDate?: IsoDate | null
  requiredXrayPct: number
  requiredTorqueInspectPct: number
  torqueTolerancePct: number
  certExpiryWarningDays: number
  xrayCreditRule: 'all_passes' | 'root_welder' | 'cap_welder'
  /** Section numbers of off-checklist optional sections enabled for this
   *  job. An optional section not listed here is marked N/A. */
  enabledOptionalSections?: string[]
  /** Facility: design pressure used where a weld does not carry its own. */
  defaultDesignPressurePsi?: number | null
  /**
   * What inspection this job's welds owe. Read from the log's own face —
   * DP-318 states it in Project Overview cell G7 — never inferred from the
   * presence of a vocabulary elsewhere in the workbook.
   */
  inspectionRule?:
    | { kind: 'flat'; requiredVisualPct: number; requiredNdePct: number; statedAs?: string }
    | { kind: 'tiered'; ruleTableId?: string; confirmed: boolean }
  /** Business unit as printed on the log header (e.g. "Chevron DJBU"). */
  businessUnit?: string | null
  qaqcRepresentative?: string | null
  /** Facility: the construction areas the job is divided into. The
   *  denominator for per-area sections such as coating inspection. */
  constructionAreas?: string[]

  // -- Governing documents (FDS-JBMP-001 §3, Gate 0) ---------------------
  /**
   * The client checklist and piping specification actually in force, by
   * the client's own name for them and at the revision on file.
   *
   * These used to live inside four section titles ("Noble Energy Piping
   * Specification"), which is how a delivered book came to be audited
   * against a checklist branded to an operator who no longer held the
   * asset. A title cannot be revised; a field can.
   */
  clientChecklistReference?: string | null
  clientChecklistRevision?: string | null
  pipingSpecReference?: string | null
  pipingSpecRevision?: string | null
  /** Gate 0 requires these confirmed CURRENT with the client, not merely
   *  recorded. A date nobody set means nobody asked. */
  governingDocsConfirmedAt?: IsoDate | null
  governingDocsConfirmedBy?: string | null

  // -- Governance spine (FDS-JBMP-001 §5, §6, §7) ------------------------
  /** §5: one book, one Custodian, named at Gate 0 and accountable for
   *  every record in it. */
  /** §8: "a scheduled working day for the crew performing the work". Not
   *  every crew works Monday to Friday, and the difference moves every
   *  deadline in §8.1. */
  workWeek?: 'mon_fri' | 'mon_sat' | 'all_days'
  custodianId?: string | null
  custodianAssignedAt?: string | null
  /** §6.2: the completion curve this book is measured against, agreed at
   *  Gate 0 from the construction schedule. Carried per book so a later
   *  revision of the program cannot move the bar under a running job. */
  plannedCurve?: PlannedMilestone[] | null
  plannedCurveAgreedAt?: IsoDate | null
  /** The highest gate this book has cleanly passed. A Conditional Pass
   *  does not advance it — see `recordGateReview`. */
  currentGate?: GateId | null
  currentGateAt?: string | null
}

/** One point on the §6.2 planned completion curve. */
export interface PlannedMilestone {
  milestone: PlannedMilestoneId
  minimumPct: number
}

export type PlannedMilestoneId =
  | 'gate_0_passed'
  | 'construction_25'
  | 'construction_50'
  | 'mechanical_completion'
  | 'gate_4_entry'
  | 'submission'

export interface SectionDefinition {
  id: string
  bookTemplateId: string
  sectionNumber: string
  sortOrder: number
  /** Verbatim from the governing checklist. The operator audits against
   *  these exact titles, so they are never paraphrased in UI or exports. */
  title: string
  appliesTo: AppliesTo
  weight: number
  requirementType: RequirementType
  minDocuments: number
  linkedRecordType?: string | null
  isRequired: boolean
  isSupplemental: boolean
  /**
   * Off the governing checklist but scored when a job enables it — the
   * Greeley book's section 23 · Coating Inspection. Distinct from
   * supplemental, which is never scored: an optional section carries real
   * weight when enabled, and leaves the denominator entirely when not.
   */
  isOptional: boolean
  notes?: string | null
}

export interface JobBookSection {
  id: string
  jobBookId: string
  sectionDefinitionId: string
  status: SectionStatus
  naReason?: string | null
  readyForReviewBy?: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  /**
   * Cache of the live score, in percent.
   *
   * Derived, never authoritative: `applyComputedScores` writes it from the
   * engine and `computedAt` records when. It exists for the readers that do
   * not run the engine — most importantly the client-facing section view,
   * which returns exactly this number to an operator.
   */
  computedPct: number
  /** Cache of the same score over evidence collected rather than approved.
   *  Never below `computedPct`; the gap is work awaiting a signature. */
  collectedPct?: number
  /** When `computedPct` was last written. A cache with no timestamp cannot
   *  be told apart from a current one. */
  computedAt?: string | null
  /**
   * Declared scope: how many records or documents this section is expected
   * to hold when the book is finished, entered at job setup from the
   * drawing set and scope of work.
   *
   * This is the scoring denominator, and it is the difference between "how
   * complete is what I have typed" and "how complete is the book". Without
   * it, a tech who has entered 100 of 2,342 joints — all of them filled in
   * correctly — sees the section at 100%, because the only rows the
   * engine can see are the ones already there. Null means the scope was
   * never declared, and the section falls back to scoring against what
   * exists.
   */
  expectedCount?: number | null
  /**
   * Whether this section's contents have been loaded into the application
   * at all — which is a different question from whether they exist.
   *
   * Conflating the two is the most dangerous thing this application can
   * do. DP-318's section 17 holds 41 MB of pressure test packs, every one
   * carrying the recorder calibration certificate the section is named
   * for, and the book reported it as "section absent" because nothing had
   * walked the folder. A turnover report saying a section is missing when
   * it is merely unread is worse than no report: it sends a crew to
   * re-do work that was already done, and it destroys trust in every
   * other number on the page.
   *
   *   imported       — contents loaded; the score is a real verdict
   *   not_imported   — contents exist on disk but have not been read;
   *                    the score is a floor, not a verdict
   *   verified_empty — looked, and there is genuinely nothing there
   *   unknown        — nobody has established which of the above holds
   */
  ingestionStatus?: 'imported' | 'not_imported' | 'verified_empty' | 'unknown'
  /** Evidence from the source folder, where a tree listing has been read. */
  sourceFileCount?: number | null
  sourceBytes?: number | null
  /**
   * When this section is expected to be complete, set at Gate 0 from the
   * construction schedule (§7 Gate 0).
   *
   * `expectedCount` says how much; this says by when. A book without these
   * can be behind schedule and look merely incomplete, which is the
   * difference between a management item and a surprise at turnover.
   */
  expectedBy?: IsoDate | null
  /** Fortress-only. Never present in a client or inspector payload. */
  internalNotes?: string | null
}

export interface DocumentRecord {
  id: string
  jobBookId: string
  sectionId?: string | null
  recordType?: string | null
  recordId?: string | null
  originalFilename: string
  normalizedFilename: string
  storagePath: string
  mimeType?: string | null
  byteSize?: number | null
  sha256: string
  pageCount?: number | null
  version: number
  supersedesDocumentId?: string | null
  isSuperseded: boolean
  visibility: DocVisibility
  uploadedBy?: string | null
  uploadedAt: string
  approvedBy?: string | null
  approvedAt?: string | null
  deletedAt?: string | null
}

export interface Welder extends EnteredRecord {
  id: string
  fullName: string
  initials: string
  employer?: string | null
  active: boolean
  /** Misspellings observed in source logs, so an import resolves to one
   *  person instead of minting a new welder per typo. */
  nameAliases: string[]
  /**
   * When a stamp represents a two-man crew rather than a person — the
   * Greeley log's `MR LC` — the welders it stands for. Such a stamp needs
   * no qualification of its own, because its members hold theirs, but it
   * also means the welds under it cannot be attributed to one man.
   */
  combinedOf?: string[]
}

export interface WelderQualification extends EnteredRecord {
  id: string
  welderId: string
  code: QualificationCode
  process?: string | null
  /**
   * When the qualification was granted.
   *
   * Null where the source gave only an expiry — the Weld Log Overview
   * Sheet records "Date WPQ Expires" and nothing else. A null start is not
   * an open window: `qualifiedOn` refuses to certify a weld against a
   * qualification whose start is unknown, for the same reason
   * `certValidOn` refuses an unread certificate.
   */
  qualificationDate: IsoDate | null
  expiryDate?: IsoDate | null
  continuityLastVerified?: IsoDate | null
  documentId?: string | null
}

export interface Cwi extends EnteredRecord { id: string; fullName: string; initials: string; employer?: string | null; active: boolean }

export interface NdtTechnician extends EnteredRecord {
  id: string
  fullName: string
  initials?: string | null
  employer?: string | null
  classification?: string | null
  active: boolean
}

export interface TorqueWrench {
  id: string
  wrenchId: string
  capacityFtLb?: number | null
  /** From the calibration certificate, which is the calibration record. */
  lastCalibrationDate?: IsoDate | null
  calibrationDueDate?: IsoDate | null
  certDocumentId?: string | null
  certOnFile: boolean
  /**
   * Whether the certificate on file has actually been read.
   *
   * A filed certificate this application cannot yet parse — a photograph of
   * paper, a scan with no OCR — is an unread record, not a missing one. The
   * distinction has to survive into the domain, because scoring a wrench as
   * uncalibrated on the strength of an unread page sends a crew to
   * recalibrate equipment that was calibrated.
   */
  certRead?: boolean
  /**
   * What the log's own roster block claims the last calibration was.
   *
   * Recorded next to the certificate rather than instead of it, so the two
   * can be compared. On the Greeley book one roster line transcribes the
   * wrench's in-service date as its calibration date.
   */
  rosterClaimedCalibrationDate?: IsoDate | null
  /** Whether the wrench appears in the log's roster header block, as
   *  distinct from merely appearing on a connection row. */
  onRoster: boolean
}

/**
 * How a record arrived in the job book — FDS-JBMP-001 §8.
 *
 *   field_entry — entered by a person against work that had just happened.
 *                 The only kind §8 can measure.
 *   bulk_import — loaded from a legacy book, a spreadsheet or a folder
 *                 tree. Real evidence, but its entry date says nothing
 *                 about how promptly the crew filed it.
 */
export type EntrySource = 'field_entry' | 'bulk_import'

/**
 * The entry side of §8's one comparison.
 *
 * Every record already carries the date the WORK happened. This carries
 * the moment the record was ENTERED, which is the other half of "records
 * entered within standard divided by total records entered" — and which
 * the application did not store at all, so the measurement §6.1 calls the
 * one that makes every other control work could not be taken.
 *
 * Both fields are optional, and absent is never read as compliant: a
 * record with no entry stamp, or one that does not say how it arrived, is
 * excluded from the rate in both directions rather than counted on time.
 */
export interface EnteredRecord {
  enteredAt?: string | null
  entrySource?: EntrySource | null
}

export interface Certificate {
  id: string
  jobBookId?: string | null
  subjectType: CertSubjectType
  subjectId: string
  certType: string
  issuingBody?: string | null
  /**
   * Null where the certificate is on file but has not been read — a
   * photograph of paper, a scan with no OCR. `certValidOn` refuses to
   * certify anything against an unknown issue date, so an unread page can
   * never silently pass as a valid one.
   */
  issueDate: IsoDate | null
  expiryDate?: IsoDate | null
  documentId?: string | null
  verifiedBy?: string | null
  verifiedAt?: string | null
}

export interface WeldLine {
  id: string
  jobBookId: string
  /**
   * Flowline: the line code (FL1, FWT). Facility: the construction area
   * (2100, 8400, REDLINE). One grouping entity, because everything that
   * consumes it — the grid's selector, the per-group rollups — asks the
   * same question either way.
   */
  lineCode: string
  lineDescription?: string | null
  /** 'line' for flowline books, 'construction_area' for facility books. */
  groupingKind?: 'line' | 'construction_area'
  workbook?: string | null
  wellName?: string | null
  drillPadName?: string | null
  facilityName?: string | null
  operatorPic?: string | null
  weldingCompany?: string | null
  pipeSize?: string | null
  pipeSchedule?: string | null
  pipeGrade?: string | null
  serviceType?: string | null
  sortOrder: number
  /** Joints this line is expected to carry, from the isometric. Summed
   *  across lines to scope section 12 when set. */
  expectedWeldCount?: number | null
}

export interface Weld extends EnteredRecord {
  id: string
  weldLineId: string
  jobBookId: string
  /** Text, not a number: `NP-2` nipple repairs appear mid-sequence. */
  weldNumber: string
  sortOrder: number
  weldDate?: IsoDate | null
  /**
   * Flowline books record four pass assignments, e.g. `HS2/HS2/CT/CT` —
   * Root/Hot/Fill/Cap. Facility books record a single welder stamp per
   * weld instead. Both shapes live here; `creditedWelders` reads whichever
   * is populated, so the rollups do not branch on book type.
   */
  welderPassAssignment?: string | null
  rootWelderId?: string | null
  hotWelderId?: string | null
  fillWelderId?: string | null
  capWelderId?: string | null
  /** Facility: the welder stamp exactly as written on the log. */
  welderStamp?: string | null
  /** Facility: the stamp resolved to a managed welder. */
  welderId?: string | null
  jointType?: JointType | null
  componentDescription?: string | null
  partLength?: string | null
  /** Often two — upstream and downstream of the joint. */
  heatNumbers: string[]
  cwiInitials?: string | null
  cwiId?: string | null
  cwiVisualResult?: PassFail | null
  visualInspectionDate?: IsoDate | null
  /** §8.1 gives the CWI visual its own standard ("end of same business
   *  day") and its own owner, so it needs its own entry stamp. */
  visualEnteredAt?: string | null
  ndtCompany?: string | null
  xrayNumber?: string | null
  ndtTicketNumber?: string | null
  ndtMethod?: NdtMethod | null
  ndtResult?: PassFail | null
  ndtReportId?: string | null
  status: WeldStatus
  /** Internal only. */
  comments?: string | null

  // ---- Facility books ---------------------------------------------------
  /** Work is organised by construction area and equipment tag, not by line. */
  constructionArea?: string | null
  equipmentTag?: string | null
  /** The isometric this weld appears on; the denominator for sections 21/22. */
  isometricNumber?: string | null
  /** Which pressure test pack covers this weld. */
  pressureTestRef?: string | null
  /**
   * Inputs to the inspection-tier calculation. A facility weld log derives
   * its NDE obligation from pipe engineering rather than a flat job-wide
   * percentage, so these are per-weld rather than per-book.
   */
  pipeSizeSchedule?: string | null
  pipeGrade?: string | null
  designPressurePsi?: number | null
}

export interface TorqueConnection extends EnteredRecord {
  id: string
  jobBookId: string
  isoFlangeNumber: string
  isoNumber?: string | null
  flangePipeSize?: string | null
  boltDiameter?: string | null
  boltCount?: number | null
  /** Point value, or the minimum of a range. Kept for flowline books and
   *  for anything that wants a single number. */
  requiredTorqueFtLb?: number | null
  /** Facility logs specify a range (`130-260`). A point value sets both
   *  bounds, so "within spec" is one containment test either way. */
  requiredTorqueMinFtLb?: number | null
  requiredTorqueMaxFtLb?: number | null
  actualTorqueFtLb?: number | null
  wrenchId?: string | null
  /** The wrench identifier exactly as recorded, before resolution against
   *  the managed roster. Kept so an unresolvable id stays visible. */
  wrenchIdRaw?: string | null
  cpTestOnFlange: boolean
  torqueDate?: IsoDate | null
  employeeInitials?: string | null
  inspectionDate?: IsoDate | null
  /** §8.1 times the torque inspection separately from the connection. */
  inspectionEnteredAt?: string | null
  inspectorInitials?: string | null
  status: string
}

export interface NdeReportLine {
  id: string
  ndeReportId: string
  weldId?: string | null
  partNumber?: string | null
  weldNumber?: string | null
  result?: PassFail | null
  location?: string | null
  welderCode?: string | null
  weldJoint?: string | null
  weldSize?: string | null
  weldSchedule?: string | null
  indications?: string | null
}

export interface NdeReport extends EnteredRecord {
  id: string
  jobBookId: string
  reportNumber?: string | null
  reportDate: IsoDate
  ndtCompany?: string | null
  method: NdtMethod
  procedureReference?: string | null
  revision?: string | null
  acceptanceCriteria?: string | null
  technicianId?: string | null
  workOrderNumber?: string | null
  clientPoAfe?: string | null
  equipmentModel?: string | null
  equipmentSerial?: string | null
  equipmentCalDueDate?: IsoDate | null
  /** Facility / pad as printed on the report itself, compared against the
   *  book that holds it to catch a document filed into the wrong job. */
  referencedFacility?: string | null
  referencedPad?: string | null
  documentId?: string | null
  supersedesReportId?: string | null
  isSuperseded: boolean
  lines: NdeReportLine[]
  /**
   * What the source PDF did not give up: pages that yielded nothing,
   * rows naming no weld, fields that could not be read.
   *
   * Stored rather than shown and forgotten, because flags in this system
   * are derived from data by rules. A page nobody could read has to be a
   * fact in the record before it can be a finding somebody must clear.
   */
  importGaps?: NdeImportGap[] | null
  /** The technician as printed on the report, kept even when it resolves
   *  to no record — the finding needs the name to be actionable. */
  technicianName?: string | null
  /** The file this report was read from. One file often holds several. */
  sourceFilename?: string | null
}

export interface NdeImportGap {
  kind: string
  severity: 'critical' | 'warning'
  detail: string
  page?: number
}

export interface MaterialHeat extends EnteredRecord {
  id: string
  jobBookId: string
  heatNumber: string
  componentType?: string | null
  nominalSize?: string | null
  scheduleOrClass?: string | null
  grade?: string | null
  description?: string | null
  mtrDocumentId?: string | null
  /** The library certificate matching this heat, resolved automatically
   *  by heat number. Distinct from `mtrDocumentId`, which is a document
   *  attached to this book specifically. */
  mtrLibraryId?: string | null
  mtrStatus: MtrStatus
  /** §8.2 precondition 4: the MTR is captured against the heat AT RECEIPT.
   *  Without this date the precondition cannot be shown to have been met. */
  receivedOn?: IsoDate | null
}

/**
 * One mill certificate in the library.
 *
 * Not scoped to a job book: the certificate for heat D07821 is the same
 * certificate wherever that steel was used, and filing it per-book means
 * filing it repeatedly and losing it individually.
 */
export interface MtrDocument {
  id: string
  /** As the mill wrote it, uppercased. Matching is on letters and digits
   *  only, so `D-07821` and `D07821` are one heat. */
  heatNumber: string
  materialDescription?: string | null
  nominalSize?: string | null
  scheduleOrClass?: string | null
  grade?: string | null
  componentType?: string | null
  heatTreatment?: string | null
  /** §15 traceability is to the mill, not the distributor, and the two
   *  are usually different. */
  millName?: string | null
  supplierName?: string | null
  certificateNumber?: string | null
  certificateDate?: IsoDate | null
  storagePath: string
  originalFilename: string
  normalizedFilename: string
  sha256: string
  byteSize?: number | null
  pageCount?: number | null
  mimeType?: string | null
  notes?: string | null
  uploadedBy?: string | null
  uploadedAt: string
  deletedAt?: string | null
}

export interface PressureTest extends EnteredRecord {
  id: string
  jobBookId: string
  testIdentifier: string
  lineCodes: string[]
  testDate?: IsoDate | null
  testMedium?: string | null
  testPressurePsi?: number | null
  durationMinutes?: number | null
  result?: PassFail | null
  recorderSerial?: string | null
  recorderCertId?: string | null
  chartDocumentId?: string | null
  witnessedBy?: string | null
  /**
   * The three instruments a test needs certified on its test date.
   *
   * FDS-JBMP-001 §11.1 makes accepting a test without gauge, recorder AND
   * pressure safety valve certificates valid on the test date a Critical
   * finding. Only the recorder was modelled, so two thirds of that check
   * could not be made.
   */
  gaugeSerial?: string | null
  gaugeCertId?: string | null
  psvSerial?: string | null
  psvCertId?: string | null
  /** Hold data. Appendix A §17 requires start and end pressure, duration
   *  and ambient temperature, not merely a pass or fail. */
  startPressurePsi?: number | null
  endPressurePsi?: number | null
  ambientTempF?: number | null
  /** Appendix A §17: "No test present as certificates only." */
  resultDocumentId?: string | null
}

export interface CpTestPoint extends EnteredRecord {
  id: string
  jobBookId: string
  testPointId: string
  location?: string | null
  torqueConnectionId?: string | null
  baselinePotentialV?: number | null
  readingDate?: IsoDate | null
  technician?: string | null
}

export interface UtReading extends EnteredRecord {
  id: string
  jobBookId: string
  locationId: string
  description?: string | null
  nominalWall?: number | null
  measuredWall?: number | null
  readingDate?: IsoDate | null
  technicianId?: string | null
}

/** Coating inspection record, one per construction area (section 23). */
export interface CoatingInspection extends EnteredRecord {
  id: string
  jobBookId: string
  constructionArea: string
  inspectionDate?: IsoDate | null
  inspector?: string | null
  /** Structured readings, as opposed to photographs filed with no data. */
  hasStructuredData: boolean
  documentCount: number
  notes?: string | null
}

/**
 * FDS-JBMP-001 §10 — Three-Tier Verification.
 *
 * Tier 1 is the Custodian on their own book; Tier 2 is a different
 * Custodian at JB-3 or above, and is the only scored tier; Tier 3 is the
 * QA/QC Manager at Gate 4. The rules live in `domain/audits.ts`.
 */
export type AuditTier = 'tier_1_self' | 'tier_2_peer' | 'tier_3_manager'
export type AuditOutcome = 'pass' | 'fail' | 'in_progress'
/** §11's three defect classes, as an audit records them. */
export type FindingClass = 'critical' | 'major' | 'minor'

export interface JobBookAudit {
  id: string
  jobBookId: string
  tier: AuditTier
  /** Attempts are rows, not edits. A book that passed on the third try
   *  did not pass the way one that passed first time did. */
  attempt: number
  auditorId?: string | null
  scheduledFor?: IsoDate | null
  startedAt?: string | null
  completedAt?: string | null
  outcome: AuditOutcome
  /** 0–100. Null for Tiers 1 and 3, which are counted and signed rather
   *  than scored, and for an audit still in progress. */
  score?: number | null
  /** Which sampling table produced `sampleSize`. A sample size with no
   *  stated basis is a number somebody picked. */
  samplePlan?: string | null
  lotSize?: number | null
  sampleSize?: number | null
  /** §7 Gate 4: "at double sample size". */
  doubleSample: boolean
  notes?: string | null
}

export interface AuditFinding {
  id: string
  auditId: string
  classification: FindingClass
  sectionNumber?: string | null
  summary: string
  detail?: string | null
  /** §11.5. A finding with no due date cannot be past due. */
  dueAt?: IsoDate | null
  resolvedAt?: string | null
  resolvedBy?: string | null
  resolution?: string | null
}

/** §10.4, form FDS-JB-F07. Carries the figures as they stood at
 *  signature, because certifying today's numbers certifies nothing. */
export interface CompletenessCertification {
  jobBookId: string
  certifiedBy: string
  certifiedAt: string
  completionPct: number
  sectionsTotal: number
  sectionsApproved: number
  openCritical: number
  openMajor: number
  tier2AuditId?: string | null
  tier3AuditId?: string | null
  statement?: string | null
  revokedAt?: string | null
  revokedBy?: string | null
  revokedReason?: string | null
}

export interface ComplianceFlag {
  id: string
  jobBookId: string
  ruleId: string
  severity: FlagSeverity
  title: string
  detail: string
  entityType?: string | null
  entityId?: string | null
  sectionNumber?: string | null
  /** Stable across evaluation runs, so a resolved flag stays resolved and a
   *  recurring one is not duplicated. */
  fingerprint: string
  state: FlagState
  assignedTo?: string | null
  resolutionNote?: string | null
  /** §11.5: an NCR carries an owner and a due date. A finding with no due
   *  date cannot be past due, so the gate criteria count it as unmet
   *  rather than as compliant. */
  dueAt?: IsoDate | null
  escalatedAt?: string | null
}

/**
 * Everything the scoring and flag engines need about one book. Assembled
 * once per request by the data provider.
 */
export interface JobBookBundle {
  book: JobBook
  project: Project
  clientOrg: ClientOrg
  sectionDefinitions: SectionDefinition[]
  sections: JobBookSection[]
  documents: DocumentRecord[]
  weldLines: WeldLine[]
  welds: Weld[]
  welders: Welder[]
  welderQualifications: WelderQualification[]
  cwis: Cwi[]
  ndtTechnicians: NdtTechnician[]
  torqueWrenches: TorqueWrench[]
  torqueConnections: TorqueConnection[]
  certificates: Certificate[]
  ndeReports: NdeReport[]
  materialHeats: MaterialHeat[]
  pressureTests: PressureTest[]
  cpTestPoints: CpTestPoint[]
  utReadings: UtReading[]
  coatingInspections?: CoatingInspection[]
  /**
   * The open NCR register (§11.5), where the caller has loaded it.
   *
   * Undefined and empty are deliberately different. Gate criteria that ask
   * "zero open NCRs past due date" read undefined as "the register was not
   * loaded, so I cannot tell" and empty as "loaded, and there are none".
   * Collapsing the two would let a gate pass on a question nobody asked.
   */
  complianceFlags?: ComplianceFlag[]
  /**
   * The §10 audit history, where the caller has loaded it.
   *
   * Undefined and empty differ here for the same reason they differ on
   * the NCR register. Five gate criteria across G1, G2 and G4 ask about
   * audits, and an unloaded history must report indeterminate rather
   * than "no audits, therefore none were required".
   */
  audits?: JobBookAudit[]
  auditFindings?: AuditFinding[]
  /**
   * §10.4, form FDS-JB-F07. Present once the QA/QC Manager has signed.
   * "No job book leaves Fortress without this signature."
   */
  completenessCertification?: CompletenessCertification | null
  /**
   * True once this bundle has been reduced for an external reader.
   *
   * Redaction removes identities and internal commentary — per-pass welder
   * attribution, deficiency notes, unapproved documents. It is not supposed
   * to change the completion verdict, but re-deriving a score from what is
   * left does exactly that, and in both directions: DP452 section 12 falls
   * from 92.19% to 0% because its evidence was filtered out, and section 6
   * *rises* from 87.5% to 100% because the redacted bundle can no longer
   * see which welder made the weld that failed the qualification check.
   *
   * The second is the dangerous one. Redaction must never hand an operator
   * a cleaner book than the one Fortress is looking at. So the score is
   * computed once, from the complete record, and travels with the payload
   * in `JobBookSection.computedPct`; `scoreBook` reads that cache rather
   * than recomputing whenever this flag is set.
   */
  redacted?: boolean
}

// =====================================================================
// Gate reviews — FDS-JBMP-001 §7
// =====================================================================

export type GateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5'

/** §7: "A gate has three possible outcomes." */
export type GateOutcome = 'pass' | 'conditional_pass' | 'fail'

/** FDS-JBMP-004 competency. JB-2 or above may hold Custodian; JB-3 or
 *  above may perform a Tier 2 peer audit. */
export type CompetencyLevel = 'JB-1' | 'JB-2' | 'JB-3' | 'JB-4'

/**
 * Whether the application can decide a criterion, or only record that a
 * person decided it.
 *
 *   derived  — the app evaluates it from the book's own records
 *   attested — it is a human judgement by construction (a client
 *              confirmation, a meeting held, paper legible), and the app's
 *              job is to demand the attestation, not to fake one
 */
export type CriterionSource = 'derived' | 'attested'

/**
 * The verdict on one criterion.
 *
 * `indeterminate` is the important one and it is never rounded toward
 * either neighbour. It means the app looked and could not tell — the
 * evidence has not been loaded, or the control it depends on does not
 * exist yet. Scoring that as met would let a book through a gate on the
 * strength of an unasked question, which is precisely the failure §2 root
 * cause 4 describes.
 */
export type CriterionState = 'met' | 'not_met' | 'indeterminate' | 'not_applicable'

export interface CriterionResult {
  id: string
  gate: GateId
  /** The criterion as the program words it. Not paraphrased: a chair
   *  signing a gate is signing against this sentence. */
  text: string
  source: CriterionSource
  state: CriterionState
  /** What the app actually found, in numbers where there are numbers. */
  detail: string
  /** Records or sections the verdict rests on, for drill-down. */
  evidence?: string[]
}

export interface GateEvaluation {
  gate: GateId
  title: string
  /** §7's "When:" line — the point in construction the gate sits at. */
  when: string
  criteria: CriterionResult[]
  met: number
  notMet: number
  indeterminate: number
  notApplicable: number
  /**
   * True only when every criterion is met. An indeterminate criterion is
   * not a pass: the chair may still pass the gate, but they do it over the
   * app's stated uncertainty and have to write down why.
   */
  wouldPass: boolean
  /** Weighted completion at evaluation time, for the §6.2 curve. */
  completionPct: number
}

export interface GateReview {
  id: string
  jobBookId: string
  gate: GateId
  attempt: number
  outcome: GateOutcome
  chairedBy: string
  custodianId?: string | null
  projectManagerId?: string | null
  decidedAt: string
  /** The criteria as they stood when the decision was taken. Frozen: a
   *  gate decision asserts something about the book on the day it was
   *  taken, and re-deriving it later answers a different question. */
  criteriaSnapshot: CriterionResult[]
  completionPct?: number | null
  conditionalDueAt?: IsoDate | null
  clearedAt?: string | null
  clearedBy?: string | null
  /** Required when a gate is passed with anything unmet or unevaluable.
   *  The database refuses the decision without it. */
  overrideNote?: string | null
  notes?: string | null
}

export interface GateCondition {
  id: string
  gateReviewId: string
  criterionId?: string | null
  description: string
  ownerId: string
  dueAt: IsoDate
  closedAt?: string | null
  closedBy?: string | null
  closureNote?: string | null
}
