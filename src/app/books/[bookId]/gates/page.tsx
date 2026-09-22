import { notFound, redirect } from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { evaluateAllGates } from '@/lib/domain/gates'
import { GateReviews } from '@/components/GateReviews'
import { EmptyState } from '@/components/ui/primitives'

export const dynamic = 'force-dynamic'

export default async function GatesPage({
  params,
}: {
  params: Promise<{ bookId: string }>
}) {
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params

  const provider = getDataProvider()
  const bundle = await provider.getBundle(viewer, bookId)
  if (!bundle) notFound()

  // Gate reviews are Fortress-internal governance. A client sees the book;
  // they do not see the minutes of the meeting where Fortress decided
  // whether to let it advance. RLS says the same thing in the database.
  const FORTRESS = new Set(['fortress_admin', 'qaqc_manager', 'qaqc_tech', 'fortress_read_only'])
  if (!FORTRESS.has(viewer.role)) {
    return (
      <EmptyState
        title="Not visible on this account"
        detail="Gate reviews are Fortress's internal record of whether a book may advance."
      />
    )
  }

  const [side, reviews, staff] = await Promise.all([
    provider.gateContext(viewer, bookId),
    provider.listGateReviews(viewer, bookId),
    provider.listStaff(viewer),
  ])

  const evaluations = evaluateAllGates(bundle, {
    custodianName: side.custodianName,
    custodianCompetency: side.custodianCompetency,
  })

  return (
    <GateReviews
      bookId={bookId}
      evaluations={evaluations}
      reviews={reviews}
      custodianName={side.custodianName}
      custodianCompetency={side.custodianCompetency}
      staff={staff}
      // §7 chairs the review with the QA/QC Manager. A tech sees the
      // criteria — which is the point of a progressive book — but cannot
      // take the decision, and the database refuses them either way.
      canChair={viewer.role === 'qaqc_manager' || viewer.role === 'fortress_admin'}
    />
  )
}
