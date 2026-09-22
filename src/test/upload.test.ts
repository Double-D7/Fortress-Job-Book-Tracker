/**
 * Uploading evidence into a section.
 *
 * This is the loop the whole application exists to serve: a tech declares
 * the scope at setup, then puts files in until the count is met. Every test
 * here is about the tech being told the truth *before* they commit rather
 * than by a flag a week later.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeFilename, prepareUpload, previewUploads, registerForSection,
} from '@/lib/domain/upload'
import { checkFilename } from '@/lib/domain/naming'
import { getDataProvider, type Viewer } from '@/lib/data/provider'
import { collectedOf, scoreBook, scoreSection } from '@/lib/domain/scoring'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { DocumentRecord } from '@/lib/domain/types'

const b = buildDp452Bundle()
const def = b.sectionDefinitions.find((d) => d.sectionNumber === '13')!
const section = b.sections.find((s) => s.sectionDefinitionId === def.id)!
const ctx = { book: b.book, section: def, sectionId: section.id, existing: [] as DocumentRecord[] }

const file = (name: string, sha = 'a'.repeat(64), size = 1024) =>
  ({ originalFilename: name, byteSize: size, sha256: sha, mimeType: 'application/pdf' })

describe('the name a file ships under, FDS-JBMP-001 Appendix B', () => {
  // Pattern: [SS]-[TYPE]-[IDENTIFIER]-[DESCRIPTOR]-[YYYYMMDD]-R[n].ext
  // The app used to produce "15 - DP452 MTR SU78500 3inch sch40 pipe.pdf",
  // which breaks the convention five ways at once.
  it('reproduces the worked examples from Appendix B', () => {
    expect(normalizeFilename('3inch SCH40 PIPE.pdf', '15', 'DP452', {
      typeCode: 'MTR', identifier: 'SU78500', documentDate: '2026-01-14', revision: 0,
    })).toBe('15-MTR-SU78500-3inch-SCH40-PIPE-20260114-R0.pdf')

    expect(normalizeFilename('600FT.pdf', '13', 'DP452', {
      typeCode: 'CAL', identifier: 'TQW1108', documentDate: '2025-02-13', revision: 0,
    })).toBe('13-CAL-TQW1108-600FT-20250213-R0.pdf')
  })

  it('defaults the type code from the section', () => {
    // §15 is Material Test Reports; a tech should not have to say so.
    expect(normalizeFilename('pipe.pdf', '15', 'DP452', {
      identifier: 'SU78500', documentDate: '2026-01-14',
    })).toMatch(/^15-MTR-/)
    expect(normalizeFilename('cert.pdf', '13', 'DP452', {
      identifier: 'TQW1108', documentDate: '2025-02-13',
    })).toMatch(/^13-CAL-/)
  })

  it('pads the section to two digits so files sort into section order', () => {
    expect(normalizeFilename('wpq.pdf', '6', 'DP452', {
      identifier: 'HS2', documentDate: '2024-09-18', revision: 1,
    })).toBe('06-WPQ-HS2-wpq-20240918-R1.pdf')
  })

  it('shows a gap rather than inventing an identifier or a date', () => {
    // §9.1: identity is never inferred from a filename. A guessed heat
    // number reads as a fact; NOID reads as unfinished.
    const n = normalizeFilename('a2350.pdf', '15', 'DP452')
    expect(n).toBe('15-MTR-NOID-a2350-NODATE-R0.pdf')
  })

  it('strips the status words and characters §9.2 forbids', () => {
    const n = normalizeFilename("Smith's FINAL cert (Copy) UPDATED.pdf", '13', 'DP452', {
      identifier: 'TQW1108', documentDate: '2025-02-13',
    })
    expect(n).not.toMatch(/FINAL|Copy|UPDATED|'|\(|\)/)
    expect(n).not.toMatch(/\s/)
  })

  it('does not double a section prefix the tech already typed', () => {
    for (const typed of ['13 - cert.pdf', '13. cert.pdf', '13_cert.pdf', 'Section 13 - cert.pdf']) {
      expect(normalizeFilename(typed, '13', 'DP452', {
        identifier: 'TQW1108', documentDate: '2025-02-13',
      })).toBe('13-CAL-TQW1108-cert-20250213-R0.pdf')
    }
  })

  it('drops a date carried in the source name', () => {
    // Appendix B: the date element is the one the document bears, not
    // whatever the file was called.
    expect(normalizeFilename('TWQ-1108 600LB 2-13-2025.pdf', '13', 'DP452', {
      identifier: 'TQW1108', documentDate: '2025-02-13',
    })).toBe('13-CAL-TQW1108-TWQ-1108-600LB-20250213-R0.pdf')
  })

  it('handles a range section and a file with no extension', () => {
    expect(normalizeFilename('iso maps', '19-22', 'DP452', {
      identifier: 'AREA7200', documentDate: '2026-02-20',
    })).toBe('19-22-MRK-AREA7200-iso-maps-20260220-R0')
  })

  it('recognises the baseline review\'s real bad names as non-conforming', () => {
    for (const bad of [
      "MTR's 3INCH SCH 40 PIPE SU78500, SQ80025, SU78494, SU78495.pdf",
      'a2350.pdf',
      'TWQ-1108 600LB 2-13-2025.pdf',
    ]) {
      expect(checkFilename(bad).length).toBeGreaterThan(0)
    }
    expect(checkFilename('15-MTR-SU78500-3in-SCH40-PIPE-20260114-R0.pdf')).toEqual([])
  })

  it('points a section at the right controlled register', () => {
    expect(registerForSection('15')).toBe('material_heat')
    expect(registerForSection('13')).toBe('torque_wrench')
    expect(registerForSection('6')).toBe('welder')
  })
})

describe('what a tech is told before committing', () => {
  it('refuses a file byte-identical to one already in the book', () => {
    const existing = b.documents.filter((d) => !d.deletedAt)
    const twin = existing[0]!
    const p = prepareUpload(
      file('renamed copy.pdf', twin.sha256), { ...ctx, existing },
    )
    expect(p.willBeAdded).toBe(false)
    expect(p.issues.find((i) => i.kind === 'duplicate_content')?.blocking).toBe(true)
    expect(p.issues[0]!.message).toContain(twin.originalFilename)
  })

  it('refuses an empty file', () => {
    const p = prepareUpload(file('scan.pdf', 'b'.repeat(64), 0), ctx)
    expect(p.willBeAdded).toBe(false)
    expect(p.issues.some((i) => i.kind === 'empty_file')).toBe(true)
  })

  it('warns when the filename names another job, but still files it', () => {
    const p = prepareUpload(file('DP517 wrench cert.pdf', 'c'.repeat(64)), ctx)
    const issue = p.issues.find((i) => i.kind === 'wrong_job_number')!
    expect(issue.blocking).toBe(false)
    // A tech who knows the filename is just wrong must be able to proceed;
    // a tech who has grabbed the wrong file must be told. Only one of those
    // is knowable here, so it warns and files.
    expect(p.willBeAdded).toBe(true)
    expect(issue.message).toContain('DP517')
  })

  it('treats a same-name upload as a revision, not a duplicate', () => {
    const existing: DocumentRecord[] = [{
      id: 'doc-old', jobBookId: b.book.id, sectionId: section.id,
      originalFilename: 'cert.pdf', normalizedFilename: '13 - DP452 cert.pdf',
      storagePath: 'x', sha256: 'd'.repeat(64), byteSize: 10, version: 1,
      isSuperseded: false, visibility: 'internal', uploadedAt: '2025-01-01T00:00:00Z',
    }]
    const p = prepareUpload(file('cert.pdf', 'e'.repeat(64)), { ...ctx, existing })
    expect(p.willBeAdded).toBe(true)
    expect(p.version).toBe(2)
    expect(p.supersedesDocumentId).toBe('doc-old')
  })

  it('says an archive counts as one document and is not indexed', () => {
    const p = prepareUpload(file('section 17 packs.zip', 'f'.repeat(64)), ctx)
    expect(p.issues.some((i) => i.kind === 'archive')).toBe(true)
    expect(p.willBeAdded).toBe(true)
  })

  it('catches two identical files inside one batch', () => {
    // Both are new to the book, so checking each against the book alone
    // would let both through and ship the same page twice.
    const same = 'aa'.repeat(32)
    const preview = previewUploads(
      [file('cert.pdf', same), file('cert copy.pdf', same)], ctx,
    )
    expect(preview.files[0]!.willBeAdded).toBe(true)
    expect(preview.files[1]!.willBeAdded).toBe(false)
    expect(preview.blocked).toBe(1)
  })

  it('shows the count moving toward the declared scope', () => {
    const preview = previewUploads(
      [file('a.pdf', '1'.repeat(64)), file('b.pdf', '2'.repeat(64))],
      { ...ctx, expectedCount: 5 },
    )
    expect(preview.countBefore).toBe(0)
    expect(preview.countAfter).toBe(2)
    expect(preview.expectedCount).toBe(5)
  })

  it('does not count a revision as a new document', () => {
    const existing: DocumentRecord[] = [{
      id: 'doc-old', jobBookId: b.book.id, sectionId: section.id,
      originalFilename: 'cert.pdf', normalizedFilename: '13 - DP452 cert.pdf',
      storagePath: 'x', sha256: '9'.repeat(64), byteSize: 10, version: 1,
      isSuperseded: false, visibility: 'internal', uploadedAt: '2025-01-01T00:00:00Z',
    }]
    const preview = previewUploads([file('cert.pdf', '8'.repeat(64))], { ...ctx, existing })
    expect(preview.countBefore).toBe(1)
    expect(preview.countAfter).toBe(1)
  })
})

describe('committing an upload', () => {
  const viewer: Viewer = {
    id: 'user-tech', email: 'tech@fortressds.com', fullName: 'Test Tech',
    role: 'qaqc_tech', clientOrgId: null,
  }

  it('files the document and shows the tech it landed', async () => {
    const p = getDataProvider()
    const before = await p.getBundle(viewer, 'book-dp452')
    const d = before!.sectionDefinitions.find((x) => x.sectionNumber === '16')!
    const s = before!.sections.find((x) => x.sectionDefinitionId === d.id)!
    expect(collectedOf(scoreSection(d, s, before!))).toBe(0)

    const res = await p.addDocuments(viewer, 'book-dp452', '16', [{
      ...file('pressure test procedure.pdf', '7'.repeat(64), 2048),
      classification: { identifier: 'HYDRO-A', documentDate: '2026-01-05' },
    }])
    expect(res.ok).toBe(true)
    expect(res.added).toHaveLength(1)
    // Appendix B, with the type code defaulted from the section.
    expect(res.added[0]!.normalizedFilename)
      .toBe('16-PRC-HYDRO-A-pressure-test-procedure-20260105-R0.pdf')

    const after = await p.getBundle(viewer, 'book-dp452')
    const s2 = after!.sections.find((x) => x.sectionDefinitionId === d.id)!
    const score = scoreSection(d, s2, after!)

    // Collected moves the moment the file lands — that is the tech's
    // feedback that the upload worked.
    expect(collectedOf(score)).toBe(100)
    // The compliance figure does not, because nobody has approved it yet.
    // Softening that would make the headline a claim no second person had
    // checked, which is the two-person control the book turns on.
    expect(score.pct).toBe(0)
    expect(score.explanation).toContain('awaiting approval')

    // Section 16 was empty and required; uploading is evidence arriving.
    expect(s2.status).not.toBe('not_started')
    expect(s2.ingestionStatus).toBe('imported')
    // And both cached figures moved with it rather than going stale.
    expect(s2.computedPct).toBe(score.pct)
    expect(s2.collectedPct).toBe(collectedOf(score))
  })

  it('never reports collected below approved', async () => {
    const p = getDataProvider()
    for (const summary of await p.listJobBooks(viewer)) {
      const b = (await p.getBundle(viewer, summary.id))!
      const score = scoreBook(b)
      expect(score.collectedPct).toBeGreaterThanOrEqual(score.overallPct)
      for (const sec of score.sections) {
        expect(collectedOf(sec)).toBeGreaterThanOrEqual(sec.pct)
      }
    }
  })

  it('re-checks at commit rather than trusting the preview', async () => {
    const p = getDataProvider()
    const sha = '6'.repeat(64)
    const first = await p.addDocuments(viewer, 'book-dp452', '20', [file('as-built.pdf', sha)])
    expect(first.added).toHaveLength(1)
    // A second tech whose preview was taken before that commit.
    const second = await p.addDocuments(viewer, 'book-dp452', '20', [file('same thing.pdf', sha)])
    expect(second.added).toHaveLength(0)
    expect(second.rejected[0]!.reason).toContain('identical')
  })

  it('turns a read-only viewer away', async () => {
    const res = await getDataProvider().addDocuments(
      { id: 'u-ro', email: 'ro@x', fullName: 'RO', role: 'fortress_read_only', clientOrgId: null },
      'book-dp452', '16', [file('x.pdf', '5'.repeat(64))],
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/[Nn]ot permitted/)
  })

  it('will not invent a section that is not in the book', async () => {
    const res = await getDataProvider().addDocuments(
      viewer, 'book-dp452', '99', [file('x.pdf', '4'.repeat(64))],
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('99')
  })
})
