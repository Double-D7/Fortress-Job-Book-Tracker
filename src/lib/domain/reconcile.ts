/**
 * Traceability reconciliation.
 *
 * The system of record for material is the heat number, entered as
 * structured data; the MTR PDF is an attachment to that heat. That
 * inversion is what makes these two reports possible, and they are exactly
 * what an auditor spot-checks:
 *
 *   - every heat number referenced by a weld has an MTR on file
 *   - every MTR on file is referenced by at least one weld
 */
import type { CpTestPoint, MaterialHeat, NdeReport, TorqueConnection, Weld } from './types'
import { isCountable, isXrayed } from './welders'

export interface HeatReconciliation {
  /** Heat numbers referenced by at least one weld. */
  referencedHeats: string[]
  /** Referenced by a weld, but no heat record or no MTR attached. */
  heatsWithoutMtr: { heatNumber: string; weldCount: number; hasRecord: boolean }[]
  /** A heat record with an MTR that no weld references. */
  mtrsWithoutWelds: MaterialHeat[]
  coveragePct: number
}

export function reconcileHeats(welds: Weld[], heats: MaterialHeat[]): HeatReconciliation {
  const weldCountByHeat = new Map<string, number>()
  for (const w of welds) {
    if (!isCountable(w)) continue
    for (const h of w.heatNumbers) {
      const key = h.trim()
      if (!key) continue
      weldCountByHeat.set(key, (weldCountByHeat.get(key) ?? 0) + 1)
    }
  }
  const byNumber = new Map(heats.map((h) => [h.heatNumber.trim(), h]))
  const referenced = [...weldCountByHeat.keys()].sort()

  const heatsWithoutMtr = referenced
    .filter((h) => {
      const rec = byNumber.get(h)
      return !rec || !rec.mtrDocumentId || rec.mtrStatus !== 'on_file'
    })
    .map((h) => ({
      heatNumber: h,
      weldCount: weldCountByHeat.get(h) ?? 0,
      hasRecord: byNumber.has(h),
    }))

  const mtrsWithoutWelds = heats.filter(
    (h) => h.mtrDocumentId && !weldCountByHeat.has(h.heatNumber.trim()),
  )

  const covered = referenced.length - heatsWithoutMtr.length
  return {
    referencedHeats: referenced,
    heatsWithoutMtr,
    mtrsWithoutWelds,
    coveragePct: referenced.length ? (covered / referenced.length) * 100 : 100,
  }
}

export interface NdeReconciliation {
  /** A weld records an examination but no report line points back to it. */
  weldsClaimingNdeWithoutReport: Weld[]
  /** A report line names a weld that does not exist in this book. */
  reportLinesWithoutWeld: { reportId: string; reportDate: string; weldNumber: string }[]
  linkedCount: number
}

export function reconcileNde(welds: Weld[], reports: NdeReport[]): NdeReconciliation {
  const live = reports.filter((r) => !r.isSuperseded)
  const weldIdsCovered = new Set<string>()
  const reportLinesWithoutWeld: NdeReconciliation['reportLinesWithoutWeld'] = []

  for (const r of live) {
    for (const line of r.lines) {
      if (line.weldId) weldIdsCovered.add(line.weldId)
      else if (line.weldNumber) {
        reportLinesWithoutWeld.push({
          reportId: r.id, reportDate: r.reportDate, weldNumber: line.weldNumber,
        })
      }
    }
  }

  const weldsClaimingNdeWithoutReport = welds.filter(
    (w) => isCountable(w) && isXrayed(w) && !w.ndtReportId && !weldIdsCovered.has(w.id),
  )

  return {
    weldsClaimingNdeWithoutReport,
    reportLinesWithoutWeld,
    linkedCount: weldIdsCovered.size,
  }
}

export interface CpReconciliation {
  /** `CP TEST ON FLANGE = Y` with no cathodic protection test point on
   *  file. This is the tie between section 14 and section 18. */
  flangesAwaitingCpPoint: TorqueConnection[]
  /** A CP point pointing at a flange not marked for testing. */
  orphanCpPoints: CpTestPoint[]
  coveragePct: number
}

export function reconcileCp(
  connections: TorqueConnection[],
  points: CpTestPoint[],
): CpReconciliation {
  const pointsByConnection = new Set(
    points.map((p) => p.torqueConnectionId).filter((x): x is string => !!x),
  )
  const flagged = connections.filter((c) => c.cpTestOnFlange)
  const awaiting = flagged.filter((c) => !pointsByConnection.has(c.id))
  const flaggedIds = new Set(flagged.map((c) => c.id))
  const orphans = points.filter(
    (p) => p.torqueConnectionId && !flaggedIds.has(p.torqueConnectionId),
  )
  return {
    flangesAwaitingCpPoint: awaiting,
    orphanCpPoints: orphans,
    coveragePct: flagged.length ? ((flagged.length - awaiting.length) / flagged.length) * 100 : 100,
  }
}
