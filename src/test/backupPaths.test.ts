/**
 * The backup folder's shape.
 *
 * Every case here is a way a compliance record could quietly end up
 * somewhere nobody looks: a section split in two by a slash in its own
 * title, a replaced document overwriting the version it replaced, a file
 * landing one level up because its name reduced to nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PATH, UNFILED, bookFolder, dataPath, documentPath, joinPath,
  libraryPath, pathTooLong, safeSegment, sectionFolder, supersededPath,
} from '@/lib/domain/backupPaths'

const BOOK = { code: 'DP-318', name: 'Greeley Crescent Facility' }

/** The app's real facility section titles, numbers as stored. */
const SECTIONS = [
  { sectionNumber: '1', title: 'Job Book Checklist' },
  { sectionNumber: '2', title: 'Facility / Flow Line Overview' },
  { sectionNumber: '15', title: 'Material Test Reports' },
  { sectionNumber: '16', title: 'Pressure Testing Procedure with P&ID Valve Orientation' },
  { sectionNumber: 'S1', title: 'Flexpipe Daily Field Reports' },
]

describe('a section title that contains a slash', () => {
  it('does not become two folders', () => {
    // The bug this file exists for. Section 2 of every facility book is
    // titled "Facility / Flow Line Overview"; concatenated naively it
    // nests, and a whole section goes missing from the backup.
    const folder = sectionFolder(SECTIONS[1]!)
    expect(folder).not.toContain('/')
    expect(folder).toBe('2. Facility - Flow Line Overview')
  })

  it('stays readable rather than losing the separator', () => {
    // Deleting the slash would give "Facility  Flow Line Overview", which
    // reads as a typo somebody would try to correct.
    expect(sectionFolder(SECTIONS[1]!)).not.toMatch(/ {2}/)
  })

  it('rejects every character OneDrive refuses', () => {
    for (const ch of ['"', '*', ':', '<', '>', '?', '/', '\\', '|']) {
      const out = safeSegment(`Weld ${ch} Log`)
      expect(out, ch).not.toContain(ch)
    }
  })
})

describe('section folders', () => {
  it('numbers them the way the original tree did', () => {
    expect(sectionFolder(SECTIONS[0]!)).toBe('1. Job Book Checklist')
    expect(sectionFolder(SECTIONS[2]!)).toBe('15. Material Test Reports')
  })

  it('keeps an ampersand, which is legal and part of the title', () => {
    // Over-sanitising is its own bug: "P&ID" becoming "P-ID" makes the
    // folder not match the document it holds.
    expect(sectionFolder(SECTIONS[3]!)).toContain('P&ID')
  })

  it('handles a supplemental section number', () => {
    expect(sectionFolder(SECTIONS[4]!)).toBe('S1. Flexpipe Daily Field Reports')
  })
})

describe('book folders', () => {
  it('leads with the code, because that is what people say', () => {
    expect(bookFolder(BOOK)).toBe('DP-318 Greeley Crescent Facility')
  })

  it('does not repeat the code when the name is the code', () => {
    expect(bookFolder({ code: 'DP452', name: 'DP452' })).toBe('DP452')
  })
})

describe('documents', () => {
  it('files a document under its book and section', () => {
    expect(joinPath(documentPath(BOOK, SECTIONS[2]!, 'MTR_D07821.pdf')))
      .toBe('DP-318 Greeley Crescent Facility/15. Material Test Reports/MTR_D07821.pdf')
  })

  it('files a sectionless document somewhere a person will find it', () => {
    // Dropping it would be the worst outcome: a document that exists in
    // the app and nowhere in the backup, with nothing to show for it.
    const p = documentPath(BOOK, null, 'scan.pdf')
    expect(p.folders[1]).toBe(UNFILED)
  })

  it('sanitises the filename too, not just the folders', () => {
    expect(documentPath(BOOK, SECTIONS[0]!, 'weld log: rev 2.pdf').filename)
      .toBe('weld log- rev 2.pdf')
  })
})

describe('superseded documents', () => {
  it('keeps them, dated, rather than overwriting', () => {
    expect(joinPath(supersededPath(BOOK, 'WPS-1.pdf', '2026-09-23T14:02:00Z')))
      .toBe('DP-318 Greeley Crescent Facility/_superseded/2026-09-23/WPS-1.pdf')
  })

  it('does not let a document replaced twice overwrite its own history', () => {
    // The lossy case. Without the date, the second replacement would
    // destroy the first — in the one folder that exists so nothing is
    // ever destroyed.
    const first = joinPath(supersededPath(BOOK, 'WPS-1.pdf', '2026-09-23'))
    const second = joinPath(supersededPath(BOOK, 'WPS-1.pdf', '2026-10-01'))
    expect(first).not.toBe(second)
  })
})

describe('generated exports and the shared library', () => {
  it('puts data exports in their own folder', () => {
    expect(joinPath(dataPath(BOOK, 'weld-log.tsv')))
      .toBe('DP-318 Greeley Crescent Facility/_data/weld-log.tsv')
  })

  it('puts the mill certificate library outside any one book', () => {
    // The certificate for a heat is the same certificate wherever that
    // steel was used; filing it under one book would misrepresent that.
    const p = libraryPath('MTR_KZ9.pdf')
    expect(p.folders[0]).toBe('_library')
    expect(joinPath(p)).not.toContain('DP-318')
  })
})

describe('names that could put a file in the wrong place', () => {
  it('never produces an empty segment', () => {
    // An empty folder name collapses the path and the file lands one
    // level up, joining a folder it does not belong to.
    for (const raw of ['', '   ', '///', '...', '~$']) {
      expect(safeSegment(raw).length, JSON.stringify(raw)).toBeGreaterThan(0)
    }
  })

  it('does not end a name with a space or a period', () => {
    // Windows cannot create either, and the upload fails for a reason
    // nobody reads.
    for (const raw of ['Section 2 ', 'Section 2.', 'Section 2 . ']) {
      const out = safeSegment(raw)
      expect(out.endsWith(' '), raw).toBe(false)
      expect(out.endsWith('.'), raw).toBe(false)
    }
  })

  it('escapes a Windows device name', () => {
    for (const name of ['CON', 'prn', 'AUX', 'NUL', 'COM1', 'lpt9']) {
      expect(safeSegment(name), name).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i)
    }
  })

  it('leaves an ordinary name completely alone', () => {
    // Sanitising that mangles good input is its own failure.
    for (const name of [
      'MTR_D07821.pdf', '2 CL300 FLG KL5.pdf', 'DP-318 Hydro Test',
      'Welder Performance Qualifications (WPQ)', 'P&ID rev 3.pdf',
    ]) {
      expect(safeSegment(name), name).toBe(name)
    }
  })
})

describe('path length', () => {
  it('reports a path SharePoint would refuse rather than truncating it', () => {
    // Truncation would give two documents the same name, and one would
    // overwrite the other in a folder meant to lose nothing.
    const long = documentPath(BOOK, SECTIONS[2]!, `${'a'.repeat(MAX_PATH)}.pdf`)
    expect(pathTooLong(long)).toBe(true)
    expect(long.filename).toContain('a'.repeat(MAX_PATH))
  })

  it('passes an ordinary path', () => {
    expect(pathTooLong(documentPath(BOOK, SECTIONS[2]!, 'MTR_D07821.pdf'))).toBe(false)
  })
})
