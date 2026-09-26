/**
 * Sections 21 and 22: the drawings the logs say are owed.
 *
 * These were scored by counting approved documents in the section against
 * the isometrics the logs reference, with nothing checking they were the
 * same isometrics. A book could file 196 drawings of entirely different
 * lines — or one drawing 196 times — and read 100% against 196 owed.
 * DP-318's torque log references 196 isometrics, so that is not a
 * hypothetical shape.
 */
import { describe, expect, it } from 'vitest'
import {
  attributeDrawing, isometricSectionCoverage, parseIsometricNumber,
} from '@/lib/domain/isometrics'
import { scoreSection } from '@/lib/domain/scoring'
import {
  evaluateFlags, ruleDrawingNotAttributable, ruleIsometricDrawingMissing,
} from '@/lib/domain/flags'
import { buildGreeleyBundle } from '@/lib/data/seed/greeley'
import type {
  DocumentRecord, JobBookBundle, JobBookSection, SectionDefinition,
} from '@/lib/domain/types'

/** Real DP-318 line numbers, as the torque log writes them. */
const A = '2-PF-2031101A-DCN'
const B = '3-PF-2051101A-BCM'
const C = '4-PG-2131101A-BCM'

function drawing(filename: string, over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: filename, jobBookId: 'b', sectionId: 's21', originalFilename: filename,
    normalizedFilename: filename, storagePath: `21/${filename}`, sha256: 'x',
    version: 1, isSuperseded: false, visibility: 'internal',
    uploadedAt: '2025-01-01T00:00:00Z', approvedAt: '2025-01-02T00:00:00Z',
    ...over,
  } as DocumentRecord
}

describe('which isometric a drawing covers', () => {
  it('prefers the tag a person chose at upload', () => {
    // A choice beats an inference. The upload screen already offers the
    // isometrics the logs reference.
    const d = drawing('scan0042.pdf', { recordType: 'isometric', recordId: A })
    expect(attributeDrawing(d)).toEqual({ kind: 'tagged', isometric: A })
  })

  it('falls back to the line number in the filename', () => {
    expect(attributeDrawing(drawing(`FLG ${A} Rev 2.pdf`)))
      .toEqual({ kind: 'filename', isometric: A })
  })

  it('refuses rather than guessing when it has neither', () => {
    // The drawing is filed and ships with the package. It counts toward
    // no isometric, and saying so is what lets somebody tag it.
    expect(attributeDrawing(drawing('scan0042.pdf')).isometric).toBeNull()
  })

  it('reads a line number through the decoration a real filename carries', () => {
    expect(parseIsometricNumber('FLG 2-PF-2031101A-DCN (THRD) - Copy..pdf')).toBe(A)
  })
})

describe('coverage against what the logs reference', () => {
  it('counts an isometric covered only when a drawing names it', () => {
    const cov = isometricSectionCoverage('21', [A], [B, C], [drawing(`${A}.pdf`)])
    expect(cov.referenced).toEqual([A, B, C].sort())
    expect(cov.covered).toEqual([A])
    expect(cov.missing).toEqual([B, C].sort())
  })

  it('does not let three drawings of one line cover three lines', () => {
    // The old arithmetic: three approved documents over three referenced
    // isometrics is 100%.
    const cov = isometricSectionCoverage('21', [], [A, B, C], [
      drawing(`${A}.pdf`), drawing(`${A} Rev 1.pdf`), drawing(`${A} Rev 2.pdf`),
    ])
    expect(cov.coveragePct).toBeCloseTo(100 / 3)
    expect(cov.missing).toEqual([B, C].sort())
  })

  it('names drawings that cover a line neither log references', () => {
    // Not a fault on its own — a line may be drawn before it is welded —
    // but a book whose drawings are all extraneous is filed against the
    // wrong job.
    const cov = isometricSectionCoverage('21', [], [A], [drawing(`${B}.pdf`)])
    expect(cov.extraneous).toEqual([B])
    expect(cov.covered).toEqual([])
  })

  it('names drawings that cover nothing at all', () => {
    const cov = isometricSectionCoverage('21', [], [A], [drawing('scan0042.pdf')])
    expect(cov.unattributable).toEqual(['scan0042.pdf'])
    expect(cov.coveragePct).toBe(0)
  })

  it('reports nothing rather than dividing by zero on a book with no logs', () => {
    const cov = isometricSectionCoverage('21', [], [], [])
    expect(cov.coveragePct).toBe(0)
    expect(cov.referenced).toEqual([])
  })

  it('keeps the two logs distinguishable, since a drawing is owed for either', () => {
    const cov = isometricSectionCoverage('22', [A], [B], [])
    expect(cov.fromWeldLog).toEqual([A])
    expect(cov.fromTorqueLog).toEqual([B])
    expect(cov.referenced).toHaveLength(2)
  })
})

