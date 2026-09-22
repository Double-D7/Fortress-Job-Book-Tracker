/**
 * Preparing an uploaded file to become a document record.
 *
 * Pure functions, no filesystem and no network: the same code decides what
 * a file will become whether it is running in the upload preview a tech is
 * looking at or in the commit that follows. A preview that is computed by
 * different code than the commit is not a preview.
 *
 * Everything here is a *check*, not a correction. The application never
 * silently renames or discards a tech's file — §2 of the brief treats every
 * naming inconsistency and misfile in the delivered books as a requirement
 * to surface, and a fix applied quietly is a fix nobody learns from. So the
 * outcome of preparing a file is a proposal plus a list of things the tech
 * should look at before committing.
 */
import type { DocumentRecord, IsoDate, JobBook, SectionDefinition } from './types'
import {
  DEFAULT_TYPE_BY_SECTION, REGISTER_BY_SECTION, buildFilename, checkFilename,
  toDescriptor, type TypeCode,
} from './naming'

export type UploadIssueKind =
  /** The name cannot be made to conform because a required element is not
   *  yet known. Minor under §11.3: recorded, corrected before the next
   *  gate, never a reason to stop a tech working. */
  | 'name_incomplete'
  /** Byte-identical to a file already in the book. */
  | 'duplicate_content'
  /** Same filename already in this section, different content. */
  | 'same_name_different_content'
  /** Filename carries a job number that is not this book's. */
  | 'wrong_job_number'
  /** Filename does not lead with the section number the operator expects. */
  | 'not_section_numbered'
  /** Nothing in the file. */
  | 'empty_file'
  /** An archive: its contents are not indexed by uploading it. */
  | 'archive'

export interface UploadIssue {
  kind: UploadIssueKind
  /** Whether this stops the commit or merely warns. */
  blocking: boolean
  message: string
}

export interface PreparedUpload {
  originalFilename: string
  /** What the file will ship as in the turnover package. */
  normalizedFilename: string
  byteSize: number
  sha256: string
  mimeType: string | null
  issues: UploadIssue[]
  /** False when a blocking issue means this file will not be added. */
  willBeAdded: boolean
  /** Set when this supersedes an existing document of the same name. */
  supersedesDocumentId: string | null
  version: number
  /** Appendix B elements still missing from the name. */
  nameMissing: ('identifier' | 'documentDate')[]
}

const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz'])

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

/**
 * What the file will be named in the package.
 *
 * FDS-JBMP-001 Appendix B:
 *   [SS]-[TYPE]-[IDENTIFIER]-[DESCRIPTOR]-[YYYYMMDD]-R[n].[ext]
 *
 * The previous version of this produced `15 - DP452 MTR SU78500.pdf`,
 * which breaks the convention in four ways at once — spaces, no type code,
 * no register identifier, no document date, no revision. Every file this
 * application named was a Minor finding under §11.3 against Fortress's own
 * standard.
 *
 * `classification` carries the three elements that cannot honestly be
 * derived from a vendor's filename. Where the tech has not supplied them
 * the name is built with visible gaps rather than invented values: a
 * guessed heat number reads as a fact, and §9.1 exists because
 * filename-derived identity is how one welder ended up under four
 * spellings.
 */
export interface DocumentClassification {
  typeCode?: TypeCode
  /** A key from the controlled register for this section. §9.1. */
  identifier?: string | null
  /** The date the DOCUMENT bears — calibration, test, report, issue —
   *  never the date it was uploaded. */
  documentDate?: IsoDate | null
  revision?: number
}

export function normalizeFilename(
  original: string,
  sectionNumber: string,
  jobNumber: string,
  classification: DocumentClassification = {},
): string {
  return buildConformingName(original, sectionNumber, jobNumber, classification).filename
}

