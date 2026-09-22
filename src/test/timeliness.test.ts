/**
 * Entry Timeliness — FDS-JBMP-001 §8.
 *
 * The failure mode this guards against is not a wrong percentage. It is a
 * percentage that looks right and means nothing: 100% over four records
 * because the other two thousand were bulk-imported and quietly dropped,
 * or 0% across a delivered book because every row was timed against an
 * import date. Either one, read once by a Project Manager, ends the
 * usefulness of the metric permanently.
 *
 * So most of these tests are about the denominator.
 */
import { describe, expect, it } from 'vitest'
import {
  ENTRY_STANDARDS,
  addBusinessDays,
  assessEntry,
  businessDaysBetween,
  byStandard,
  entryTimeliness,
  escalationWeeks,
  isWorkingDay,
  weekStart,
  weeklyTimeliness,
  type MeasurableEvent,
  type WorkWeek,
} from '@/lib/domain/timeliness'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { JobBookBundle } from '@/lib/domain/types'

// 2026-09-14 is a Monday; 2026-09-19 a Saturday; 2026-09-20 a Sunday.
const MON = '2026-09-14'
const FRI = '2026-09-18'
const SAT = '2026-09-19'
const SUN = '2026-09-20'

describe('business days follow the crew, not the calendar', () => {
  it('knows which days each declared work week works', () => {
    expect(isWorkingDay(SAT, 'mon_fri')).toBe(false)
    expect(isWorkingDay(SAT, 'mon_sat')).toBe(true)
    expect(isWorkingDay(SUN, 'mon_sat')).toBe(false)
    expect(isWorkingDay(SUN, 'all_days')).toBe(true)
  })

  it('"end of next business day" skips the weekend on a Mon-Fri book', () => {
    expect(addBusinessDays(FRI, 1, 'mon_fri')).toBe('2026-09-21') // Monday
    expect(addBusinessDays(FRI, 1, 'mon_sat')).toBe(SAT)
    expect(addBusinessDays(FRI, 1, 'all_days')).toBe(SAT)
  })

  it('the same work week changes the deadline, which is why it is a book setting', () => {
    // Five business days from a Monday lands a week apart depending on
    // whether the crew works Saturdays.
    expect(addBusinessDays(MON, 5, 'mon_fri')).toBe('2026-09-21')
    expect(addBusinessDays(MON, 5, 'mon_sat')).toBe(SAT)
  })

  it('a same-day standard on a non-working day rolls forward, never backward', () => {
    // A weekend callout on a Mon-Fri book: the deadline cannot already
    // have expired at the moment the work happened.
    expect(addBusinessDays(SUN, 0, 'mon_fri')).toBe('2026-09-21')
    expect(addBusinessDays(MON, 0, 'mon_fri')).toBe(MON)
  })

  it('counts between two dates, and signs the answer', () => {
    expect(businessDaysBetween(MON, FRI, 'mon_fri')).toBe(4)
    expect(businessDaysBetween(FRI, MON, 'mon_fri')).toBe(-4)
    expect(businessDaysBetween(MON, MON, 'mon_fri')).toBe(0)
    expect(businessDaysBetween(FRI, '2026-09-21', 'mon_fri')).toBe(1)
  })
})

