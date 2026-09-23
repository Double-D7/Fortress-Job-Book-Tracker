/**
 * Filing a stack of certificates at once.
 *
 * The cases that matter are the ones where bulk could quietly do damage:
 * a collision resolved by guessing, a blank heat filed anyway, or a whole
 * batch refused because one filename was unreadable.
 */
import { describe, expect, it } from 'vitest'
import {
  ISSUE_LABELS, batchCounts, classifyBatch, fileButtonLabel, filableIndexes, heldBackSummary,
  type BatchRow,
} from '@/lib/domain/mtrBatch'
import { heatFromFilename } from '@/lib/domain/heats'

/** Build the batch the way the screen does: suggestion from the filename. */
function fromFilenames(names: string[]): BatchRow[] {
  return names.map((filename) => ({
    filename, heat: heatFromFilename(filename) ?? '',
  }))
}

/** The real certificates, as a batch. */
const REAL = [
  '.75-XXH-_D07821.pdf',
  '1-SCH-80-_A80683.pdf',
  '4_CL600_FLG_MF3.pdf',
  '4_CL900_FLG_3DM31.pdf',
  '4_ELBOW_45_STD_T43672.pdf',
]

describe('a clean batch', () => {
  it('reads every real certificate and blocks none of them', () => {
    const rows = fromFilenames(REAL)
    expect(classifyBatch(rows)).toEqual([null, null, null, null, null])
    expect(batchCounts(rows)).toEqual({
      total: 5, ready: 5, missingHeat: 0, duplicate: 0,
    })
  })

  it('files every row', () => {
    expect(filableIndexes(fromFilenames(REAL))).toEqual([0, 1, 2, 3, 4])
  })
})

describe('a file whose name does not say', () => {
  it('blocks that row and only that row', () => {
    // The case that must not refuse the batch: one bad name among good
    // ones would otherwise cost the other seventy-nine.
    const rows = fromFilenames(['scan0001.pdf', ...REAL])
    const issues = classifyBatch(rows)
    expect(issues[0]).toBe('missing_heat')
    expect(issues.slice(1)).toEqual([null, null, null, null, null])
    expect(filableIndexes(rows)).toEqual([1, 2, 3, 4, 5])
  })

  it('clears once somebody types the heat', () => {
    const rows: BatchRow[] = [{ filename: 'scan0001.pdf', heat: 'D23363' }]
    expect(classifyBatch(rows)).toEqual([null])
  })

  it('treats punctuation that reduces to nothing as missing', () => {
    // "---" looks filled in and is not. Sending it would file a
    // certificate against a heat nobody can ever match.
    for (const heat of ['', '   ', '---', '//']) {
      expect(classifyBatch([{ filename: 'x.pdf', heat }]), heat)
        .toEqual(['missing_heat'])
    }
  })
})

describe('two files claiming one heat', () => {
  it('blocks both, not all but the first', () => {
    // Filing the first and rejecting the second would pick a scan at
    // random and call it the certificate for that heat.
    const rows: BatchRow[] = [
      { filename: 'a.pdf', heat: 'D07821' },
      { filename: 'b.pdf', heat: 'D07821' },
      { filename: 'c.pdf', heat: 'A80683' },
    ]
    expect(classifyBatch(rows))
      .toEqual(['duplicate_in_batch', 'duplicate_in_batch', null])
    expect(filableIndexes(rows)).toEqual([2])
  })

  it('catches a collision hidden by punctuation', () => {
    // "D-07821" and "D07821" are one heat. Missing this would file two
    // certificates for the same steel and leave the library ambiguous.
    const rows: BatchRow[] = [
      { filename: 'a.pdf', heat: 'D-07821' },
      { filename: 'b.pdf', heat: 'd07821' },
    ]
    expect(classifyBatch(rows))
      .toEqual(['duplicate_in_batch', 'duplicate_in_batch'])
  })

  it('does not treat two blank rows as duplicates of each other', () => {
    // They are both missing a heat, which is the useful thing to say.
    // "These two clash" would send somebody looking for a clash.
    const rows: BatchRow[] = [
      { filename: 'a.pdf', heat: '' },
      { filename: 'b.pdf', heat: '' },
    ]
    expect(classifyBatch(rows)).toEqual(['missing_heat', 'missing_heat'])
  })

  it('clears once one of them is corrected', () => {
    const rows: BatchRow[] = [
      { filename: 'a.pdf', heat: 'D07821' },
      { filename: 'b.pdf', heat: 'A80683' },
    ]
    expect(classifyBatch(rows)).toEqual([null, null])
  })
})

