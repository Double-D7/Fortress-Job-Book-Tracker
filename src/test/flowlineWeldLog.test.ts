/**
 * The flowline weld log.
 *
 * Fortress builds two kinds of book and only one of them could import its
 * weld log. A Noble flowline workbook — one sheet per line, the line code
 * in the sheet name, a job header block repeated above each sheet's
 * column header, welds numbered per line — went through the facility
 * reader, which flattens every sheet into one table.
 *
 * It did not fail. It reported `ok: true`, read one of two sheets, took
 * the second sheet's header block as data, threw away both line codes,
 * and then merged weld 1 of FL-7 with weld 1 of FL-8 because the record
 * id was derived from the weld number alone. Nine welds became one.
 *
 * That shape — a failure that looks like a success — is what these cases
 * are for.
 */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildWeldLogPreview, getDataProvider, type Viewer } from '@/lib/data/provider'
import { detectWeldLogTemplate } from '@/lib/import/weldLogTemplate'
import { readWeldLogGrid, rowsForWeldPlan } from '@/lib/import/weldLogIngest'
import type { JobBookBundle } from '@/lib/domain/types'

const manager: Viewer = {
  id: 'u-mgr', email: 'm@fortressds.com', fullName: 'M. Ruiz',
  role: 'qaqc_manager', clientOrgId: null,
}

/** The Noble template: job header block, column header, data below. */
function nobleSheet(welds: number, opts: { welder?: string | null; heat?: boolean } = {}) {
  const g: unknown[][] = [
    ['NOBLE ENERGY DETAILED WELD LOG'],
    ['Facility Name:', 'DP452 Flowline'],
    ['Drill Pad Name:', 'CC19-03'],
    ['Welding Company:', 'Flowline Construction Services'],
    ['Pipe Size:', '6"'], ['Pipe Schedule:', 'STD'], ['Pipe Grade:', 'X42'],
  ]
  while (g.length < 22) g.push([null])
  g.push(['Weld Number', 'Date', 'Welder Root/Hot/Fill/Cap', 'Joint Type', 'Description',
    'Heat Number', 'CWI', 'Visual', 'Visual Date', 'NDT Company', 'X-Ray', 'Method',
    'Result', 'Comments'])
  for (let i = 0; i < welds; i++) {
    g.push([`${i + 1}`, '6/14/24',
      opts.welder === undefined ? 'AB/AB/CD/CD' : opts.welder,
      'Butt', '6" PIPE',
      opts.heat === false ? null : `H${1000 + i} / H${2000 + i}`,
      'JW', 'Accept', '6/15/24', 'TEAM', `RT-${i}`, 'RT', 'Accept', null])
  }
  return XLSX.utils.aoa_to_sheet(g)
}

