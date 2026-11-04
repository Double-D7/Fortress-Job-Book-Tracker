/**
 * Direct-to-storage uploads.
 *
 * A section of marked-up isometrics could not be uploaded at all: every
 * document was posted as a multipart body to a serverless function, and
 * the platform caps that body far below one section's worth of scans.
 * Now the browser puts each file straight into storage and the server
 * is told only where it landed.
 *
 * The contract that must NOT change is who does the hashing. The
 * duplicate check is one of the things this application exists to do,
 * and it stays the server's finding rather than the browser's word.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_BYTES, MAX_STAGED_FILES, finalPath, stagingPath,
  validateStagingRequest,
} from '@/lib/domain/staging'

const mb = (n: number) => Math.round(n * 1024 * 1024)
const BOOK = '328b34d1-e5b2-469c-b061-bca62254cfbb'

describe('where a file waits', () => {
  it('stages under the book id, so the existing storage policies apply', () => {
    // `storage_object_book_id()` (0010) reads the first path segment as
    // the book uuid and every bucket policy is built on it. Staging
    // anywhere else would need a second set of rules to keep in step.
    const path = stagingPath(BOOK, 'upload-1', 0)
    expect(path.split('/')[0]).toBe(BOOK)
    expect(path).toBe(`${BOOK}/_staging/upload-1/0`)
  })

  it('cannot collide with a section', () => {
    // Section numbers are digits and hyphens; none begins with "_".
    expect(stagingPath(BOOK, 'u', 0).split('/')[1]).toBe('_staging')
    expect(finalPath(BOOK, '19-22', 'a'.repeat(64)).split('/')[1]).toBe('19-22')
  })

  it('files to a content-addressed path, unchanged from before', () => {
    const sha = 'b'.repeat(64)
    expect(finalPath(BOOK, '19-22', sha)).toBe(`${BOOK}/19-22/${sha}`)
  })

  it('gives each file in a batch its own path', () => {
    const paths = [0, 1, 2].map((i) => stagingPath(BOOK, 'u', i))
    expect(new Set(paths).size).toBe(3)
  })
})

describe('what may be staged', () => {
  const file = (name: string, size: number) => ({ name, size })

  it('accepts an ordinary batch', () => {
    expect(validateStagingRequest([file('iso-1.pdf', mb(8)), file('iso-2.pdf', mb(12))]))
      .toEqual([])
  })

  it('accepts a file far larger than a request body could carry', () => {
    // The whole point. 40 MB would never have reached the old route.
    expect(validateStagingRequest([file('big-iso.pdf', mb(40))])).toEqual([])
  })

  it('refuses an empty batch', () => {
    expect(validateStagingRequest([])).toHaveLength(1)
  })

  it('refuses a zero-byte file by name', () => {
    const problems = validateStagingRequest([file('good.pdf', mb(1)), file('empty.pdf', 0)])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.file).toBe('empty.pdf')
  })

  it('refuses one file over the sanity bound', () => {
    const problems = validateStagingRequest([file('mis-scan.pdf', MAX_FILE_BYTES + 1)])
    expect(problems[0]!.message).toMatch(/limit for one file is 100 MB/)
  })

  it('reports every bad file at once, not the first', () => {
    // Somebody who picked 40 files should be told about all four bad
    // ones now, not discover them one upload at a time.
    const problems = validateStagingRequest([
      file('ok.pdf', mb(1)),
      file('empty-a.pdf', 0),
      file('empty-b.pdf', 0),
      file('huge.pdf', MAX_FILE_BYTES + 1),
    ])
    expect(problems).toHaveLength(3)
    expect(problems.map((p) => p.file))
      .toEqual(['empty-a.pdf', 'empty-b.pdf', 'huge.pdf'])
  })

  it('refuses a batch with more files than the commit can walk', () => {
    const many = Array.from({ length: MAX_STAGED_FILES + 1 }, (_, i) =>
      file(`iso-${i}.pdf`, mb(1)))
    expect(validateStagingRequest(many)[0]!.message).toMatch(/limit is 200/)
  })

  it('refuses a file with no name', () => {
    expect(validateStagingRequest([file('  ', mb(1))])).toHaveLength(1)
  })
})
