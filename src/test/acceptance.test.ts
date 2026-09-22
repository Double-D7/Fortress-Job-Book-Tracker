/**
 * Acceptance criteria from §11 of the build brief, asserted against the
 * DP452 reference book. These are the numbers Fortress and the operator
 * will check first; if any of them moves, the change was a regression
 * until proven otherwise.
 */
import { describe, expect, it } from 'vitest'
import { buildDp452Bundle, WELDER_TARGETS } from '@/lib/data/seed/dp452'
import { rollupByWelder, xrayTotals } from '@/lib/domain/welders'
import { reconcileWrenches, torqueTotals } from '@/lib/domain/torque'
import { scoreBook } from '@/lib/domain/scoring'
import { evaluateFlags } from '@/lib/domain/flags'
import { reconcileHeats } from '@/lib/domain/reconcile'
import { buildTemplateSections, MASTER_CHECKLIST } from '@/lib/domain/checklist'

const bundle = buildDp452Bundle()
const EVAL_DATE = '2026-08-17'

describe('§11.1 — a flowline book scaffolds all 22 sections', () => {
  it('carries every checklist section plus the combined flowline map', () => {
    const defs = buildTemplateSections('flowline', 'tpl')
    for (const entry of MASTER_CHECKLIST) {
      expect(defs.map((d) => d.sectionNumber)).toContain(entry.sectionNumber)
    }
    expect(defs.map((d) => d.sectionNumber)).toContain('19-22')
  })

  it('auto-marks the facility-only sections N/A with a recorded reason', () => {
    for (const n of ['19', '20', '21', '22']) {
      const def = bundle.sectionDefinitions.find((d) => d.sectionNumber === n)!
      const section = bundle.sections.find((s) => s.sectionDefinitionId === def.id)!
      expect(section.status).toBe('na')
      expect(section.naReason).toBeTruthy()
    }
  })

  it('preserves the checklist titles verbatim', () => {
    const s12 = bundle.sectionDefinitions.find((d) => d.sectionNumber === '12')!
    expect(s12.title).toBe('Detailed Weld Log')
    const s11 = bundle.sectionDefinitions.find((d) => d.sectionNumber === '11')!
    expect(s11.title).toBe('Weld Log Overview Sheet with Inspection Percentages')
    const s17 = bundle.sectionDefinitions.find((d) => d.sectionNumber === '17')!
    expect(s17.title).toBe('Pressure Testing Results with Recorder Calibration Certificates')
  })
})

describe('§11.2 — imported records reproduce the welder-credit totals', () => {
  it('reproduces 2,476 weld credits and 631 X-ray credits', () => {
    const totals = xrayTotals(bundle.welds, bundle.book, bundle.welders)
    expect(totals.totalWeldCredits).toBe(2476)
    expect(totals.totalXrayCredits).toBe(631)
  })

  it('carries 955 joint rows in the Flow Lines workbook', () => {
    const flowLineIds = new Set(
      bundle.weldLines.filter((l) => l.workbook === 'Flow Lines').map((l) => l.id),
    )
    const joints = bundle.welds.filter(
      (w) => flowLineIds.has(w.weldLineId) && w.status !== 'not_used',
    )
    expect(joints.length).toBe(955)
  })

  it('keeps the credit total distinct from — and larger than — the joint count', () => {
    const totals = xrayTotals(bundle.welds, bundle.book, bundle.welders)
    expect(totals.jointCount).toBe(2342)
    expect(totals.totalWeldCredits).toBeGreaterThan(totals.jointCount)
    expect(totals.creditOverstatementPct).toBeCloseTo(5.7, 1)
  })

  it('excludes NOT USED weld numbers from every denominator', () => {
    const notUsed = bundle.welds.filter((w) => w.status === 'not_used')
    expect(notUsed.length).toBeGreaterThan(0)
    const totals = xrayTotals(bundle.welds, bundle.book, bundle.welders)
    expect(totals.jointCount).toBe(bundle.welds.length - notUsed.length)
  })
})

