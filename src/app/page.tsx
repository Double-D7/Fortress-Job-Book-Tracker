/**
 * Portfolio dashboard — every job book the viewer may see.
 *
 * A client user's list is produced by the same query as a Fortress user's;
 * the difference is enforced by RLS, so there is no branch here that could
 * be got wrong.
 */
import Link from 'next/link'
import { AlertTriangle, CalendarClock } from 'lucide-react'
import { DEMO_VIEWER, getDataProvider } from '@/lib/data/provider'
import { Card, Chip, EmptyState, ProgressBar, Ring, SectionHeading, bandTone } from '@/components/ui/primitives'
import { num } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  setup: 'Setup',
  in_progress: 'In progress',
  ready_for_review: 'Ready for review',
  submitted: 'Submitted',
  accepted: 'Accepted',
  archived: 'Archived',
}

export default async function PortfolioPage() {
  const books = await getDataProvider().listJobBooks(DEMO_VIEWER)

  return (
    <>
      <SectionHeading
        title="Job books"
        subtitle={`${books.length} book${books.length === 1 ? '' : 's'} visible to you`}
      />

      {books.length === 0 ? (
        <EmptyState
          title="No job books"
          detail="You have no job books assigned. A QA/QC manager can assign you to one."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {books.map((b) => (
            <Link key={b.id} href={`/books/${b.id}`} className="group">
              <Card className="h-full p-5 transition-colors group-hover:border-brand-bright/40">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold tracking-tight">{b.jobNumber}</div>
                    <div className="mt-0.5 truncate text-xs text-ink-secondary">{b.facilityName}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Chip tone="brand">{b.clientOrgName}</Chip>
                      <Chip tone="idle">{b.bookType === 'flowline' ? 'Flowline' : 'Facility'}</Chip>
                      <Chip tone="info">{STATUS_LABELS[b.status] ?? b.status}</Chip>
                    </div>
                  </div>
                  <Ring value={b.overallPct} size={82} stroke={8} />
                </div>

                <div className="mt-4">
                  <ProgressBar value={b.overallPct} tone={bandTone(b.overallPct)} />
                </div>

                <div className="mt-3 flex items-center justify-between text-2xs">
                  <span className="inline-flex items-center gap-1.5 text-status-critical">
                    <AlertTriangle size={12} />
                    {num(b.criticalFlags)} critical
                  </span>
                  {b.daysToTurnover !== null && (
                    <span className="inline-flex items-center gap-1.5 text-ink-muted">
                      <CalendarClock size={12} />
                      {b.daysToTurnover < 0
                        ? `${num(Math.abs(b.daysToTurnover))} days past target`
                        : `${num(b.daysToTurnover)} days to turnover`}
                    </span>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
