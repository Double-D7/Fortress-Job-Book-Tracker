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
  bookType: BookType
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
  /** Facility: design pressure used for the tier calculation where a weld
   *  does not carry its own. */
  defaultDesignPressurePsi?: number | null
  /** Business unit as printed on the log header (e.g. "Chevron DJBU"). */
  businessUnit?: string | null
  qaqcRepresentative?: string | null
  /** Facility: the construction areas the job is divided into. The
   *  denominator for per-area sections such as coating inspection. */
  constructionAreas?: string[]
}

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
  computedPct: number
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

export interface Welder {
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

export interface WelderQualification {
  id: string
  welderId: string
  code: QualificationCode
  process?: string | null
  qualificationDate: IsoDate
  expiryDate?: IsoDate | null
  continuityLastVerified?: IsoDate | null
  documentId?: string | null
}

export interface Cwi { id: string; fullName: string; initials: string; employer?: string | null; active: boolean }

export interface NdtTechnician {
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
  lastCalibrationDate?: IsoDate | null
  calibrationDueDate?: IsoDate | null
  certDocumentId?: string | null
  certOnFile: boolean
  /** Whether the wrench appears in the log's roster header block, as
   *  distinct from merely appearing on a connection row. */
  onRoster: boolean
}

export interface Certificate {
  id: string
  jobBookId?: string | null
  subjectType: CertSubjectType
  subjectId: string
  certType: string
  issuingBody?: string | null
  issueDate: IsoDate
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

export interface Weld {
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

export interface TorqueConnection {
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

export interface NdeReport {
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
}

export interface MaterialHeat {
  id: string
  jobBookId: string
  heatNumber: string
  componentType?: string | null
  nominalSize?: string | null
  scheduleOrClass?: string | null
  grade?: string | null
  description?: string | null
  mtrDocumentId?: string | null
  mtrStatus: MtrStatus
}

export interface PressureTest {
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
}

export interface CpTestPoint {
  id: string
  jobBookId: string
  testPointId: string
  location?: string | null
  torqueConnectionId?: string | null
  baselinePotentialV?: number | null
  readingDate?: IsoDate | null
  technician?: string | null
}

export interface UtReading {
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
export interface CoatingInspection {
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
}
