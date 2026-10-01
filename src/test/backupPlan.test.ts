/**
 * What the nightly backup decides to do, before any of it touches Graph.
 *
 * The run itself is Deno and talks to Microsoft, so it is not what these
 * cases exercise. What they exercise is the part that would quietly ruin
 * a backup without failing: where a file lands, when it is skipped, and
 * what happens to the copy already there when a document is replaced.
 *
 * The one thing a backup must never do is lose a version. A document
 * replaced twice in a week has three states worth keeping, and a naive
 * "overwrite in place" keeps one.
 */
import { describe, expect, it } from 'vitest'
import {
  DATA_FOLDER, LIBRARY_FOLDER, MAX_PATH, SUPERSEDED_FOLDER, UNFILED,
  bookFolder, dataPath, documentPath, joinPath, libraryPath, pathTooLong,
  safeSegment, sectionFolder, supersededPath,
} from '../../supabase/functions/_shared/backupPaths'

const BOOK = { code: 'DP-318', name: 'Greeley Crescent Facility' }

describe('where a document lands', () => {
  it('goes under its book and its numbered section', () => {
    const p = documentPath(
      BOOK, { sectionNumber: '13', title: 'Torque Wrench Calibration' }, 'UNEX 5155.pdf')
    expect(joinPath(p)).toBe(
      'DP-318 Greeley Crescent Facility/13. Torque Wrench Calibration/UNEX 5155.pdf')
  })

  it('still gets filed when it belongs to a record rather than a section', () => {
    // Dropping these would make the backup quietly smaller than the book.
    const p = documentPath(BOOK, null, 'loose.pdf')
    expect(p.folders[1]).toBe(UNFILED)
    expect(joinPath(p)).toContain(UNFILED)
  })

  it('never lets a section title turn into two folders', () => {
    // "Facility / Flow Line Overview" is a real section title, and a
    // slash in a folder name does not fail — it silently changes the
    // shape of the tree, so a whole section goes missing where nobody
    // thinks to look.
    const p = documentPath(
      BOOK, { sectionNumber: '2', title: 'Facility / Flow Line Overview' }, 'x.pdf')
    expect(p.folders[1]).not.toContain('/')
    expect(joinPath(p).split('/')).toHaveLength(3)
  })
})

describe('a document that has been replaced', () => {
  it('is kept under a dated folder rather than overwritten', () => {
    const p = supersededPath(BOOK, 'RT-031.pdf', '2026-09-29T14:00:00Z')
    expect(p.folders).toEqual([bookFolder(BOOK), SUPERSEDED_FOLDER, '2026-09-29'])
  })

  it('does not collide with its own earlier version', () => {
    // Replaced twice is the case that makes a retention folder lossy if
    // the date is left off.
    const first = joinPath(supersededPath(BOOK, 'RT-031.pdf', '2026-09-01T00:00:00Z'))
    const second = joinPath(supersededPath(BOOK, 'RT-031.pdf', '2026-09-29T00:00:00Z'))
    expect(first).not.toBe(second)
  })

  it('leaves the live path free for the replacement', () => {
    const live = joinPath(documentPath(BOOK, { sectionNumber: '10', title: 'NDE' }, 'RT-031.pdf'))
    const aside = joinPath(supersededPath(BOOK, 'RT-031.pdf', '2026-09-29T00:00:00Z'))
    expect(aside).not.toBe(live)
  })
})

describe('the folders that are not a section', () => {
  it('puts a mill certificate outside any one book', () => {
    // The certificate for a heat is the same certificate wherever that
    // heat was welded, so filing a copy per book would multiply it.
    expect(joinPath(libraryPath('D07821.pdf')))
      .toBe(`${LIBRARY_FOLDER}/Material Test Reports/D07821.pdf`)
  })

  it('keeps generated exports apart from filed evidence', () => {
    expect(dataPath(BOOK, 'welds.csv').folders[1]).toBe(DATA_FOLDER)
  })
})

describe('names SharePoint would refuse', () => {
  it('strips the characters that are rejected outright', () => {
    expect(safeSegment('a"b*c:d<e>f?g|h')).not.toMatch(/["*:<>?|]/)
  })

  it('does not produce an empty segment from a name made only of them', () => {
    // An empty folder name is a path with a doubled slash, which is a
    // different place from the one intended.
    expect(safeSegment('???').length).toBeGreaterThan(0)
  })

  it('reports an over-long path rather than truncating it', () => {
    // Truncating would give two documents one filename, which loses one
    // of them — the precise failure the backup exists to prevent.
    const long = documentPath(BOOK, { sectionNumber: '15', title: 'MTRs' }, `${'x'.repeat(MAX_PATH)}.pdf`)
    expect(pathTooLong(long)).toBe(true)
    expect(joinPath(long)).toContain('x'.repeat(50))
  })

  it('accepts an ordinary path', () => {
    expect(pathTooLong(documentPath(BOOK, { sectionNumber: '13', title: 'Calibration' }, 'a.pdf')))
      .toBe(false)
  })
})

describe('the section folder', () => {
  it('leads with the number, which is what anyone navigates by', () => {
    expect(sectionFolder({ sectionNumber: '21', title: 'Isometric Weld and X-Ray Map' }))
      .toMatch(/^21\. /)
  })
})
