'use client'

/**
 * Putting files into storage from the browser.
 *
 * The server is told where the bytes landed, not given the bytes. That
 * is the whole point: a serverless function body is capped far below
 * one section's worth of marked-up isometrics, and posting them
 * through it failed with a message about the server being unreachable.
 *
 * Uploads run a few at a time rather than all at once. Ninety parallel
 * PUTs from a site connection is how a browser's connection pool and a
 * storage API's rate limit both get hit at the same moment, and the
 * first casualty is the one upload that was nearly finished.
 */
import { createClient } from '@/lib/supabase/client'
import { DOCUMENT_BUCKET } from '@/lib/supabase/bucket'

/** Enough to keep a connection busy, few enough to stay polite. */
const CONCURRENCY = 3

export interface UploadTarget {
  originalFilename: string
  path: string
  token: string
}

export interface UploadProgress {
  /** Files finished, successfully or not. */
  done: number
  total: number
  /** What is being sent right now, for a line of status text. */
  current: string | null
}

export type DirectUploadResult =
  | { ok: true }
  | { ok: false; error: string; failed: string[] }

/**
 * Send each file to the path reserved for it.
 *
 * Matched to targets by filename. Two files chosen with the same name
 * in one batch would be ambiguous here, so targets are consumed in
 * order for a given name rather than looked up by it.
 */
export async function uploadDirect(
  files: readonly File[],
  targets: readonly UploadTarget[],
  onProgress?: (p: UploadProgress) => void,
): Promise<DirectUploadResult> {
  // Null in seed mode, where there is no storage to upload to. The
  // caller falls back to posting the bytes, which is what the demo has
  // always done.
  const supabase = createClient()
  if (!supabase) {
    return {
      ok: false, failed: [],
      error: 'Direct upload is not available here.',
    }
  }

  // Bound here rather than inside the worker: narrowing `supabase` to
  // non-null does not survive into a nested closure.
  const storage = supabase.storage.from(DOCUMENT_BUCKET)

  const queue = files.map((file, i) => ({ file, target: targets[i] }))
  const failed: string[] = []
  let done = 0

  // The targets came back in the order the files were sent, so index
  // is the pairing. A mismatch means the server answered a different
  // request than the one made, which is worth refusing outright rather
  // than uploading files to each other's paths.
  if (targets.length !== files.length) {
    return {
      ok: false,
      failed: [],
      error: 'The server reserved a different number of files than were chosen. '
        + 'Nothing was uploaded; choose them again.',
    }
  }

  async function worker() {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      const { file, target } = next
      if (!target) {
        failed.push(file.name)
        done += 1
        continue
      }

      onProgress?.({ done, total: files.length, current: file.name })
      const { error } = await storage
        .uploadToSignedUrl(target.path, target.token, file, {
          contentType: file.type || 'application/octet-stream',
        })
      if (error) failed.push(file.name)
      done += 1
      onProgress?.({ done, total: files.length, current: null })
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
  )

  if (failed.length > 0) {
    const names = failed.slice(0, 3).join(', ')
    const more = failed.length > 3 ? ` and ${failed.length - 3} more` : ''
    return {
      ok: false,
      failed,
      error: `${names}${more} did not finish uploading. Nothing has been filed — `
        + `try again, and only the files that failed need choosing.`,
    }
  }
  return { ok: true }
}
