/**
 * Folder-tree import.
 *
 * A delivered book arrives as a folder tree, and until this existed the
 * only way in was one upload at a time — which is why a complete DP-318
 * scored 14%. These pin the behaviours that make a bulk import trustworthy:
 * match sections by number rather than by title, never silently flatten a
 * meaningful path, and say so when a listing is too shallow to be complete.
 */
import { describe, expect, it } from 'vitest'
import {
  importFolderTree, parsePlainListing, sectionNumberForFolder,
} from '@/lib/import/folderTree'
import { buildTemplateSections } from '@/lib/domain/checklist'

const KNOWN = buildTemplateSections('facility', 't').map((d) => d.sectionNumber)

describe('matching a folder to a section', () => {
  it('reads the leading number, not the words after it', () => {
    expect(sectionNumberForFolder('12. Detailed Weld Log')).toBe('12')
    expect(sectionNumberForFolder('3. Chevron Piping Specification')).toBe('3')
  })

  it('survives the misspellings in the real tree', () => {
    // Every one of these is a folder name from the DP-318 book. A matcher
    // built on titles would drop all four.
    expect(sectionNumberForFolder('19. Ultrasonic Testion Locations and Baseline Results (Facilty Only)')).toBe('19')
    expect(sectionNumberForFolder('7. Certifed Welding Inspector Credentials')).toBe('7')
    expect(sectionNumberForFolder('10. Non- Destructive Testing Job Logs and Films')).toBe('10')
    expect(sectionNumberForFolder('22. Isometric Heat Number and Torque Map (Facilty only)')).toBe('22')
  })

  it('returns null for a folder that is not a numbered section', () => {
    expect(sectionNumberForFolder('DP-318 Hydro Test')).toBeNull()
    expect(sectionNumberForFolder('')).toBeNull()
  })
})

describe('importing a tree', () => {
  const entries = [
    { path: '13. Torque Wrench Calibration Certificates/0808.jpg', sizeBytes: 1574593 },
    { path: '13. Torque Wrench Calibration Certificates/9125.pdf', sizeBytes: 822926 },
    { path: '17. Pressure Testing Results/Test #1 B-Spec/chart.pdf', sizeBytes: 400000 },
    { path: '17. Pressure Testing Results/Test #14 A-Spec.zip', sizeBytes: 518454 },
    { path: '21. Isometric Weld and X-Ray Map (Facilty Only)/Construction Area 2100/1101A/iso.pdf',
      sizeBytes: 999905 },
    { path: '16. Pressure Testing Procedure', sizeBytes: 0, isFolder: true },
    { path: 'DP-318 Hydro Test/report.pdf', sizeBytes: 100 },
  ]
  const r = importFolderTree(entries, { jobBookId: 'b', knownSectionNumbers: KNOWN })

  it('files each document into its section', () => {
    expect(r.countsBySection['13']).toMatchObject({ files: 2 })
    expect(r.countsBySection['17']).toMatchObject({ files: 2 })
    expect(r.countsBySection['21']).toMatchObject({ files: 1 })
  })

  it('keeps the path inside a section, which carries the area and isometric', () => {
    const iso = r.documents.find((d) => d.sectionNumber === '21')!
    expect(iso.normalizedFilename).toBe('Construction Area 2100/1101A/iso.pdf')
    expect(iso.originalFilename).toBe('iso.pdf')
  })

  it('reports a section folder that exists but holds nothing', () => {
    expect(r.emptySections).toContain('16')
  })

  it('surfaces archives, whose contents nothing here can index', () => {
    expect(r.issues.some((i) => /Test #14.*archive/is.test(i.message))).toBe(true)
  })

  it('collects off-checklist top-level folders rather than dropping them', () => {
    expect(r.supplementalFolders).toContain('DP-318 Hydro Test')
  })

  it('gives every document a path-derived id, so a re-import is idempotent', () => {
    const again = importFolderTree(entries, { jobBookId: 'b', knownSectionNumbers: KNOWN })
    expect(again.documents.map((d) => d.id)).toEqual(r.documents.map((d) => d.id))
  })

  it('warns when a listing is too shallow to be a complete tree', () => {
    const shallow = importFolderTree(
      [{ path: '13. Torque/0808.jpg', sizeBytes: 1 }],
      { jobBookId: 'b', knownSectionNumbers: KNOWN },
    )
    expect(shallow.issues.some((i) => /at most 2 level/.test(i.message))).toBe(true)
    // The three-deep listing above must not trip the same warning.
    expect(r.issues.some((i) => /at most/.test(i.message))).toBe(false)
  })
})

describe('parsing a plain listing', () => {
  it('reads Windows dir /s /b output and trims above the book root', () => {
    const text = [
      'C:\\Users\\dd\\OneDrive\\1. Greeley Crescent Job book\\13. Torque\\0808.jpg',
      'C:\\Users\\dd\\OneDrive\\1. Greeley Crescent Job book\\15. MTRs\\heat.pdf',
    ].join('\n')
    const entries = parsePlainListing(text, '1. Greeley Crescent Job book')
    expect(entries.map((e) => e.path)).toEqual(['13. Torque/0808.jpg', '15. MTRs/heat.pdf'])
  })

  it('reads an optional tab-separated size', () => {
    const entries = parsePlainListing('13. Torque/0808.jpg\t1574593')
    expect(entries[0]).toMatchObject({ path: '13. Torque/0808.jpg', sizeBytes: 1574593 })
  })

  it('ignores Excel lock files, which are not deliverables', () => {
    const r = importFolderTree(
      parsePlainListing('15. MTRs/~$Heat Number Tracker.xlsx\n15. MTRs/heat.pdf'),
      { jobBookId: 'b', knownSectionNumbers: KNOWN },
    )
    expect(r.documents).toHaveLength(1)
  })
})