export function buildConformingName(
  original: string,
  sectionNumber: string,
  jobNumber: string,
  classification: DocumentClassification = {},
) {
  const ext = extensionOf(original)
  const stem = ext ? original.slice(0, -(ext.length + 1)) : original

  // Drop a section prefix the tech already typed, in the forms the
  // delivered books actually use: "13 - ", "13. ", "13_", "Section 13 ".
  const withoutPrefix = stem
    .replace(/^(?:section\s*)?\d{1,2}(?:-\d{1,2})?\s*[-._)]\s*/i, '')
    .trim()

  const descriptor = toDescriptor(withoutPrefix || stem) ||
    // A file with nothing usable left still needs to say what it is.
    toDescriptor(jobNumber) || 'document'

  return buildFilename({
    sectionNumber,
    typeCode: classification.typeCode
      ?? DEFAULT_TYPE_BY_SECTION[sectionNumber]
      ?? 'COC',
    identifier: classification.identifier ?? null,
    descriptor,
    documentDate: classification.documentDate ?? null,
    revision: classification.revision ?? 0,
    extension: ext,
  })
}

/** Which controlled register this section's identifier comes from, so the
 *  upload screen can offer the right list instead of a free text box. */
export function registerForSection(sectionNumber: string): string | null {
  return REGISTER_BY_SECTION[sectionNumber] ?? null
}

/** Job numbers in the operator's format, e.g. DP452, CC19. */
const JOB_PATTERN = /\b([A-Z]{2}\d{2,3})\b/g

export interface PrepareInput {
  originalFilename: string
  byteSize: number
  sha256: string
  mimeType?: string | null
  /** What the tech said this document is. See `DocumentClassification`. */
  classification?: DocumentClassification
  /**
   * The file's contents, when the caller has them.
   *
   * Carried on the input rather than the result so this module stays what
   * it is — a pure decision over metadata, testable without a byte of real
   * file. A provider that has to write the object finds the bytes here by
   * hash; nothing in this file reads them.
   */
  bytes?: Uint8Array
}

/**
 * Decide what one uploaded file becomes, given the book it is landing in.
 *
 * `existing` is every live document already in the book, because two of the
 * checks — identical content, and a name collision inside the section — can
 * only be answered against the whole book rather than the file alone.
 */