describe('the markup sign-off in the filename', () => {
  it('reads section 21 as marked up on one checkmark', () => {
    const cov = isometricSectionCoverage('21', [], [A], [drawing(`${A} ✔︎.pdf`)])
    expect(cov.markupConventionInUse).toBe(true)
    expect(cov.awaitingMarkup).toEqual([])
  })

  it('wants two checkmarks for section 22, and says so when it has one', () => {
    // One checkmark is the X-ray markup. Section 22 is the heat number
    // and torque markup, which is the second.
    const cov = isometricSectionCoverage('22', [], [A], [drawing(`${A} ✔︎.pdf`)])
    expect(cov.covered).toEqual([A])
    expect(cov.awaitingMarkup).toEqual([A])
  })

  it('stays silent on a book that does not use the convention', () => {
    // Marking a book down for a filename convention it never adopted
    // would be inventing a requirement.
    const cov = isometricSectionCoverage('22', [], [A], [drawing(`${A}.pdf`)])
    expect(cov.markupConventionInUse).toBe(false)
    expect(cov.awaitingMarkup).toEqual([])
  })

  it('never lets markup change the percentage', () => {
    // Reported, never scored — the drawing is on file either way.
    const marked = isometricSectionCoverage('22', [], [A], [drawing(`${A} ✔︎✔︎.pdf`)])
    const bare = isometricSectionCoverage('22', [], [A], [drawing(`${A} ✔︎.pdf`)])
    expect(marked.coveragePct).toBe(bare.coveragePct)
  })

  it('does not carry regex state between calls', () => {
    // `CHECK` is a global regex, and `test` advances its index. Two calls
    // in a row must answer the same way.
    const once = () => isometricSectionCoverage('21', [], [A], [drawing(`${A} ✔︎.pdf`)])
    expect(once().markupConventionInUse).toBe(true)
    expect(once().markupConventionInUse).toBe(true)
  })
})

// ---------------------------------------------------------------------

const DEF: SectionDefinition = {
  id: 'def21', sectionNumber: '21', title: 'Isometric Weld and X-Ray Map',
  requirementType: 'records', linkedRecordType: 'isometric', weight: 10,
  appliesTo: 'facility', isSupplemental: false, sortOrder: 21,
} as SectionDefinition

const SECTION: JobBookSection = {
  id: 's21', jobBookId: 'b', sectionDefinitionId: 'def21', status: 'in_progress',
} as JobBookSection

function bundle(docs: DocumentRecord[], isos = [A, B, C]): JobBookBundle {
  return {
    book: { id: 'b' },
    welds: [],
    torqueConnections: isos.map((iso, i) => ({ id: `c${i}`, isoNumber: iso })),
    documents: docs,
    sectionDefinitions: [DEF],
    sections: [SECTION],
  } as unknown as JobBookBundle
}