function nobleWorkbook(
  sheets: { name: string; welds: number; welder?: string | null; heat?: boolean }[],
): Uint8Array {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(
      wb, nobleSheet(s.welds, { welder: s.welder, heat: s.heat }), s.name)
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

/** A facility log: one table, area and isometric in columns. */
function facilityWorkbook(): Uint8Array {
  const g: unknown[][] = [
    ['Weld Number', 'Date', 'Welder', 'Area', 'ISO', 'Pipe Size', 'Grade',
      'CWI', 'Visual', 'NDT Method', 'Result'],
    ['1', '6/14/24', 'TW3', '2100', '2-PF-2031101A-DCN', '2"', 'A106-B', 'AE', 'Accept', 'RT', 'Accept'],
    ['2', '6/15/24', 'TW3', '2100', '2-PF-2031101A-DCN', '2"', 'A106-B', 'AE', 'Accept', 'RT', 'Accept'],
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(g), 'Weld Log')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

const TWO_LINES = [{ name: 'FL-7', welds: 5 }, { name: 'FL-8', welds: 4 }]

describe('telling the two templates apart', () => {
  it('reads a per-sheet Noble workbook as a flowline log', () => {
    const v = detectWeldLogTemplate(readWeldLogGrid(nobleWorkbook(TWO_LINES)).sheets)
    expect(v.template).toBe('flowline')
    expect(v.sheetsWithOwnHeader).toBe(2)
    expect(v.reason).toMatch(/flowline/i)
  })

  it('still reads a facility log as a facility log', () => {
    // The regression that matters most: DP-318 must keep importing.
    const v = detectWeldLogTemplate(readWeldLogGrid(facilityWorkbook()).sheets)
    expect(v.template).toBe('facility')
  })

  it('reads a single-sheet Noble workbook as a flowline log', () => {
    // A flowline book with one line is still a flowline book, and its
    // line code is still only in the sheet name.
    const v = detectWeldLogTemplate(readWeldLogGrid(nobleWorkbook([{ name: 'FL-1', welds: 3 }])).sheets)
    expect(v.template).toBe('flowline')
  })

  it('says why, so a misrouted workbook is visible', () => {
    const v = detectWeldLogTemplate(readWeldLogGrid(facilityWorkbook()).sheets)
    expect(v.reason).toMatch(/area, isometric or tier/)
  })

  it('answers facility for a workbook with nothing to go on', () => {
    // The status quo is the safe default: it is the path that existed.
    expect(detectWeldLogTemplate([]).template).toBe('facility')
  })
})

describe('reading every sheet', () => {
  it('keeps the sheets apart instead of flattening them', () => {
    const read = readWeldLogGrid(nobleWorkbook(TWO_LINES))
    expect(read.sheets.map((s) => s.name)).toEqual(['FL-7', 'FL-8'])
    // The flat grid is still produced — the facility path is unchanged.
    expect(read.grid.length).toBeGreaterThan(read.sheets[0]!.grid.length)
  })
})

describe('planning a flowline log against a book', () => {
  async function plan(bytes: Uint8Array) {
    const b = (await getDataProvider().getBundle(manager, 'book-dp452'))!
    return buildWeldLogPreview(b, bytes, 'DP452 Weld Log.xlsx')
  }

  it('reads every weld on every sheet', async () => {
    // Nine welds across two lines. The facility reader made this one.
    const p = await plan(nobleWorkbook(TWO_LINES))
    expect(p.ok).toBe(true)
    expect(p.plan!.template).toBe('flowline')
    expect(p.plan!.parsedRows).toBe(9)
    expect(p.plan!.weldsToCreate).toBe(9)
  })

  it('takes the line code from the sheet name, which is its only home', async () => {
    const p = await plan(nobleWorkbook(TWO_LINES))
    expect(p.plan!.areas.map((a) => a.code)).toEqual(['FL-7', 'FL-8'])
    expect(p.plan!.areas.map((a) => a.weldCount)).toEqual([5, 4])
    expect(p.plan!.sheetsParsed).toEqual(['FL-7', 'FL-8'])
  })

  it('does not merge weld 1 of one line with weld 1 of another', async () => {
    // Both sheets number their welds from 1. They are different welds,
    // and the database has always said so: unique (weld_line_id,
    // weld_number).
    const p = await plan(nobleWorkbook([{ name: 'FL-7', welds: 3 }, { name: 'FL-8', welds: 3 }]))
    expect(p.plan!.weldsToCreate).toBe(6)
  })

  it('resolves each of the four passes, not one stamp', async () => {
    const p = await plan(nobleWorkbook(TWO_LINES))
    expect(p.plan!.stamps.map((s) => s.stamp).sort()).toEqual(['AB', 'CD'])
    // A welder who ran root and cap on the same joint welded it once.
    expect(p.plan!.stamps[0]!.welds).toBe(9)
  })

  it('collects the heat numbers, which are the link to section 15', async () => {
    // Deduplicated across lines, which is the point: one length of pipe
    // gets welded into more than one line, and §15 owes one mill
    // certificate per heat, not one per weld. Five welds on FL-7 and four
    // on FL-8 name eighteen heats between them and ten distinct ones.
    const p = await plan(nobleWorkbook(TWO_LINES))
    expect(p.plan!.proposedHeats).toHaveLength(10)
    expect(p.plan!.proposedHeats).toContain('H1000')
  })

  it('raises a weld with no welder as critical', async () => {
    const p = await plan(nobleWorkbook([{ name: 'FL-7', welds: 2, welder: null }]))
    const f = p.plan!.findings.find((x) => x.ruleId === 'weldlog.weld_without_stamp')!
    expect(f.severity).toBe('critical')
    expect(f.detail).toContain('FL-7')
  })

  it('raises a weld with no heat number, naming its line', async () => {
    const p = await plan(nobleWorkbook([{ name: 'FL-7', welds: 2, heat: false }]))
    const f = p.plan!.findings.find((x) => x.ruleId === 'weldlog.weld_without_heat')!
    expect(f.severity).toBe('warning')
    expect(f.detail).toContain('FL-7 1')
  })

  it('raises welders who are not in the register', async () => {
    const p = await plan(nobleWorkbook(TWO_LINES))
    const f = p.plan!.findings.find((x) => x.ruleId === 'weldlog.stamp_not_in_register')
    // AB and CD are invented stamps; the reference book does not hold them.
    expect(f?.severity).toBe('critical')
  })
})

describe('the rows a flowline commit writes', () => {
  async function rows(bytes: Uint8Array) {
    const b = (await getDataProvider().getBundle(manager, 'book-dp452'))!
    const p = buildWeldLogPreview(b, bytes, 'log.xlsx')
    let n = 0
    return {
      bundle: b,
      ...rowsForWeldPlan(p.plan!, b, {
        enteredAt: '2026-01-01T00:00:00Z',
        entrySource: 'field_entry',
        newId: () => `line-${++n}`,
      }),
    }
  }

  it('creates one weld line per sheet, grouped as lines', async () => {
    const r = await rows(nobleWorkbook(TWO_LINES))
    expect(r.weldLines.map((l) => l.lineCode)).toEqual(['FL-7', 'FL-8'])
    expect(r.weldLines.every((l) => l.groupingKind === 'line')).toBe(true)
  })

  it('carries the job header block off each sheet onto its line', async () => {
    // The Noble template repeats it on every sheet and it is real data:
    // pipe size and grade decide the inspection tier.
    const r = await rows(nobleWorkbook(TWO_LINES))
    expect(r.weldLines[0]!.pipeGrade).toBe('X42')
    expect(r.weldLines[0]!.weldingCompany).toBe('Flowline Construction Services')
  })

  it('gives every weld a distinct id, scoped to its line', async () => {
    const r = await rows(nobleWorkbook(TWO_LINES))
    expect(r.welds).toHaveLength(9)
    expect(new Set(r.welds.map((w) => w.id)).size).toBe(9)
  })

  it('attributes the four passes to four welder slots', async () => {
    const r = await rows(nobleWorkbook([{ name: 'FL-7', welds: 1 }]))
    expect(r.welds[0]!.welderPassAssignment).toBe('AB/AB/CD/CD')
  })

  it('records the heat numbers on the weld', async () => {
    const r = await rows(nobleWorkbook([{ name: 'FL-7', welds: 1 }]))
    expect(r.welds[0]!.heatNumbers).toEqual(['H1000', 'H2000'])
  })

  it('stamps every weld with its entry time, per section 8', async () => {
    const r = await rows(nobleWorkbook([{ name: 'FL-7', welds: 2 }]))
    expect(r.welds.every((w) => w.enteredAt === '2026-01-01T00:00:00Z')).toBe(true)
  })

  it('is stable across a re-import, so a corrected log updates', async () => {
    const a = await rows(nobleWorkbook(TWO_LINES))
    const b = await rows(nobleWorkbook(TWO_LINES))
    expect(a.welds.map((w) => w.id)).toEqual(b.welds.map((w) => w.id))
  })
})

describe('the facility path is untouched', () => {
  it('still reads a facility log the way it always did', async () => {
    const b = (await getDataProvider().getBundle(manager, 'book-dp318'))!
    const p = buildWeldLogPreview(b as JobBookBundle, facilityWorkbook(), 'DP-318 Weld Log.xlsx')
    expect(p.ok).toBe(true)
    expect(p.plan!.template).toBe('facility')
    expect(p.plan!.parsedRows).toBe(2)
    expect(p.plan!.areas.map((a) => a.code)).toEqual(['2100'])
  })
})

describe('committing a flowline log through the provider', () => {
  it('writes the lines and every weld, and keeps them apart', async () => {
    const p = getDataProvider()
    const before = (await p.getBundle(manager, 'book-dp452'))!
    const beforeWelds = before.welds.length

    const res = await p.commitWeldLogImport(
      manager, 'book-dp452', nobleWorkbook(TWO_LINES), 'DP452 Weld Log.xlsx')
    expect(res.ok).toBe(true)
    expect(res.weldsCreated).toBe(9)
    expect(res.weldLinesCreated).toBe(2)

    const after = (await p.getBundle(manager, 'book-dp452'))!
    expect(after.welds.length).toBe(beforeWelds + 9)

    const lines = after.weldLines.filter((l) => l.lineCode === 'FL-7' || l.lineCode === 'FL-8')
    expect(lines).toHaveLength(2)

    // Weld 1 exists on both lines and they are two rows, not one.
    const ones = after.welds.filter((w) =>
      w.weldNumber === '1' && lines.some((l) => l.id === w.weldLineId))
    expect(ones).toHaveLength(2)
    expect(new Set(ones.map((w) => w.weldLineId)).size).toBe(2)
  })

  it('updates rather than duplicating on a re-import', async () => {
    const p = getDataProvider()
    const first = await p.commitWeldLogImport(
      manager, 'book-dp452', nobleWorkbook(TWO_LINES), 'log.xlsx')
    expect(first.ok).toBe(true)
    const count = (await p.getBundle(manager, 'book-dp452'))!.welds.length

    const again = await p.commitWeldLogImport(
      manager, 'book-dp452', nobleWorkbook(TWO_LINES), 'log.xlsx')
    expect(again.ok).toBe(true)
    expect((await p.getBundle(manager, 'book-dp452'))!.welds.length).toBe(count)
  })

  it('refuses a reader', async () => {
    const reader: Viewer = {
      id: 'u-ro', email: 'r@fortressds.com', fullName: 'R. Ng',
      role: 'fortress_read_only', clientOrgId: null,
    }
    const res = await getDataProvider()
      .commitWeldLogImport(reader, 'book-dp452', nobleWorkbook(TWO_LINES), 'log.xlsx')
    expect(res.ok).toBe(false)
  })
})