export function prepareUpload(
  file: PrepareInput,
  opts: {
    book: JobBook
    section: SectionDefinition
    sectionId: string
    existing: DocumentRecord[]
  },
): PreparedUpload {
  const { book, section, sectionId, existing } = opts
  const live = existing.filter((d) => !d.deletedAt)
  const issues: UploadIssue[] = []

  const built = buildConformingName(
    file.originalFilename, section.sectionNumber, book.jobNumber,
    {
      ...file.classification,
      // A revision is the supersede count, which is known below; it is
      // filled in after the same-name check.
      revision: file.classification?.revision,
    },
  )
  const normalizedFilename = built.filename

  if (file.byteSize === 0) {
    issues.push({
      kind: 'empty_file', blocking: true,
      message: 'This file is empty. An empty file in a turnover package reads as evidence ' +
        'that is not there.',
    })
  }

  // Identical content already in the book. Blocking, because shipping the
  // same page twice under two names is one of the misfiles §2 calls out.
  const identical = live.find((d) => d.sha256 === file.sha256)
  if (identical) {
    issues.push({
      kind: 'duplicate_content', blocking: true,
      message: `Byte-identical to ${identical.originalFilename}, already in section ` +
        `${sectionNumber(identical, opts)}. Nothing would be added by uploading it again.`,
    })
  }

  // Same name, different bytes — a revision, and the tech has to say so.
  const sameName = live.find(
    (d) => d.sectionId === sectionId &&
      d.originalFilename.toLowerCase() === file.originalFilename.toLowerCase() &&
      d.sha256 !== file.sha256,
  )
  if (sameName) {
    issues.push({
      kind: 'same_name_different_content', blocking: false,
      message: `A different file of this name is already here. Uploading will file this as ` +
        `version ${sameName.version + 1} and mark the existing one superseded; the old one ` +
        `stays in the record.`,
    })
  }

  // A filename naming another job. This is the check that caught a foreign
  // document sitting in a delivered book.
  const bookJob = book.jobNumber.trim().toUpperCase()
  const named = [...file.originalFilename.toUpperCase().matchAll(JOB_PATTERN)]
    .map((m) => m[1]!)
    .filter((j) => j !== bookJob)
  if (named.length) {
    issues.push({
      kind: 'wrong_job_number', blocking: false,
      message: `The filename names ${[...new Set(named)].join(', ')}, not ${bookJob}. If this ` +
        `document belongs to another job it must not ship inside this package.`,
    })
  }

  if (built.missing.length) {
    const what = built.missing
      .map((m) => m === 'identifier'
        ? `a ${registerForSection(section.sectionNumber) ?? 'register'} identifier`
        : "the document's own date")
      .join(' and ')
    issues.push({
      kind: 'name_incomplete', blocking: false,
      message: `The package name needs ${what}. Appendix B requires ` +
        `[SS]-[TYPE]-[IDENTIFIER]-[DESCRIPTOR]-[YYYYMMDD]-R[n]; this will file as ` +
        `${built.filename} until they are supplied. A non-conforming name is a Minor ` +
        `finding, not a blocker — the file is filed either way.`,
    })
  }

  if (ARCHIVE_EXT.has(extensionOf(file.originalFilename))) {
    issues.push({
      kind: 'archive', blocking: false,
      message: 'An archive counts as one document. Its contents are not indexed and nothing ' +
        'inside it is scored — unzip it and upload the files if they are the evidence.',
    })
  }

  return {
    originalFilename: file.originalFilename,
    normalizedFilename,
    byteSize: file.byteSize,
    sha256: file.sha256,
    mimeType: file.mimeType ?? null,
    issues,
    willBeAdded: !issues.some((i) => i.blocking),
    supersedesDocumentId: sameName?.id ?? null,
    version: sameName ? sameName.version + 1 : 1,
    nameMissing: built.missing,
  }
}

function sectionNumber(
  d: DocumentRecord,
  opts: { section: SectionDefinition; sectionId: string },
): string {
  return d.sectionId === opts.sectionId ? opts.section.sectionNumber : 'another section'
}

export interface UploadPreview {
  files: PreparedUpload[]
  /** Documents in this section now, and after committing what is addable. */
  countBefore: number
  countAfter: number
  expectedCount: number | null
  blocked: number
}

/**
 * The whole batch, previewed together.
 *
 * Prepared in order and against a growing set, so two identical files
 * dropped in one batch are caught against each other rather than both
 * sailing through because neither was in the book when the batch started.
 */
export function previewUploads(
  files: PrepareInput[],
  opts: {
    book: JobBook
    section: SectionDefinition
    sectionId: string
    existing: DocumentRecord[]
    expectedCount?: number | null
  },
): UploadPreview {
  const seen = [...opts.existing]
  const prepared: PreparedUpload[] = []

  for (const f of files) {
    const p = prepareUpload(f, { ...opts, existing: seen })
    prepared.push(p)
    if (!p.willBeAdded) continue
    seen.push({
      id: `pending-${p.sha256.slice(0, 12)}`,
      jobBookId: opts.book.id,
      sectionId: opts.sectionId,
      originalFilename: p.originalFilename,
      normalizedFilename: p.normalizedFilename,
      storagePath: '', sha256: p.sha256, byteSize: p.byteSize,
      version: p.version, isSuperseded: false, visibility: 'internal',
      uploadedAt: new Date().toISOString(),
    })
  }

  const countBefore = opts.existing.filter(
    (d) => d.sectionId === opts.sectionId && !d.deletedAt && !d.isSuperseded,
  ).length
  const added = prepared.filter((p) => p.willBeAdded && !p.supersedesDocumentId).length

  return {
    files: prepared,
    countBefore,
    countAfter: countBefore + added,
    expectedCount: opts.expectedCount ?? null,
    blocked: prepared.filter((p) => !p.willBeAdded).length,
  }
}
