import { notFound, redirect} from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { aggregateFindings, countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import { FlagQueue } from '@/components/FlagQueue'

export const dynamic = 'force-dynamic'

export default async function FlagsPage({
  params, searchParams,
}: {
  params: Promise<{ bookId: string }>
  searchParams: Promise<{ severity?: string }>
}) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params
  const { severity } = await searchParams
  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) notFound()

  const findings = aggregateFindings(evaluateFlags(b))
  return (
    <FlagQueue
      findings={findings}
      counts={countBySeverity(findings)}
      initialSeverity={severity === 'critical' || severity === 'warning' || severity === 'info' ? severity : 'all'}
    />
  )
}
