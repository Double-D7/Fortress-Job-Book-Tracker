/**
 * A page of an inspection report that could not be read.
 *
 * This is the rule that makes "a job book with missing data is
 * incomplete" true rather than stated. The missing data here is of a
 * particular kind — it demonstrably exists, on a page of a PDF somebody
 * uploaded, and the application could not read it. That is worse than a
 * document nobody has filed, because the folder looks full.
 */
import { describe, expect, it } from 'vitest'
import { evaluateFlags, ruleNdeImportGap } from '@/lib/domain/flags'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { JobBookBundle, NdeImportGap, NdeReport } from '@/lib/domain/types'

function bundleWithGaps(gaps: NdeImportGap[] | null): JobBookBundle {
  const b = buildDp452Bundle()
  const report: NdeReport = {
    ...b.ndeReports[0]!,
    id: 'nde-gap-test',
    reportNumber: '022326BL-RT',
    isSuperseded: false,
    importGaps: gaps,
    sourceFilename: '6 - 02.23.26 Chevron DP-318.pdf',
  }
  return { ...b, ndeReports: [report] }
}

/** The real shape: one page of a DP-318 report yields nothing usable. */
const UNREADABLE_PAGE: NdeImportGap = {
  kind: 'page_not_understood',
  severity: 'critical',
  detail: 'Page 1 produced text but no report details or exposure rows could be read from it.',
  page: 1,
}

describe('a critical gap becomes a finding', () => {
  const findings = ruleNdeImportGap(bundleWithGaps([UNREADABLE_PAGE]))

  it('raises one, against section 10', () => {
    expect(findings).toHaveLength(1)
    expect(findings[0]!.sectionNumber).toBe('10')
    expect(findings[0]!.severity).toBe('critical')
  })

  it('names the page, so somebody can open it', () => {
    expect(findings[0]!.title).toMatch(/page 1/i)
  })

  it('names the file it came from, because one file holds several reports', () => {
    expect(findings[0]!.detail).toMatch(/02\.23\.26/)
  })

  it('says what it costs the book rather than only what failed', () => {
    expect(findings[0]!.detail).toMatch(/not evidenced in this book/i)
  })
})

describe('what it leaves alone', () => {
  it('ignores a warning-level gap', () => {
    // A missing technician name is expected and its absence is not
    // evidence that the examination was wrong.
    const warn: NdeImportGap = {
      kind: 'missing_field', severity: 'warning', detail: 'No technician name could be read.',
    }
    expect(ruleNdeImportGap(bundleWithGaps([warn]))).toEqual([])
  })

  it('raises nothing for a report that read cleanly', () => {
    expect(ruleNdeImportGap(bundleWithGaps(null))).toEqual([])
    expect(ruleNdeImportGap(bundleWithGaps([]))).toEqual([])
  })

  it('ignores a superseded report', () => {
    // Its successor carries the current reading; the old one's gaps are
    // not work anybody still owes.
    const b = bundleWithGaps([UNREADABLE_PAGE])
    const superseded = {
      ...b, ndeReports: [{ ...b.ndeReports[0]!, isSuperseded: true }],
    }
    expect(ruleNdeImportGap(superseded)).toEqual([])
  })
})

describe('several gaps on one report', () => {
  it('raises one finding each, distinctly fingerprinted', () => {
    // Clearing the unreadable page must not clear the missing rows, and
    // re-running evaluation must not duplicate either.
    const findings = ruleNdeImportGap(bundleWithGaps([
      UNREADABLE_PAGE,
      { kind: 'page_empty', severity: 'critical', detail: 'Page 2 produced no text.', page: 2 },
      { kind: 'row_not_read', severity: 'critical', detail: '2 rows named no weld.' },
    ]))
    expect(findings).toHaveLength(3)
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(3)
  })
})

describe('the book as a whole', () => {
  it('carries the finding through evaluateFlags', () => {
    // A rule nothing calls is a rule that does not run. This is the
    // check that the wiring exists, not just the function.
    const findings = evaluateFlags(bundleWithGaps([UNREADABLE_PAGE]))
    expect(findings.some((f) => f.ruleId === 'nde.import_gap')).toBe(true)
  })

  it('is a critical finding, which Gate 4 counts', () => {
    // Gate 4 requires zero open Critical findings, so an unread page
    // holds the turnover until somebody addresses it. That is the whole
    // point: the book cannot be handed over while part of its evidence
    // is sitting unread in a file.
    const findings = evaluateFlags(bundleWithGaps([UNREADABLE_PAGE]))
    const gap = findings.find((f) => f.ruleId === 'nde.import_gap')
    expect(gap?.severity).toBe('critical')
  })
})