describe('one record, one verdict', () => {
  const ev = (o: Partial<MeasurableEvent>): MeasurableEvent => ({
    standardId: 'weld', recordId: 'w1', recordLabel: 'Weld 1',
    workDate: MON, enteredAt: `${MON}T18:00:00Z`, entrySource: 'field_entry', ...o,
  })
  const at = (o: Partial<MeasurableEvent>, w: WorkWeek = 'mon_fri') => assessEntry(ev(o), w)

  it('entered the same day is on time against a next-day standard', () => {
    expect(at({}).verdict).toBe('on_time')
  })

  it('entered the next business day is still on time', () => {
    expect(at({ enteredAt: '2026-09-15T08:00:00Z' }).verdict).toBe('on_time')
  })

  it('entered the day after that is late, and says by how much', () => {
    const a = at({ enteredAt: '2026-09-17T08:00:00Z' })
    expect(a.verdict).toBe('late')
    expect(a.dueBy).toBe('2026-09-15')
    expect(a.daysLate).toBe(2)
  })

  it('a Friday weld filed Monday is on time on a Mon-Fri book, late on a Mon-Sat one', () => {
    expect(at({ workDate: FRI, enteredAt: '2026-09-21T08:00:00Z' }, 'mon_fri').verdict).toBe('on_time')
    expect(at({ workDate: FRI, enteredAt: '2026-09-21T08:00:00Z' }, 'mon_sat').verdict).toBe('late')
  })

  it('a bulk import is unmeasurable however well it would have scored', () => {
    const a = at({ entrySource: 'bulk_import' })
    expect(a.verdict).toBe('unmeasurable')
    expect(a.reason).toMatch(/when the file was read/)
  })

  it('a record with no entry stamp is unmeasurable, not on time', () => {
    expect(at({ enteredAt: null }).verdict).toBe('unmeasurable')
  })

  it('a record that does not say how it arrived is unmeasurable, not on time', () => {
    const a = at({ entrySource: null })
    expect(a.verdict).toBe('unmeasurable')
    expect(a.reason).toMatch(/does not say how it arrived/)
  })

  it('a record with no work date is unmeasurable, not on time', () => {
    expect(at({ workDate: null }).verdict).toBe('unmeasurable')
  })

  it('a record entered before the work it reports is called out as exactly that', () => {
    const a = at({ workDate: FRI, enteredAt: `${MON}T08:00:00Z` })
    expect(a.verdict).toBe('entered_before_work')
    expect(a.reason).toMatch(/predates the work it reports/)
  })

  it('a §8.2 precondition is not timed at all', () => {
    const a = at({ standardId: 'material' })
    expect(a.verdict).toBe('precondition')
    expect(a.reason).toMatch(/not a deadline/)
  })

  it('the same-day standard is same-day, and one day later is late', () => {
    expect(at({ standardId: 'weld_visual' }).verdict).toBe('on_time')
    expect(at({ standardId: 'weld_visual', enteredAt: '2026-09-15T08:00:00Z' }).verdict).toBe('late')
  })
})

describe('the standards are the program’s', () => {
  it('carries §8.1 verbatim, with each deadline and owner', () => {
    const byId = new Map(ENTRY_STANDARDS.map((s) => [s.id, s]))
    expect(byId.get('weld')?.statedAs).toBe('End of next business day')
    expect(byId.get('weld_visual')?.statedAs).toBe('End of same business day')
    expect(byId.get('weld_visual')?.responsible).toBe('Certified Welding Inspector')
    expect(byId.get('nde_report')?.statedAs).toBe('3 business days')
    expect(byId.get('pressure_test')?.statedAs).toBe('5 business days')
    expect(byId.get('material')?.statedAs).toBe('At receipt, before release to install')
  })

  it('maps every standard to the section it lands in', () => {
    const byId = new Map(ENTRY_STANDARDS.map((s) => [s.id, s]))
    expect(byId.get('weld')?.sectionNumber).toBe('12')
    expect(byId.get('torque')?.sectionNumber).toBe('14')
    expect(byId.get('material')?.sectionNumber).toBe('15')
    expect(byId.get('pressure_test')?.sectionNumber).toBe('17')
    expect(byId.get('coating')?.sectionNumber).toBe('23')
  })
})

