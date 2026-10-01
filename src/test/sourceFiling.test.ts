/**
 * The original has to survive the import.
 *
 * Every importer in this application used to read its file, write rows,
 * and drop the file. Nothing looked wrong, because the screens read the
 * rows — the absence only shows up when somebody asks to see the document
 * the numbers came from, which on a submitted job book is the question
 * that gets asked.
 *
 * These cases cover the decisions: where each original is filed, when the
 * book already has it, and what the stored object says it is.
 */
import { describe, expect, it } from 'vitest'
import {
  SOURCE_SECTION, alreadyFiled, missingSectionMessage, sourceMimeType,
  sourceSection, sourceStoragePath, type SourceKind,
} from '@/lib/domain/sourceFiling'

describe('where an original is filed', () => {
  it('puts an NDE report in section 10, with the job logs and films', () => {
    expect(sourceSection('nde_report')).toBe('10')
  })

  it('separates the overview sheet from the detailed weld log', () => {
    // 11 is the overview with inspection percentages, 12 the detailed
    // log. They are different sections of the standard and two different
    // documents, however alike they look on a screen.
    expect(sourceSection('weld_log_overview')).toBe('11')
    expect(sourceSection('weld_log')).toBe('12')
  })

  it('separates the torque certificates from the torque log', () => {
    expect(sourceSection('calibration_certificate')).toBe('13')
    expect(sourceSection('torque_log')).toBe('14')
  })

  it('files a pressure recorder certificate with the pressure results', () => {
    // Not with the torque wrench certificates, though it is the same kind
    // of calibration page: §17 is where somebody auditing a pressure test
    // looks for the recorder's certificate.
    expect(sourceSection('pressure_recorder_certificate')).toBe('17')
    expect(sourceSection('pressure_test')).toBe('17')
  })

  it('has a section for every kind of original it reads', () => {
    // A kind added without a section would file nothing and say nothing.
    const kinds: SourceKind[] = [
      'nde_report', 'weld_log_overview', 'weld_log', 'calibration_certificate',
      'pressure_recorder_certificate', 'torque_log', 'pressure_test',
    ]
    for (const kind of kinds) {
      expect(SOURCE_SECTION[kind], kind).toMatch(/^\d{1,2}$/)
    }
  })
})

describe('the same file imported twice', () => {
  const docs = [
    { id: 'doc-1', sha256: 'aaa111' },
    { id: 'doc-2', sha256: 'bbb222' },
  ]

  it('is recognised, so the book does not keep two copies', () => {
    expect(alreadyFiled(docs, 'bbb222')?.id).toBe('doc-2')
  })

  it('does not match a file the book has never held', () => {
    expect(alreadyFiled(docs, 'ccc333')).toBeNull()
  })

  it('never matches on an empty hash', () => {
    // An unhashed file matching the first unhashed document would file
    // one original and silently claim to have filed the next.
    expect(alreadyFiled([{ id: 'doc-3', sha256: '' }], '')).toBeNull()
  })

  it('lands on the same storage path for the same bytes', () => {
    // Content-addressed, so a retry after a half-finished request
    // overwrites rather than leaving an orphan behind.
    const a = sourceStoragePath('book-1', '10', 'aaa111')
    const b = sourceStoragePath('book-1', '10', 'aaa111')
    expect(a).toBe(b)
    expect(a).toBe('book-1/10/aaa111')
  })

  it('keeps different books apart even for identical bytes', () => {
    expect(sourceStoragePath('book-1', '10', 'aaa111'))
      .not.toBe(sourceStoragePath('book-2', '10', 'aaa111'))
  })
})

describe('what the stored object says it is', () => {
  it('marks a PDF as a PDF, so it opens rather than downloading as a blob', () => {
    expect(sourceMimeType('RT-031.pdf')).toBe('application/pdf')
    expect(sourceMimeType('RT-031.PDF')).toBe('application/pdf')
  })

  it('knows the spreadsheet the weld logs arrive as', () => {
    expect(sourceMimeType('weld log.xlsx'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('says octet-stream rather than guessing', () => {
    // A wrong specific type is worse than an unspecific one: it makes a
    // viewer try to render something it cannot.
    expect(sourceMimeType('scan.unknown')).toBe('application/octet-stream')
    expect(sourceMimeType('noextension')).toBe('application/octet-stream')
  })
})

describe('a book missing the section its originals belong in', () => {
  it('says which section, because that is the fix', () => {
    const said = missingSectionMessage('nde_report', '10')
    expect(said).toContain('section 10')
    expect(said).toContain('nde report')
  })

  it('says nothing was written, so nobody goes looking for half an import', () => {
    expect(missingSectionMessage('weld_log', '12')).toContain('nothing was written')
  })
})