describe('what the screen tells the person', () => {
  it('names the shortfall rather than hiding it', () => {
    // "File 4 certificates" under five chosen files reads as though the
    // fifth went through quietly.
    const rows = fromFilenames(['scan0001.pdf', ...REAL])
    expect(fileButtonLabel(batchCounts(rows))).toBe('File 5 of 6 certificates')
  })

  it('does not say "of" when nothing is held back', () => {
    expect(fileButtonLabel(batchCounts(fromFilenames(REAL))))
      .toBe('File 5 certificates')
  })

  it('agrees the noun with the total in the "of" form', () => {
    // "File 1 of 4 certificate" — the noun belongs to the four.
    const rows: BatchRow[] = [
      { filename: 'a.pdf', heat: 'D07821' },
      { filename: 'b.pdf', heat: '' },
      { filename: 'c.pdf', heat: 'X1' },
      { filename: 'd.pdf', heat: 'X1' },
    ]
    expect(fileButtonLabel(batchCounts(rows))).toBe('File 1 of 4 certificates')
  })

  it('gets the singular right', () => {
    expect(fileButtonLabel(batchCounts(fromFilenames(['4_CL600_FLG_MF3.pdf']))))
      .toBe('File 1 certificate')
  })

  it('says so when there is nothing to send', () => {
    expect(fileButtonLabel(batchCounts(fromFilenames(['scan0001.pdf']))))
      .toBe('Nothing ready to file')
    expect(fileButtonLabel(batchCounts([]))).toBe('Nothing ready to file')
  })

  it('agrees with itself about number', () => {
    // "1 need a heat number" survives review and then reads as sloppiness
    // on a record somebody is auditing.
    const one = batchCounts([{ filename: 'a.pdf', heat: '' }])
    expect(heldBackSummary(one)).toMatch(/^1 needs a heat number/)

    const two = batchCounts([
      { filename: 'a.pdf', heat: '' }, { filename: 'b.pdf', heat: '' },
    ])
    expect(heldBackSummary(two)).toMatch(/^2 need a heat number/)
  })

  it('says nothing when nothing is held back', () => {
    expect(heldBackSummary(batchCounts(fromFilenames(REAL)))).toBeNull()
    expect(heldBackSummary(batchCounts([]))).toBeNull()
  })

  it('names both kinds of problem when both are present', () => {
    const rows: BatchRow[] = [
      { filename: 'a.pdf', heat: '' },
      { filename: 'b.pdf', heat: 'X1' },
      { filename: 'c.pdf', heat: 'X1' },
    ]
    const summary = heldBackSummary(batchCounts(rows))
    expect(summary).toMatch(/1 needs a heat number/)
    expect(summary).toMatch(/2 clash within this batch/)
  })

  it('has a sentence for every issue it can report', () => {
    // A row blocked with no explanation is a dead end.
    const rows: BatchRow[] = [
      { filename: 'a.pdf', heat: '' },
      { filename: 'b.pdf', heat: 'X1' },
      { filename: 'c.pdf', heat: 'X1' },
    ]
    for (const issue of classifyBatch(rows)) {
      if (issue === null) continue
      expect(ISSUE_LABELS[issue], issue).toBeTruthy()
    }
  })
})