describe('the rate refuses to flatter the book', () => {
  it('a book with nothing measurable has no rate at all, not 0% and not 100%', () => {
    // DP452 is a delivered reference book: its records were never entered
    // under this program, so §8 has nothing to say about it. Saying so is
    // the whole point.
    const r = entryTimeliness(buildDp452Bundle())
    expect(r.ratePct).toBeNull()
    expect(r.totalMeasured).toBe(0)
    expect(r.unmeasurable).toBeGreaterThan(0)
    expect(r.meetsTarget).toBe(false)
    expect(r.needsEscalation).toBe(false)
  })

  it('bulk-imported records never reach the denominator', () => {
    const base = buildDp452Bundle()
    const b: JobBookBundle = {
      ...base,
      welds: base.welds.map((w) => ({
        ...w, enteredAt: `${MON}T08:00:00Z`, entrySource: 'bulk_import' as const,
      })),
    }
    const r = entryTimeliness(b)
    expect(r.totalMeasured).toBe(0)
    expect(r.unmeasurable).toBeGreaterThanOrEqual(base.welds.length)
  })

  it('field entries do, and the arithmetic is plain', () => {
    const base = buildDp452Bundle()
    const dated = base.welds.filter((w) => w.weldDate).slice(0, 10)
    const b: JobBookBundle = {
      ...base,
      // Only the ten, and only the weld event: a weld also carries a CWI
      // visual with its own §8.1 standard, and leaving those in would make
      // this test measure two standards while claiming to measure one.
      welds: dated.map((w, i) => ({
        ...w,
        visualInspectionDate: null,
        // First eight on the day of the weld, last two a fortnight later.
        enteredAt: `${i < 8 ? w.weldDate! : addBusinessDays(w.weldDate!, 10, 'mon_fri')}T12:00:00Z`,
        entrySource: 'field_entry' as const,
      })),
      torqueConnections: [], ndeReports: [], pressureTests: [],
      cpTestPoints: [], utReadings: [], materialHeats: [], coatingInspections: [],
    }
    const r = entryTimeliness(b)
    expect(r.totalMeasured).toBe(10)
    expect(r.withinStandard).toBe(8)
    expect(r.ratePct).toBe(80)
    expect(r.meetsTarget).toBe(false)   // below 95
    expect(r.needsEscalation).toBe(true) // below 90
    expect(r.late).toHaveLength(2)
  })

  it('95 meets the target; 94.99 does not', () => {
    const mk = (onTime: number, late: number): JobBookBundle => {
      const base = buildDp452Bundle()
      const welds = base.welds.filter((w) => w.weldDate).slice(0, onTime + late)
      return {
        ...base,
        welds: welds.map((w, i) => ({
          ...w,
          // The weld event only — see the note above.
          visualInspectionDate: null,
          enteredAt: `${i < onTime ? w.weldDate! : addBusinessDays(w.weldDate!, 9, 'mon_fri')}T12:00:00Z`,
          entrySource: 'field_entry' as const,
        })),
        torqueConnections: [], ndeReports: [], pressureTests: [],
        cpTestPoints: [], utReadings: [], materialHeats: [], coatingInspections: [],
      }
    }
    expect(entryTimeliness(mk(19, 1)).ratePct).toBe(95)
    expect(entryTimeliness(mk(19, 1)).meetsTarget).toBe(true)
    expect(entryTimeliness(mk(18, 2)).ratePct).toBe(90)
    expect(entryTimeliness(mk(18, 2)).meetsTarget).toBe(false)
    expect(entryTimeliness(mk(18, 2)).needsEscalation).toBe(false) // 90 is the floor, not below it
    expect(entryTimeliness(mk(17, 3)).needsEscalation).toBe(true)
  })
})

