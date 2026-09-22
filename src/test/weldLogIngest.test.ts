/**
 * Ingesting the Detailed Weld Log — Appendix A §12.
 *
 * The log is built here rather than shipped as a fixture, because the
 * cases worth testing are the ones a real log has a few of among twelve
 * hundred rows: the weld with no stamp, the stamp that resolves to nobody,
 * the weld dated after its welder's qualification lapsed. Constructing it
 * is the only way to have exactly those and know it.
 *
 * The shape is DP-318's: the same stamps, the same two Keith Taylor dates
 * either side of his 2025-12-30 expiry, and three unstamped welds —
 * because the overview sheet's two rollups differ by exactly three, and
 * the import JSON records `welds_without_welder_stamp: 3`.
 */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  parseFacilityWeldRows, planWeldLogIngest, readWeldLogGrid, rowsForWeldPlan,
} from '@/lib/import/weldLogIngest'
import type { JobBookBundle, Welder, WelderQualification } from '@/lib/domain/types'
import type { OverviewFinding } from '@/lib/import/weldLogOverview'

const HEADER = [
  'Weld Number', 'Date', 'Welder', 'Joint Type', 'Construction Area',
  'Isometric', 'Pipe Size', 'Pipe Grade', 'CWI', 'Visual Result',
  'Visual Date', 'NDT Method', 'NDT Result',
]

type Row = (string | null)[]

interface RowSpec {
  weld: string; date: string; welder: string | null; joint: string; area: string
  iso: string; size: string; grade: string; cwi: string; visual: string
  visualDate: string | null; ndt: string | null; ndtResult: string | null
}

/**
 * `??` will not do here, and the reason is the bug this helper first had:
 * `o.welder ?? 'KT'` turns an explicit null back into 'KT', so every test
 * for an unstamped weld silently tested a stamped one. An absent key and a
 * key set to null are different intentions and the helper has to keep them
 * apart — which is the same distinction the code under test exists to make.
 */
function row(o: Partial<RowSpec>): Row {
  const pick = <K extends keyof RowSpec>(k: K, fallback: RowSpec[K]): RowSpec[K] =>
    k in o ? (o[k] as RowSpec[K]) : fallback
  return [
    pick('weld', 'W-1'), pick('date', '2025-06-02'), pick('welder', 'KT'),
    pick('joint', 'Butt'), pick('area', 'Area 7200'), pick('iso', 'ISO-100'),
    pick('size', '4" SCH 40'), pick('grade', 'Gr. B'), pick('cwi', 'AE'),
    pick('visual', 'Pass'), pick('visualDate', null),
    pick('ndt', null), pick('ndtResult', null),
  ]
}