describe('§11.5 — per-welder X-ray percentages match the audited table', () => {
  const rollups = rollupByWelder(bundle.welds, bundle.welders, bundle.book)

  it.each(WELDER_TARGETS.map((t) => [t.initials, t.welds, t.xrays] as const))(
    '%s: %i welds / %i X-rays',
    (initials, welds, xrays) => {
      const r = rollups.find((x) => x.initials === initials)
      expect(r).toBeDefined()
      expect(r!.totalWelds).toBe(welds)
      expect(r!.totalXrays).toBe(xrays)
      expect(r!.xrayPct).toBeCloseTo((xrays / welds) * 100, 1)
    },
  )

  it('matches the published per-welder percentages', () => {
    const expected: Record<string, number> = {
      HS2: 30.2, KR: 25.7, CT: 28.4, JD: 19.5, VL: 22.5, GQ: 32.6, JM: 52.4, SV: 100,
    }
    for (const [initials, pct] of Object.entries(expected)) {
      const r = rollups.find((x) => x.initials === initials)!
      expect(r.xrayPct).toBeCloseTo(pct, 1)
    }
  })

  it('gives an overall rate of 25.5%', () => {
    expect(xrayTotals(bundle.welds, bundle.book, bundle.welders).xrayPct).toBeCloseTo(25.5, 1)
  })

  it('flags any welder below the job minimum', () => {
    // Every DP452 welder clears the 10% job minimum, so no flag is raised.
    expect(rollups.every((r) => r.meetsRequirement)).toBe(true)
    // Raising the requirement to 26% must flag exactly those below it.
    const strict = rollupByWelder(bundle.welds, bundle.welders, {
      ...bundle.book, requiredXrayPct: 26,
    })
    const failing = strict.filter((r) => !r.meetsRequirement).map((r) => r.initials).sort()
    expect(failing).toEqual(['JD', 'KR', 'VL'])
  })
})

describe('§11.6 — torque inspection percentage reads 19.16%', () => {
  const totals = torqueTotals(bundle.torqueConnections, bundle.book)

  it('counts 616 connections with 118 inspected', () => {
    expect(totals.totalConnections).toBe(616)
    expect(totals.inspectedConnections).toBe(118)
  })

  it('reports 19.16%', () => {
    expect(Number(totals.inspectionPct.toFixed(2))).toBe(19.16)
  })

  it('reconciles roster, usage and certificates as three different sets', () => {
    const rec = reconcileWrenches(bundle.torqueConnections, bundle.torqueWrenches)
    expect(rec.onRoster).toHaveLength(9)
    expect(rec.inUse).toHaveLength(11)
    expect(rec.certified).toHaveLength(12)
    expect(rec.inUse.filter((id) => rec.certified.includes(id))).toHaveLength(10)
    expect(rec.usedNotOnRoster.sort()).toEqual(['0284', '0534'])
    expect(rec.usedWithoutCertificate).toEqual(['0284'])
    expect(rec.certifiedNeverUsed.sort()).toEqual(['0934', '4206'])
  })
})