describe('weeks, and the §8.3 escalation', () => {
  it('a week starts on Monday, whichever day you ask about', () => {
    expect(weekStart(MON)).toBe(MON)
    expect(weekStart(FRI)).toBe(MON)
    expect(weekStart(SUN)).toBe(MON)   // Sunday belongs to the week it ends
    expect(weekStart('2026-09-21')).toBe('2026-09-21')
  })

  it('two consecutive measured weeks below 90% escalate; one does not', () => {
    const p = (start: string, rate: number | null) => ({
      periodStart: start, periodEnd: start, ratePct: rate,
      withinStandard: 0, totalMeasured: rate == null ? 0 : 10, unmeasurable: 0,
    })
    expect(escalationWeeks([p('2026-09-07', 85), p('2026-09-14', 96)])).toHaveLength(0)
    expect(escalationWeeks([p('2026-09-07', 85), p('2026-09-14', 88)])).toHaveLength(1)
  })

  it('a week where nothing was entered cannot break a run of failures', () => {
    // Otherwise a book dodges escalation by filing nothing at all, which
    // is the exact behaviour §8 exists to catch.
    const p = (start: string, rate: number | null) => ({
      periodStart: start, periodEnd: start, ratePct: rate,
      withinStandard: 0, totalMeasured: rate == null ? 0 : 10, unmeasurable: 0,
    })
    const runs = escalationWeeks([p('2026-09-07', 85), p('2026-09-14', null), p('2026-09-21', 80)])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.periodStart).toBe('2026-09-21')
  })

  it('buckets entries by the week they were ENTERED, not the week worked', () => {
    // A backlog cleared in May is May's number. That is what makes the
    // clearing visible instead of retroactively fixing March.
    const base = buildDp452Bundle()
    const w = base.welds.find((x) => x.weldDate)!
    const b: JobBookBundle = {
      ...base,
      welds: [{ ...w, weldDate: '2026-03-02', enteredAt: '2026-05-04T09:00:00Z',
        entrySource: 'field_entry' as const }],
      torqueConnections: [], ndeReports: [], pressureTests: [],
      cpTestPoints: [], utReadings: [], materialHeats: [], coatingInspections: [],
    }
    const weeks = weeklyTimeliness(b)
    expect(weeks).toHaveLength(1)
    expect(weeks[0]!.periodStart).toBe('2026-05-04')
    expect(weeks[0]!.ratePct).toBe(0)
  })
})

describe('the breakdown answers "which crew"', () => {
  it('reports per standard, and omits standards with nothing in them', () => {
    const base = buildDp452Bundle()
    const w = base.welds.find((x) => x.weldDate)!
    const b: JobBookBundle = {
      ...base,
      welds: [{ ...w, enteredAt: `${w.weldDate}T09:00:00Z`, entrySource: 'field_entry' as const,
        visualInspectionDate: null }],
      torqueConnections: [], ndeReports: [], pressureTests: [],
      cpTestPoints: [], utReadings: [], materialHeats: [], coatingInspections: [],
    }
    const rows = byStandard(entryTimeliness(b))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.standard.id).toBe('weld')
    expect(rows[0]!.ratePct).toBe(100)
  })
})

describe('one record can owe two deadlines', () => {
  it('a weld with a CWI visual produces two events, timed separately', () => {
    // §8.1 gives "Weld completed" end of NEXT business day and "CWI visual
    // inspection performed" end of SAME business day, with different
    // owners. One stamp cannot answer both, and treating the weld as a
    // single event hides every late visual behind an on-time weld.
    const base = buildDp452Bundle()
    const w = base.welds.find((x) => x.weldDate)!
    const b: JobBookBundle = {
      ...base,
      welds: [{
        ...w,
        weldDate: MON,
        visualInspectionDate: MON,
        // Filed the next morning: fine for the weld, a day late for the
        // visual.
        enteredAt: '2026-09-15T08:00:00Z',
        entrySource: 'field_entry' as const,
      }],
      torqueConnections: [], ndeReports: [], pressureTests: [],
      cpTestPoints: [], utReadings: [], materialHeats: [], coatingInspections: [],
    }
    const r = entryTimeliness(b)
    expect(r.totalMeasured).toBe(2)
    expect(r.withinStandard).toBe(1)
    expect(r.late).toHaveLength(1)
    expect(r.late[0]!.standardId).toBe('weld_visual')
  })

  it('a separate visual stamp is used in preference to the record’s own', () => {
    const base = buildDp452Bundle()
    const w = base.welds.find((x) => x.weldDate)!
    const b: JobBookBundle = {
      ...base,
      welds: [{
        ...w, weldDate: MON, visualInspectionDate: MON,
        enteredAt: '2026-09-15T08:00:00Z',
        visualEnteredAt: `${MON}T17:00:00Z`,
        entrySource: 'field_entry' as const,
      }],
      torqueConnections: [], ndeReports: [], pressureTests: [],
      cpTestPoints: [], utReadings: [], materialHeats: [], coatingInspections: [],
    }
    const r = entryTimeliness(b)
    expect(r.withinStandard).toBe(2)
    expect(r.late).toHaveLength(0)
  })
})
