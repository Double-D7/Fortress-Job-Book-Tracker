/**
 * Reading a pressure test hold sheet (§17), against the real Greeley data.
 *
 * §17 is the section the baseline review found in the worst state — 13 of
 * 21 facility packages holding instrument certificates and no result
 * document — and the application could not tell, because a pressure test
 * existed only as a folder of PDFs. The §11.1 check needs a row with a
 * date on it before it can run at all.
 *
 * The two tests that matter most here are about restraint: the reader
 * does not decide pass or fail, and it does not import the template's
 * pre-numbered blank rows as tests that happened.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parsePressureTestRows, pressureTestRecordId, toPressureTestRecords,
} from '@/lib/import/pressureTestLog'

/**
 * The fixture is the hold table as exported: two provenance comments,
 * then the column header (itself written as a comment), then one row per
 * test. The `# ` is stripped rather than the header line dropped — that
 * line is the thing the parser has to find.
 */
function fixtureGrid(): (string | null)[][] {
  const text = readFileSync('fixtures/greeley/pressure-tests.tsv', 'utf8')
  const lines = text.split('\n').filter((l) => l.trim())
  const headerAt = lines.findIndex((l) => l.replace(/^#\s*/, '').startsWith('test\t'))
  return lines
    .slice(headerAt)
    .map((l) => l.replace(/^#\s*/, ''))
    .map((l) => l.split('\t').map((c) => (c.trim() === '' ? null : c.trim())))
}

/** The same table with the template's pre-numbered blanks put back. */
function withTemplateBlanks(): (string | null)[][] {
  const grid = fixtureGrid()
  for (let i = 14; i <= 20; i++) grid.push([String(i), null, '0', '0', '0', '0'])
  return grid
}

describe('reading the hold table', () => {
  const r = parsePressureTestRows(fixtureGrid())

  it('reads every recorded test', () => {
    expect(r.rows).toHaveLength(14)
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('keeps a test identifier that is not a number', () => {
    // The sheet's last row is "IA" — the instrument air test. A reader
    // that assumed the identifier column held integers would drop it, and
    // a book would quietly lose a test it actually performed.
    const ia = r.rows.find((x) => x.testIdentifier === 'IA')!
    expect(ia.testDate).toBe('2025-10-29')
    expect(ia.startPressurePsi).toBe(100)
  })

  it('reads the hold data the section is scored on', () => {
    const first = r.rows[0]!
    expect(first.testIdentifier).toBe('1')
    expect(first.testDate).toBe('2025-09-19')
    expect(first.durationMinutes).toBe(11)
    expect(first.startPressurePsi).toBe(1129)
    expect(first.endPressurePsi).toBe(1156)
    expect(first.ambientTempF).toBe(80)
  })

  it('keeps a fractional hold rather than rounding it away at the parser', () => {
    // 10.417 minutes is what the chart says. Rounding on read would make
    // the sheet and the book disagree about a number an auditor can see.
    const seven = r.rows.find((x) => x.testIdentifier === '7')!
    expect(seven.durationMinutes).toBeCloseTo(10.417, 3)
  })

  it('finds columns by what they say, not by where they are', () => {
    // The same table with the columns shuffled and renamed the way
    // another crew writes them.
    const reordered: (string | null)[][] = [
      ['Starting Pressure', 'Test No', 'Ambient Temp', 'Date Tested', 'Hold Time', 'Final Pressure'],
      ['1129', '1', '80', '2025-09-19', '11', '1156'],
    ]
    const p = parsePressureTestRows(reordered)
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0]).toMatchObject({
      testIdentifier: '1', testDate: '2025-09-19', durationMinutes: 11,
      startPressurePsi: 1129, endPressurePsi: 1156, ambientTempF: 80,
    })
  })

  it('says so rather than guessing when the table is not there', () => {
    const p = parsePressureTestRows([['Weld', 'Welder', 'Date'], ['1', 'KT', '2025-01-01']])
    expect(p.rows).toEqual([])
    expect(p.issues[0]?.severity).toBe('error')
    expect(p.issues[0]?.message).toMatch(/No pressure test table found/)
  })
})

describe('what the reader refuses to invent', () => {
  it('does not import the template\'s pre-numbered blank rows as tests', () => {
    // Greeley's sheet ships rows 14-20 numbered, with all-zero values and
    // no recorded hold. Importing them would be inventing seven passing
    // tests out of a template.
    const p = parsePressureTestRows(withTemplateBlanks())
    expect(p.rows).toHaveLength(14)
    expect(p.emptyRows).toHaveLength(7)
    expect(p.emptyRows.map((x) => x.testIdentifier))
      .toEqual(['14', '15', '16', '17', '18', '19', '20'])
    // Counted and named, so the gap is visible rather than silent.
    for (const e of p.emptyRows) expect(e.empty).toBe(true)
  })

  it('does not decide pass or fail from the two pressures', () => {
    // Test 11 ends 8 psi below where it started, and test 13 ends 5 below.
    // Neither is automatically a failure — ambient temperature moves a
    // reading — and §17's acceptance criteria belong to the test
    // procedure. The result document settles it, and this reader has not
    // seen one.
    const rows = parsePressureTestRows(fixtureGrid()).rows
    const dropped = rows.filter(
      (x) => x.startPressurePsi != null && x.endPressurePsi != null &&
             x.endPressurePsi < x.startPressurePsi)
    expect(dropped.length).toBeGreaterThan(0)

    const records = toPressureTestRecords(rows, { jobBookId: 'book-x' })
    for (const rec of records) expect(rec.result).toBeNull()
  })

  it('asserts no instrument certificate it has not seen', () => {
    // §11.1 wants gauge, recorder and PSV valid on the test date. A hold
    // sheet carries none of them, so the import leaves all three null and
    // lets the flags engine report the gap — rather than filling them in
    // from whatever certificate happens to be on the book.
    const records = toPressureTestRecords(
      parsePressureTestRows(fixtureGrid()).rows, { jobBookId: 'book-x' })
    for (const rec of records) {
      expect(rec.gaugeCertId ?? null).toBeNull()
      expect(rec.recorderCertId ?? null).toBeNull()
      expect(rec.psvCertId ?? null).toBeNull()
      expect(rec.resultDocumentId ?? null).toBeNull()
    }
  })

  it('warns rather than dropping a row whose date will not parse', () => {
    const grid: (string | null)[][] = [
      ['Test', 'Date', 'Hold', 'Start PSI', 'End PSI'],
      ['1', 'see chart', '11', '1129', '1156'],
    ]
    const p = parsePressureTestRows(grid)
    // Imported, because the hold data is real and useful.
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0]!.testDate).toBeNull()
    // And flagged, because §11.1 cannot run without the date.
    const warn = p.issues.find((i) => i.column === 'Date')!
    expect(warn.severity).toBe('warning')
    expect(warn.message).toMatch(/§11\.1/)
  })
})

describe('the records an import would write', () => {
  const rows = parsePressureTestRows(fixtureGrid()).rows
  const records = toPressureTestRecords(rows, { jobBookId: 'book-x' })

  it('writes one record per recorded test, with stable ids', () => {
    expect(records).toHaveLength(rows.length)
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length)
    expect(records[0]!.id).toBe(pressureTestRecordId('book-x', '1'))

    // Re-reading the same sheet produces the same ids, which is what
    // makes a corrected re-import an update rather than a second copy.
    const again = toPressureTestRecords(
      parsePressureTestRows(fixtureGrid()).rows, { jobBookId: 'book-x' })
    expect(again.map((r) => r.id)).toEqual(records.map((r) => r.id))
  })

  it('carries the hold data §17 asks for', () => {
    const first = records[0]!
    expect(first.startPressurePsi).toBe(1129)
    expect(first.endPressurePsi).toBe(1156)
    expect(first.ambientTempF).toBe(80)
    expect(first.durationMinutes).toBe(11)
    // The pressure the test was held at is the one it started at.
    expect(first.testPressurePsi).toBe(first.startPressurePsi)
  })

  it('rounds the stored duration but keeps the reading it came from', () => {
    // The column is an integer of minutes; the sheet's 10.417 rounds to
    // 10 for storage, and the parsed row keeps the original so the two
    // can be compared.
    const seven = records.find((r) => r.testIdentifier === '7')!
    expect(seven.durationMinutes).toBe(10)
    expect(rows.find((r) => r.testIdentifier === '7')!.durationMinutes)
      .toBeCloseTo(10.417, 3)
  })
})