describe('what the section actually scores', () => {
  it('scores one covered isometric out of three at a third', () => {
    const s = scoreSection(DEF, SECTION, bundle([drawing(`${A}.pdf`)]))
    expect(s.pct).toBeCloseTo(33.3, 0)
  })

  it('no longer reads 100% on three drawings of the wrong lines', () => {
    // The defect, stated as a test: three approved documents, three
    // isometrics referenced, and not one of them drawn.
    const s = scoreSection(DEF, SECTION, bundle([
      drawing('9-ZZ-9999999A-XXX.pdf'),
      drawing('8-ZZ-8888888A-XXX.pdf'),
      drawing('7-ZZ-7777777A-XXX.pdf'),
    ]))
    expect(s.pct).toBe(0)
  })

  it('says in the explanation that a drawing names no isometric', () => {
    const s = scoreSection(DEF, SECTION, bundle([drawing('scan0042.pdf')]))
    expect(s.explanation).toMatch(/names? no isometric/)
    expect(s.pct).toBe(0)
  })

  it('ignores a drawing nobody has approved', () => {
    const s = scoreSection(DEF, SECTION,
      bundle([drawing(`${A}.pdf`, { approvedAt: null })]))
    expect(s.pct).toBe(0)
  })
})

describe('the findings', () => {
  it('names the isometrics with no drawing, once per section', () => {
    const f = ruleIsometricDrawingMissing(bundle([drawing(`${A}.pdf`)]))
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.sectionNumber).toBe('21')
    expect(f[0]!.detail).toContain(B)
  })

  it('stays quiet once every referenced isometric is drawn', () => {
    const all = [A, B, C].map((i) => drawing(`${i}.pdf`))
    expect(ruleIsometricDrawingMissing(bundle(all))).toEqual([])
  })

  it('stays quiet on a section marked not applicable', () => {
    const b = bundle([])
    b.sections = [{ ...SECTION, status: 'na' }] as JobBookSection[]
    expect(ruleIsometricDrawingMissing(b)).toEqual([])
  })

  it('stays quiet while the section is unread', () => {
    // A rule firing against unread data reports a problem with the
    // import, in language that accuses the job.
    const b = bundle([])
    b.sections = [{ ...SECTION, ingestionStatus: 'not_imported' }] as JobBookSection[]
    expect(ruleIsometricDrawingMissing(b)).toEqual([])
  })

  it('raises an untagged drawing as a warning in our own name', () => {
    const f = ruleDrawingNotAttributable(bundle([drawing('scan0042.pdf')]))
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('warning')
    expect(f[0]!.detail).toContain('scan0042.pdf')
  })

  it('runs as part of the book, not just on its own', () => {
    // A rule nothing calls is a rule that does not run. Against the real
    // facility bundle, whose torque log references 196 isometrics and
    // which holds no drawings for any of them.
    const b = buildGreeleyBundle()
    const def = b.sectionDefinitions.find((d) => d.sectionNumber === '21')!
    const section = b.sections.find((s) => s.sectionDefinitionId === def.id)!
    const withScan: JobBookBundle = {
      ...b,
      sections: b.sections.map((s) =>
        s.id === section.id ? { ...s, status: 'in_progress', ingestionStatus: 'imported' } : s),
      documents: [...b.documents, drawing('scan0042.pdf', { sectionId: section.id })],
    }
    const ids = evaluateFlags(withScan).map((f) => f.ruleId)
    expect(ids).toContain('isometric.drawing_missing')
    expect(ids).toContain('isometric.drawing_not_attributable')
  })

  it('names a real shortfall on the reference facility book', () => {
    // 196 isometrics referenced by the torque log, none drawn.
    const b = buildGreeleyBundle()
    const def = b.sectionDefinitions.find((d) => d.sectionNumber === '21')!
    const section = b.sections.find((s) => s.sectionDefinitionId === def.id)!
    const readable: JobBookBundle = {
      ...b,
      sections: b.sections.map((s) =>
        s.id === section.id ? { ...s, status: 'in_progress', ingestionStatus: 'imported' } : s),
    }
    const f = ruleIsometricDrawingMissing(readable).find((x) => x.sectionNumber === '21')!
    expect(f).toBeTruthy()
    expect(f.title).toMatch(/^19\d isometric/)
  })
})
