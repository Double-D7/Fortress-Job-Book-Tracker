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
  lineCode: string
  lineDescription?: string | null
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
}

export interface Weld {
  id: string
  weldLineId: string
  jobBookId: string
  /** Text, not a number: `NP-2` nipple repairs appear mid-sequence. */
  weldNumber: string
  sortOrder: number
  weldDate?: IsoDate | null
  /** As printed, e.g. `HS2/HS2/CT/CT` — Root/Hot/Fill/Cap. */
  welderPassAssignment?: string | null
  rootWelderId?: string | null
  hotWelderId?: string | null
  fillWelderId?: string | null
  capWelderId?: string | null
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
}

export interface TorqueConnection {
  id: string
  jobBookId: string
  isoFlangeNumber: string
  isoNumber?: string | null
  flangePipeSize?: string | null
  boltDiameter?: string | null
  boltCount?: number | null
  requiredTorqueFtLb?: number | null
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
}
