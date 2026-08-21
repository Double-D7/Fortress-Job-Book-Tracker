/**
 * How a job decides what inspection its welds owe.
 *
 * This file exists because of a specific mistake. An earlier reading of
 * DP-318 saw a three-tier inspection vocabulary on the workbook's
 * `Data Validation` sheet and concluded the job was governed by a 20% SMYS
 * break point. It is not: cell G7 states "100% visual & 10% NDE", a flat
 * job-wide rule, and no weld log column uses the tier vocabulary at all.
 *
 * The cost of getting it wrong was 90 critical findings against welds that
 * owed nothing — which is worse than missing a real finding, because it
 * sends a crew to radiograph pipe no specification asked them to.
 */
import { describe, expect, it } from 'vitest'
import {
  computeSmys, DP318_INSPECTION_RULE, EXAMPLE_TIER_RULES,
  INSPECTION_TIER_VOCABULARY, TIER_RULES_CONFIRMED,
} from '@/lib/domain/engineering'
import { checkFlatRule } from '@/lib/domain/welders'
import { evaluateFlags } from '@/lib/domain/flags'
import { buildGreeleyBundle } from '@/lib/data/seed/greeley'
import type { JobBookBundle, Weld, Welder } from '@/lib/domain/types'

const bundle = buildGreeleyBundle()

function weld(id: string, welderId: string, hasNde: boolean): Weld {
  return {
    id, weldLineId: 'l', jobBookId: 'b', weldNumber: id, sortOrder: 0,
    weldDate: '2025-10-01', welderPassAssignment: null,
    rootWelderId: null, hotWelderId: null, fillWelderId: null, capWelderId: null,
    welderStamp: welderId, welderId,
    jointType: 'Butt', componentDescription: null, partLength: null, heatNumbers: [],
    cwiInitials: 'AE', cwiId: null, cwiVisualResult: 'Pass', visualInspectionDate: '2025-10-01',
    ndtCompany: null, xrayNumber: null, ndtTicketNumber: hasNde ? 'T-1' : null,
    ndtMethod: hasNde ? 'RT' : null, ndtResult: hasNde ? 'Pass' : null, ndtReportId: null,
    status: 'visual_complete', comments: null,
  }
}
const welders: Welder[] = [
  { id: 'w1', fullName: 'A', initials: 'A', employer: null, active: true, nameAliases: [] },
  { id: 'w2', fullName: 'B', initials: 'B', employer: null, active: true, nameAliases: [] },
]

describe('DP-318 is governed by a flat rule', () => {
  it('carries the rule read from the log, not one inferred from a vocabulary', () => {
    expect(bundle.book.inspectionRule).toEqual({
      kind: 'flat',
      requiredVisualPct: 100,
      requiredNdePct: 10,
      statedAs: 'Project Totals- Requirement- 100% visual & 10% NDE',
    })
  })

  it('never raises a tier finding on a flat-rule book', () => {
    const findings = evaluateFlags(bundle, { asOf: '2026-08-21', tierRules: EXAMPLE_TIER_RULES })
    expect(findings.filter((f) => f.ruleId === 'weld.tier_not_met')).toHaveLength(0)
  })

  it('keeps the tier vocabulary available without putting it in force', () => {
    expect(INSPECTION_TIER_VOCABULARY).toHaveLength(3)
    expect(TIER_RULES_CONFIRMED).toBe(false)
  })

  it('still computes % of SMYS, which is engineering data either way', () => {
    const r = computeSmys({
      pipeSizeSchedule: '3" - SCH 80. XS', pipeGrade: 'Gr. B', designPressurePsi: 1440,
    })
    expect(r.pctSmys).toBeCloseTo(0.24, 4)
    expect(r.tier).toBeNull()
  })
})

describe('the flat rule, checked per welder', () => {
  const rule = DP318_INSPECTION_RULE

  it('passes a welder at or above the requirement', () => {
    // 10 welds, 1 examined = 10.0%, exactly the requirement.
    const welds = Array.from({ length: 10 }, (_, i) => weld(`w${i}`, 'w1', i === 0))
    const r = checkFlatRule(welds, welders, rule)
    expect(r.perWelder[0]!.ndePct).toBeCloseTo(10, 4)
    expect(r.allMeet).toBe(true)
  })

  it('fails a welder below it', () => {
    const welds = Array.from({ length: 20 }, (_, i) => weld(`w${i}`, 'w1', i === 0))
    expect(checkFlatRule(welds, welders, rule).allMeet).toBe(false)
  })

  it('names the lowest welder, which is what a manager chases', () => {
    const welds = [
      ...Array.from({ length: 10 }, (_, i) => weld(`a${i}`, 'w1', i < 5)),   // 50%
      ...Array.from({ length: 10 }, (_, i) => weld(`b${i}`, 'w2', i < 2)),   // 20%
    ]
    expect(checkFlatRule(welds, welders, rule).lowest?.initials).toBe('B')
  })

  it('counts every examination method, not only radiography', () => {
    // DP-318 records 194 RT and 27 PT against one 10% requirement.
    // Counting only RT would under-report every welder by their PT work.
    const welds = [
      weld('1', 'w1', false), weld('2', 'w1', false), weld('3', 'w1', false),
      weld('4', 'w1', false), weld('5', 'w1', false), weld('6', 'w1', false),
      weld('7', 'w1', false), weld('8', 'w1', false), weld('9', 'w1', false),
      { ...weld('10', 'w1', true), ndtMethod: 'PT' as const },
    ]
    const r = checkFlatRule(welds, welders, rule)
    expect(r.perWelder[0]!.nde).toBe(1)
    expect(r.allMeet).toBe(true)
  })

  it('raises a flat-rule finding rather than an X-ray-minimum one', () => {
    const short = {
      ...bundle,
      welders,
      welds: Array.from({ length: 20 }, (_, i) => weld(`x${i}`, 'w1', i === 0)),
    } as JobBookBundle
    const ids = evaluateFlags(short, { asOf: '2026-08-21' }).map((f) => f.ruleId)
    expect(ids).toContain('welder.below_job_nde_requirement')
    expect(ids).not.toContain('welder.below_xray_minimum')
  })
})

describe('rules do not fire against sections nobody has read', () => {
  const findings = evaluateFlags(bundle, { asOf: '2026-08-21' })

  it('does not accuse unread pressure packs of having no recorder certificate', () => {
    // Every DP-318 test pack holds the Crystal nVision certificate. The
    // section is simply unread, and "no valid certificate" would be false.
    expect(findings.filter((f) => f.ruleId === 'pressure.no_valid_recorder_cert')).toHaveLength(0)
  })

  it('counts only the sections verified empty, not the unread ones', () => {
    const empty = findings.filter((f) => f.ruleId === 'section.empty_required')
    expect(empty).toHaveLength(3)
    expect(empty.map((f) => f.sectionNumber).sort()).toEqual(['16', '18', '19'])
  })

  it('does not report missing MTRs while section 15 is unread', () => {
    expect(findings.filter((f) => f.ruleId === 'material.heat_without_mtr')).toHaveLength(0)
  })
})

describe('wrenches in use that no roster row lists', () => {
  it('is critical, not a warning', () => {
    const f = evaluateFlags(bundle, { asOf: '2026-08-21' })
      .filter((x) => x.ruleId === 'torque.wrench_not_on_roster')
    expect(f).toHaveLength(4)
    expect(f.every((x) => x.severity === 'critical')).toBe(true)
    expect(f.map((x) => x.title.match(/Wrench (\d+)/)?.[1]).sort())
      .toEqual(['0216', '0719', '5123', '9125'])
  })
})