function workbook(rows: Row[]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([HEADER, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Weld Log')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

const welder = (id: string, initials: string, name: string): Welder =>
  ({ id, initials, fullName: name, active: true, nameAliases: [] })

/** As the overview import leaves it: an expiry, and no start date. */
const fromOverview = (id: string, welderId: string, expiry: string): WelderQualification =>
  ({ id, welderId, code: 'ASME_IX', qualificationDate: null, expiryDate: expiry })

const bundle = (over: Partial<JobBookBundle> = {}) => ({
  book: {
    id: 'book-1', constructionStart: '2025-01-06', constructionEnd: '2026-06-30',
    dataAsOfDate: '2026-06-30', defaultDesignPressurePsi: 285,
  },
  welds: [], weldLines: [], cwis: [], materialHeats: [],
  welders: [
    welder('w-kt', 'KT', 'Keith Taylor'),
    welder('w-mr', 'MR', 'Miguel Rodriguez'),
  ],
  welderQualifications: [fromOverview('q-kt', 'w-kt', '2025-12-30')],
  ...over,
} as unknown as JobBookBundle)

const read = (rows: Row[]) => {
  const grid = readWeldLogGrid(workbook(rows), 'log.xlsx')
  return parseFacilityWeldRows(grid.grid, { defaultDesignPressurePsi: 285 })
}

describe('reading the file', () => {
  it('reads a workbook', () => {
    const g = readWeldLogGrid(workbook([row({})]), 'log.xlsx')
    expect(g.format).toBe('xlsx')
    expect(g.error).toBeUndefined()
    expect(g.grid.length).toBe(2)
  })

  it('recognises a PDF by its magic bytes, whatever the filename says', () => {
    const notAPdf = readWeldLogGrid(new Uint8Array([1, 2, 3, 4]), 'log.pdf')
    expect(notAPdf.error).toBeTruthy()
  })

  it('reads the same table out of a PDF as out of a workbook', () => {
    // The overview sheet is the PDF to hand; the point being proved is
    // that a PDF becomes a grid at all, so one parser serves both formats.
    const g = readWeldLogGrid(
      new Uint8Array(require('node:fs').readFileSync('fixtures/greeley/DP-318_Weld_Log_Overview.pdf')),
      'overview.pdf',
    )
    expect(g.format).toBe('pdf')
    expect(g.grid.length).toBeGreaterThan(20)
    expect(g.grid.some((r) => r.some((c) => String(c).includes('TYLER WALKER')))).toBe(true)
  })

  it('says plainly when a PDF has no readable text', () => {
    const g = readWeldLogGrid(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'scan.pdf')
    expect(g.error).toMatch(/scan|No text/i)
  })
})

describe('what the log says about itself', () => {
  const byRule = (findings: OverviewFinding[], id: string) =>
    findings.filter((f) => f.ruleId === id)

  it('catches welds with no welder stamp, and calls it Critical', () => {
    const parsed = read([
      row({ weld: 'W-1' }),
      row({ weld: 'W-2', welder: null }),
      row({ weld: 'W-3', welder: null }),
      row({ weld: 'W-4', welder: null }),
    ])
    const plan = planWeldLogIngest(parsed, bundle())
    const f = byRule(plan.findings, 'weldlog.weld_without_stamp')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.title).toBe('3 welds carry no welder stamp')
    expect(f[0]!.detail).toContain('W-2, W-3, W-4')
  })

  it('catches a stamp that resolves to nobody in the register', () => {
    const parsed = read([row({ weld: 'W-1', welder: 'ZZ' }), row({ weld: 'W-2', welder: 'ZZ' })])
    const plan = planWeldLogIngest(parsed, bundle())
    const f = byRule(plan.findings, 'weldlog.stamp_not_in_register')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.detail).toContain('ZZ (2 welds)')
  })

  it('catches a weld made after the welder’s qualification expired', () => {
    // Keith Taylor's WPQ expires 2025-12-30 on the overview sheet.
    const parsed = read([
      row({ weld: 'W-1', welder: 'KT', date: '2025-06-02' }),
      row({ weld: 'W-2', welder: 'KT', date: '2026-02-14' }),
    ])
    const plan = planWeldLogIngest(parsed, bundle())
    const f = byRule(plan.findings, 'weldlog.weld_outside_qualification')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.detail).toContain('W-2 (KT, 2026-02-14)')
    expect(f[0]!.detail).not.toContain('W-1')
  })

  it('does NOT call an unclosed window an expired qualification', () => {
    // This is the failure that would have shipped: every qualification
    // read off the overview sheet has no start date, so a rule that
    // conflates "unknown start" with "not qualified" raises a Critical
    // against every weld in the book.
    const parsed = read([
      row({ weld: 'W-1', welder: 'KT', date: '2025-06-02' }),
      row({ weld: 'W-2', welder: 'KT', date: '2025-07-02' }),
    ])
    const plan = planWeldLogIngest(parsed, bundle())
    expect(byRule(plan.findings, 'weldlog.weld_outside_qualification')).toHaveLength(0)
    const f = byRule(plan.findings, 'weldlog.qualification_currency_unverifiable')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('warning')
    expect(f[0]!.detail).toMatch(/not an expired qualification/)
  })

  it('catches welds dated after the log was closed', () => {
    const parsed = read([
      row({ weld: 'W-1', date: '2026-01-05' }),
      row({ weld: 'W-2', date: '2027-01-05' }),
    ])
    const plan = planWeldLogIngest(parsed, bundle())
    const f = byRule(plan.findings, 'weldlog.weld_dated_after_log')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.detail).toContain('W-2 (2027-01-05)')
  })

  it('catches welds dated before construction began', () => {
    const parsed = read([row({ weld: 'W-1', date: '2024-05-05' })])
    const plan = planWeldLogIngest(parsed, bundle())
    const f = byRule(plan.findings, 'weldlog.weld_before_construction')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('warning')
  })

  it('says nothing when the log is clean', () => {
    const parsed = read([row({ weld: 'W-1', welder: 'MR', date: '2025-06-02' })])
    const plan = planWeldLogIngest(parsed, {
      ...bundle(),
      welderQualifications: [
        { id: 'q', welderId: 'w-mr', code: 'ASME_IX',
          qualificationDate: '2024-01-01', expiryDate: '2026-07-09' },
      ],
    } as unknown as JobBookBundle)
    expect(plan.findings).toHaveLength(0)
  })
})