describe('§11.4 — completion is below 100% and names the missing sections', () => {
  const score = scoreBook(bundle)

  it('scores below 100%', () => {
    expect(score.overallPct).toBeLessThan(100)
  })

  it('identifies sections 16, 17 and 18 as missing', () => {
    const missing = score.missingSections.map((s) => s.sectionNumber).sort()
    expect(missing).toEqual(['16', '17', '18'])
  })

  it('caps the book at 86% from those three sections alone', () => {
    // With every other section perfect, the 14 weight points carried by
    // sections 16, 17 and 18 cap the book at 86%.
    const perfect = {
      ...bundle,
      sections: bundle.sections.map((s) => ({ ...s, status: s.status })),
    }
    const lost = score.sections
      .filter((s) => ['16', '17', '18'].includes(s.sectionNumber))
      .reduce((sum, s) => sum + s.weight, 0)
    expect(lost).toBe(14)
    expect(scoreBook(perfect).weightAvailable).toBe(100)
    expect(100 - lost).toBe(86)
    expect(score.overallPct).toBeLessThanOrEqual(86)
  })

  it('excludes N/A and derived sections from both sides of the division', () => {
    const counted = score.sections.filter((s) => s.countsTowardTotal)
    expect(counted.every((s) => s.status !== 'na')).toBe(true)
    expect(counted.some((s) => s.requirementType === 'derived')).toBe(false)
    expect(score.weightAvailable).toBe(100)
  })

  it('decomposes every score into its inputs', () => {
    for (const s of score.sections.filter((x) => x.countsTowardTotal && x.weight > 0)) {
      expect(s.explanation.length).toBeGreaterThan(0)
      expect(s.inputs.length).toBeGreaterThan(0)
      for (const i of s.inputs) expect(i.denominator).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('§11.7 — the wrench 1304 and DP425 findings are raised as Critical', () => {
  const findings = evaluateFlags(bundle, { asOf: EVAL_DATE })

  it('flags wrench 1304 whose calibration postdates the work it certifies', () => {
    const f = findings.filter((x) => x.ruleId === 'torque.wrench_not_yet_issued')
    expect(f.length).toBeGreaterThan(0)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.title).toContain('1304')
    expect(f[0]!.detail).toContain('2025-07-10')
  })

  it('flags the DP425 report filed inside the DP452 book', () => {
    const f = findings.find((x) => x.ruleId === 'document.wrong_job')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('critical')
    expect(f!.title).toContain('DP425')
    const byName = findings.find((x) => x.ruleId === 'document.wrong_job_filename')
    expect(byName?.title).toContain('DP425')
  })

  it('flags future-dated records', () => {
    const f = findings.filter((x) => x.ruleId === 'record.future_dated')
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity === 'critical')).toBe(true)
  })

  it('flags a weld performed before its welder was qualified', () => {
    const f = findings.filter((x) => x.ruleId === 'welder.not_qualified_on_weld_date')
    expect(f.length).toBeGreaterThan(0)
    expect(f[0]!.severity).toBe('critical')
  })

  it('flags an NDE report signed by a technician whose card had lapsed', () => {
    const f = findings.filter((x) => x.ruleId === 'nde.technician_not_certified_on_report_date')
    expect(f.length).toBeGreaterThan(0)
  })

  it('surfaces the ZIP bundles as unindexable', () => {
    const f = findings.filter((x) => x.ruleId === 'document.archive_uploaded')
    expect(f).toHaveLength(3)
  })

  it('surfaces duplicate files by content hash', () => {
    const f = findings.filter((x) => x.ruleId === 'document.duplicate')
    expect(f.length).toBeGreaterThan(0)
  })

  it('surfaces that every connection records actual torque equal to required', () => {
    const f = findings.find((x) => x.ruleId === 'torque.implausibly_exact')
    expect(f).toBeDefined()
    expect(f!.detail).toContain('616')
  })

  it('gives every finding a fingerprint that is stable across runs', () => {
    const again = evaluateFlags(buildDp452Bundle(), { asOf: EVAL_DATE })
    expect(again.map((f) => f.fingerprint)).toEqual(findings.map((f) => f.fingerprint))
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length)
  })
})

describe('MTR / heat reconciliation', () => {
  const rec = reconcileHeats(bundle.welds, bundle.materialHeats)

  it('reports heats referenced by welds with no MTR on file', () => {
    expect(rec.heatsWithoutMtr.length).toBeGreaterThan(0)
    for (const h of rec.heatsWithoutMtr) expect(h.weldCount).toBeGreaterThan(0)
  })

  it('reports MTRs on file that no weld references', () => {
    expect(rec.mtrsWithoutWelds.length).toBeGreaterThan(0)
  })

  it('bases coverage on referenced heats, not on the size of the MTR folder', () => {
    expect(rec.coveragePct).toBeLessThan(100)
    expect(rec.referencedHeats.length).toBe(198)
  })
})

describe('the delivered book carries its documented defects', () => {
  it('holds 315 files totalling roughly 402 MB', () => {
    expect(bundle.documents).toHaveLength(315)
    const mb = bundle.documents.reduce((s, d) => s + (d.byteSize ?? 0), 0) / 1_048_576
    expect(mb).toBeGreaterThan(350)
    expect(mb).toBeLessThan(450)
  })

  it('resolves four spellings of one welder to a single managed record', () => {
    const ct = bundle.welders.find((w) => w.initials === 'CT')!
    expect(ct.nameAliases).toContain('Cannon Tracey')
    expect(ct.nameAliases).toContain('Canor Tracy')
    expect(ct.nameAliases).toContain('Coner Tracy')
    expect(bundle.welders.filter((w) => /trac/i.test(w.fullName))).toHaveLength(1)
  })

  it('has no pressure test, CP or UT records at all', () => {
    expect(bundle.pressureTests).toHaveLength(0)
    expect(bundle.cpTestPoints).toHaveLength(0)
    expect(bundle.utReadings).toHaveLength(0)
  })
})
