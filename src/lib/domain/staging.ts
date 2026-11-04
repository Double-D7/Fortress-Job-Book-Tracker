/**
 * Where a file waits between the browser and the book.
 *
 * A document used to travel to the server inside a multipart request
 * body. The platform refuses a function body of any real size, so a
 * section's worth of marked-up isometrics could not be uploaded at
 * all — and the refusal arrived as "Could not reach the server",
 * which sent the one person who could have fixed it to look at their
 * wifi.
 *
 * Now the browser puts each file straight into storage and the server
 * is told only where it landed. These are the rules about that place,
 * kept here because both the route and its tests need to agree on them
 * and neither should be the definition.
 */
import type { TypeCode } from './naming'

/**
 * The most one file may be.
 *
 * Not a platform limit any more — nothing here passes through a
 * function body. It is a sanity bound: a construction document that
 * runs past this is a mis-scan or the wrong file, and finding that out
 * before the upload beats finding out after it.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_FILE_LABEL = '100 MB'

/** How many files one batch may stage. The commit walks them one at a
 *  time, so this bounds how long that walk can be. */
export const MAX_STAGED_FILES = 200

export interface StagedFileRequest {
  name: string
  size: number
  mimeType?: string | null
}

export interface StagingClassification {
  typeCode?: TypeCode | string | null
  identifier?: string | null
  documentDate?: string | null
}

/**
 * Staging lives under the book id, deliberately.
 *
 * `storage_object_book_id()` (migration 0010) reads the first path
 * segment as the book's uuid, and every storage policy on the bucket
 * is built on that. Nesting staging under the same first segment means
 * a half-uploaded file is protected by exactly the rules a filed
 * document is, with no second policy to keep in step.
 *
 * `_staging` cannot collide with a section: section numbers are digits
 * and hyphens, and never begin with an underscore.
 */
export function stagingPath(
  jobBookId: string, uploadId: string, index: number,
): string {
  return `${jobBookId}/_staging/${uploadId}/${index}`
}

/** Where a file ends up once it is filed. Content-addressed, so the
 *  same bytes always land on the same path and a retry overwrites
 *  rather than orphaning. Unchanged from the multipart path — the
 *  commit moves an object here rather than writing one. */
export function finalPath(
  jobBookId: string, sectionNumber: string, sha256: string,
): string {
  return `${jobBookId}/${sectionNumber}/${sha256}`
}

export interface StagingProblem { file: string; message: string }

/**
 * What is wrong with this batch before a byte moves.
 *
 * Returns every problem rather than the first: somebody who picked 40
 * files should be told about all four bad ones at once, not made to
 * discover them one upload at a time.
 */
export function validateStagingRequest(
  files: readonly StagedFileRequest[],
): StagingProblem[] {
  const out: StagingProblem[] = []

  if (files.length === 0) {
    out.push({ file: '', message: 'No files were chosen.' })
    return out
  }
  if (files.length > MAX_STAGED_FILES) {
    out.push({
      file: '',
      message: `${files.length} files in one batch; the limit is ${MAX_STAGED_FILES}. `
        + 'Upload it in smaller batches.',
    })
    return out
  }

  for (const f of files) {
    const name = (f.name ?? '').trim()
    if (!name) {
      out.push({ file: '', message: 'A file arrived with no name.' })
      continue
    }
    if (!Number.isFinite(f.size) || f.size <= 0) {
      out.push({ file: name, message: `${name} is empty.` })
      continue
    }
    if (f.size > MAX_FILE_BYTES) {
      out.push({
        file: name,
        message: `${name} is ${(f.size / 1024 / 1024).toFixed(1)} MB; `
          + `the limit for one file is ${MAX_FILE_LABEL}.`,
      })
    }
  }
  return out
}