describe('the plan', () => {
  it('creates a weld line per construction area, and matches an existing one', () => {
    const parsed = read([
      row({ weld: 'W-1', area: 'Area 7200' }),
      row({ weld: 'W-2', area: 'Area 7200' }),
      row({ weld: 'W-3', area: 'Area 8100' }),
    ])
    const plan = planWeldLogIngest(parsed, {
      ...bundle(),
      weldLines: [{ id: 'line-7200', jobBookId: 'book-1', lineCode: 'Area 7200', sortOrder: 0 }],
    } as unknown as JobBookBundle)
    expect(plan.areas).toHaveLength(2)
    const a72 = plan.areas.find((a) => a.code === 'Area 7200')!
    expect(a72.action).toBe('match')
    expect(a72.weldCount).toBe(2)
    expect(plan.areas.find((a) => a.code === 'Area 8100')!.action).toBe('create')
  })

  it('gives a row with no area a named home rather than dropping it', () => {
    const parsed = read([row({ weld: 'W-1', area: '' })])
    const plan = planWeldLogIngest(parsed, bundle())
    expect(plan.areas.map((a) => a.code)).toContain('Unassigned')
    expect(plan.parsedRows).toBe(1)
  })

  it('counts creates and updates by weld number', () => {
    const parsed = read([row({ weld: 'W-1' }), row({ weld: 'W-2' })])
    const plan = planWeldLogIngest(parsed, {
      ...bundle(),
      welds: [{ id: 'x', jobBookId: 'book-1', weldLineId: 'l', weldNumber: 'W-1', sortOrder: 0 }],
    } as unknown as JobBookBundle)
    expect(plan.weldsToUpdate).toBe(1)
    expect(plan.weldsToCreate).toBe(1)
  })
})

describe('the rows a plan writes', () => {
  it('stamps every weld for §8, and resolves the welder from the register', () => {
    const parsed = read([
      row({ weld: 'W-1', welder: 'KT', date: '2025-06-02', visualDate: '2025-06-02' }),
    ])
    const b = bundle()
    const plan = planWeldLogIngest(parsed, b)
    const rows = rowsForWeldPlan(plan, b, {
      enteredAt: '2026-09-22T12:00:00Z', entrySource: 'field_entry',
      newId: (() => { let n = 0; return () => `line-${(n += 1)}` })(),
    })
    expect(rows.welds).toHaveLength(1)
    const w = rows.welds[0]!
    expect(w.welderId).toBe('w-kt')
    expect(w.welderStamp).toBe('KT')
    expect(w.enteredAt).toBe('2026-09-22T12:00:00Z')
    expect(w.entrySource).toBe('field_entry')
    // The CWI visual is a separate §8.1 event with its own deadline.
    expect(w.visualEnteredAt).toBe('2026-09-22T12:00:00Z')
  })

  it('leaves the visual entry stamp off a weld with no visual date', () => {
    // §8.1 times the visual against the date it was performed. With no
    // such date there is nothing to measure, and a stamp would be data
    // that no rule can ever read.
    const parsed = read([row({ weld: 'W-1', visualDate: null })])
    const b = bundle()
    const rows = rowsForWeldPlan(planWeldLogIngest(parsed, b), b, {
      enteredAt: '2026-09-22T12:00:00Z', entrySource: 'field_entry', newId: () => 'line-1',
    })
    expect(rows.welds[0]!.enteredAt).toBe('2026-09-22T12:00:00Z')
    expect(rows.welds[0]!.visualEnteredAt).toBeNull()
  })

  it('leaves an unresolvable stamp on the row and the welder id null', () => {
    // §9.1: identity is never inferred. The stamp as written stays
    // visible so the gap is findable; guessing a welder would hide it.
    const parsed = read([row({ weld: 'W-1', welder: 'ZZ' })])
    const b = bundle()
    const rows = rowsForWeldPlan(planWeldLogIngest(parsed, b), b, {
      enteredAt: '2026-09-22T12:00:00Z', entrySource: 'field_entry', newId: () => 'line-1',
    })
    expect(rows.welds[0]!.welderStamp).toBe('ZZ')
    expect(rows.welds[0]!.welderId).toBeNull()
  })

  it('gives a weld the same id on re-import, so a corrected log updates', () => {
    const parsed = read([row({ weld: 'W-1' })])
    const b = bundle()
    const first = rowsForWeldPlan(planWeldLogIngest(parsed, b), b, {
      enteredAt: '2026-09-22T12:00:00Z', entrySource: 'field_entry', newId: () => 'line-1',
    })
    const second = rowsForWeldPlan(planWeldLogIngest(read([row({ weld: 'W-1', date: '2025-07-07' })]), b), b, {
      enteredAt: '2026-09-23T12:00:00Z', entrySource: 'field_entry', newId: () => 'line-1',
    })
    expect(second.welds[0]!.id).toBe(first.welds[0]!.id)
    expect(second.welds[0]!.weldDate).toBe('2025-07-07')
  })
})
