/**
 * Folder-tree import.
 *
 * A delivered job book already exists as a folder tree — the DP-318 book
 * is roughly 700 files across 23 numbered section folders, several of them
 * three levels deep. Until now the application had an upload dropzone and
 * nothing else, which meant an existing book could only enter it a file at
 * a time. That is why a complete book scored 14%: not because the work was
 * missing, but because nothing had walked the tree.
 *
 * This takes a directory listing — from the OneDrive connector, from
 * `dir /s /b` on Windows, or from `find` on macOS — and files every path
 * into the right section by its leading number.
 */
import type { DocumentRecord } from '@/lib/domain/types'
import type { RowIssue } from './types'

export interface TreeEntry {
  /** Path relative to the job book root, using forward slashes. */
  path: string
  sizeBytes?: number | null
  isFolder?: boolean
  modified?: string | null
}

/**
 * Match a top-level folder name to a section number.
 *
 * Keyed on the leading number, because the words after it are unreliable:
 * the DP-318 book's own folders read "Ultrasonic Testion", "Facilty Only",
 * "Certifed Welding Inspector" and "Non- Destructive". A matcher built on
 * the titles would drop four sections on spelling alone.
 */
export function sectionNumberForFolder(folderName: string): string | null {
  const m = folderName.trim().match(/^(\d{1,2})\s*[.\-—]?\s/)
  if (m) return String(Number(m[1]))
  return null
}

/** Folders that carry real deliverables but sit outside the checklist. */
export function isSupplementalFolder(folderName: string): boolean {
  return sectionNumberForFolder(folderName) === null && !!folderName.trim()
}

const ARCHIVE_RE = /\.(zip|7z|rar|tar|gz)$/i
const OFFICE_TEMP_RE = /(^|\/)~\$/

export type TreeDocument =
  Omit<DocumentRecord, 'jobBookId' | 'sectionId'> & { sectionNumber: string | null }

export interface FolderImportResult {
  documents: TreeDocument[]
  issues: RowIssue[]
  /** Files per section, for the preview. */
  countsBySection: Record<string, { files: number; bytes: number }>
  /** Top-level folders that match no checklist section. */
  supplementalFolders: string[]
  /** Sections whose folder exists but holds no files at all. */
  emptySections: string[]
  /** Deepest nesting seen, since a deep tree is a sign the listing must be
   *  recursive to be complete. */
  maxDepth: number
}

export function importFolderTree(
  entries: TreeEntry[],
  opts: { jobBookId: string; knownSectionNumbers: string[] },
): FolderImportResult {
  const issues: RowIssue[] = []
  const countsBySection: Record<string, { files: number; bytes: number }> = {}
  const supplemental = new Set<string>()
  const sectionsSeen = new Set<string>()
  const sectionsWithFiles = new Set<string>()
  const documents: TreeDocument[] = []
  let maxDepth = 0

  for (const e of entries) {
    const path = e.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path) continue
    if (OFFICE_TEMP_RE.test(path)) continue          // Excel lock files
    const parts = path.split('/').filter(Boolean)
    maxDepth = Math.max(maxDepth, parts.length)

    const top = parts[0]!
    const sectionNumber = sectionNumberForFolder(top)
    if (sectionNumber) sectionsSeen.add(sectionNumber)
    else supplemental.add(top)

    if (e.isFolder) continue

    const filename = parts[parts.length - 1]!
    const bytes = e.sizeBytes ?? 0

    if (sectionNumber) {
      sectionsWithFiles.add(sectionNumber)
      const c = countsBySection[sectionNumber] ?? { files: 0, bytes: 0 }
      c.files++
      c.bytes += bytes
      countsBySection[sectionNumber] = c

      if (!opts.knownSectionNumbers.includes(sectionNumber)) {
        issues.push({ severity: 'warning', sheet: top, row: 0,
          message: `Folder "${top}" maps to section ${sectionNumber}, which this book's template ` +
            `does not define. The files are imported unfiled.` })
      }
    }

    if (ARCHIVE_RE.test(filename)) {
      issues.push({ severity: 'info', sheet: top, row: 0,
        message: `${path} is an archive. Its contents are invisible to indexing, hashing and every ` +
          `reconciliation report here — expand it so each document is filed individually ` +
          `(${(bytes / 1_048_576).toFixed(1)} MB).` })
    }

    documents.push({
      id: `${opts.jobBookId}:doc:${path.toLowerCase()}`,
      sectionNumber,
      recordType: null,
      recordId: null,
      originalFilename: filename,
      // The path within the section carries real meaning in this tree —
      // construction area, then isometric group — so it is preserved
      // rather than flattened away.
      normalizedFilename: parts.slice(1).join('/') || filename,
      storagePath: path,
      mimeType: mimeFor(filename),
      byteSize: bytes,
      sha256: `path:${path.toLowerCase()}`,
      pageCount: null,
      version: 1,
      supersedesDocumentId: null,
      isSuperseded: false,
      visibility: 'client',
      uploadedBy: null,
      uploadedAt: e.modified ?? new Date().toISOString(),
      approvedBy: null,
      approvedAt: null,
      deletedAt: null,
    })
  }

  const emptySections = [...sectionsSeen].filter((n) => !sectionsWithFiles.has(n)).sort()
  for (const n of emptySections) {
    issues.push({ severity: 'warning', sheet: `section ${n}`, row: 0,
      message: `Section ${n}'s folder exists but holds no files.` })
  }
  if (maxDepth < 3) {
    issues.push({ severity: 'warning', sheet: '', row: 0,
      message: `This listing is at most ${maxDepth} level(s) deep. The DP-318 tree nests three ` +
        `deep in places (section → construction area → isometric), so a non-recursive listing ` +
        `will under-count badly. Re-export with a recursive listing if that is what happened.` })
  }

  return {
    documents, issues, countsBySection,
    supplementalFolders: [...supplemental].sort(),
    emptySections,
    maxDepth,
  }
}

function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  return {
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.zip': 'application/zip',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  }[ext] ?? 'application/octet-stream'
}

/**
 * Parse a plain listing: one path per line, optionally `path<TAB>bytes`.
 * Accepts Windows `dir /s /b` output (absolute paths, backslashes) and
 * `find` output, trimming everything above the job book root.
 */
export function parsePlainListing(text: string, rootFolderName?: string): TreeEntry[] {
  const out: TreeEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const [pathPart, sizePart] = line.split('\t')
    let path = (pathPart ?? '').replace(/\\/g, '/')
    if (rootFolderName) {
      const idx = path.toLowerCase().indexOf(rootFolderName.toLowerCase())
      if (idx >= 0) path = path.slice(idx + rootFolderName.length)
    }
    path = path.replace(/^\/+/, '')
    if (!path) continue
    const size = sizePart ? Number(sizePart.replace(/[^0-9]/g, '')) : null
    out.push({
      path,
      sizeBytes: Number.isFinite(size as number) ? (size as number) : null,
      // A trailing slash, or no extension, reads as a folder.
      isFolder: /\/$/.test(pathPart ?? '') || !/\.[a-z0-9]{1,5}$/i.test(path),
    })
  }
  return out
}
