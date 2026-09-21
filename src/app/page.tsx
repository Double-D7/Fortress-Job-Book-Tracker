/**
 * Portfolio dashboard — every job book the viewer may see.
 *
 * A client user's list is produced by the same query as a Fortress user's;
 * the difference is enforced by RLS, so there is no branch here that could
 * be got wrong.
 */
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, CalendarClock, Plus } from 'lucide-react'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import {
  Button, Card, Chip, EmptyState, ProgressBar, Ring, SectionHeading, bandTone,
} from '@/components/ui/primitives'
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
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const books = await getDataProvider().listJobBooks(viewer)

  return (
    <>
      <SectionHeading
        title="Job books"
        subtitle={`${books.length} book${books.length === 1 ? '' : 's'} visible to you`}
        actions={
          <Link href="/books/new">
            <Button variant="primary"><Plus size={13} /> New job book</Button>
          </Link>
        }
      />

      {books.length === 0 ? (
        <EmptyState
          title="No job books"
          detail="Create one from the checklist template, or ask a QA/QC manager to assign you to an existing book."
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

                <div className="mt-3 flex items-center justify-between gap-2 text-2xs">
                  <span className={`inline-flex items-center gap-1.5 ${
                    b.criticalFlags ? 'text-status-critical' : 'text-ink-muted'}`}>
                    <AlertTriangle size={12} />
                    {num(b.criticalFlags)} critical
                    {b.criticalRecords > b.criticalFlags && (
                      <span className="text-ink-muted">
                        ({num(b.criticalRecords)} records)
                      </span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-ink-muted">
                    <CalendarClock size={12} />
                    {b.turnoverState === 'delivered' ? 'Delivered'
                      : b.turnoverState === 'no_target' ? 'No target set'
                      : b.daysToTurnover! < 0
                        ? `${num(Math.abs(b.daysToTurnover!))} days past target`
                        : `${num(b.daysToTurnover!)} days to turnover`}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
