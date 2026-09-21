import { notFound, redirect} from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { rollupByWelder, xrayTotals } from '@/lib/domain/welders'
import { weldCompleteness } from '@/lib/domain/completeness'
import { WeldGrid } from '@/components/WeldGrid'

export const dynamic = 'force-dynamic'

export default async function WeldLogPage({ params }: { params: Promise<{ bookId: string }> }) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params
  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) notFound()

  const welderById = new Map(b.welders.map((w) => [w.id, w]))
  const lineById = new Map(b.weldLines.map((l) => [l.id, l]))

  // Flattened for the client grid: the domain objects carry ids the grid
  // does not need, and shipping 2,342 full records with every relation
  // would dominate the payload.
  const rows = b.welds.map((w) => {
    const c = weldCompleteness(w)
    return {
      id: w.id,
      line: lineById.get(w.weldLineId)?.lineCode ?? '',
      workbook: lineById.get(w.weldLineId)?.workbook ?? '',
      weldNumber: w.weldNumber,
      weldDate: w.weldDate ?? null,
      welders: w.welderPassAssignment ?? null,
      jointType: w.jointType ?? null,
      component: w.componentDescription ?? null,
      heats: w.heatNumbers.join(' / '),
      cwi: w.cwiInitials ?? null,
      visual: w.cwiVisualResult ?? null,
      xray: w.xrayNumber ?? null,
      method: w.ndtMethod ?? null,
      ndtResult: w.ndtResult ?? null,
      linked: !!w.ndtReportId,
      status: w.status,
      complete: c.complete,
      missing: c.missing,
    }
  })

  const rollups = rollupByWelder(b.welds, b.welders, b.book).map((r) => ({
    ...r,
    fullName: welderById.get(r.welderId)?.fullName ?? r.fullName,
  }))
  const totals = xrayTotals(b.welds, b.book, b.welders)

  return (
    <WeldGrid
      rows={rows}
      rollups={rollups}
      totals={totals}
      lines={b.weldLines.map((l) => ({ code: l.lineCode, workbook: l.workbook ?? '' }))}
      requiredXrayPct={b.book.requiredXrayPct}
    />
  )
}
