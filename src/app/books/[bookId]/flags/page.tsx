import { notFound } from 'next/navigation'
import { DEMO_VIEWER, getDataProvider } from '@/lib/data/provider'
import { aggregateFindings, countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import { FlagQueue } from '@/components/FlagQueue'

export const dynamic = 'force-dynamic'

export default async function FlagsPage({
  params, searchParams,
}: {
  params: Promise<{ bookId: string }>
  searchParams: Promise<{ severity?: string }>
}) {
  const { bookId } = await params
  const { severity } = await searchParams
  const b = await getDataProvider().getBundle(DEMO_VIEWER, bookId)
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
