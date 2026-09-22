import { redirect } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import {
  SEVERITY_LABELS, badgeCount, interrupts, type NoteSeverity,
} from '@/lib/domain/notifications'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, SectionHeading,
} from '@/components/ui/primitives'
import { MarkAllRead } from '@/components/MarkAllRead'

export const dynamic = 'force-dynamic'

const TONE: Record<NoteSeverity, 'critical' | 'progress' | 'idle'> = {
  critical: 'critical', warning: 'progress', info: 'idle',
}

export default async function NotificationsPage() {
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')

  const items = await getDataProvider().listNotifications(viewer, { limit: 100 })
  const unread = items.filter((n) => !n.readAt)
  const needing = badgeCount(unread)

  return (
    <>
      <SectionHeading
        title="Notifications"
        subtitle={
          needing > 0
            ? `${needing} note${needing === 1 ? '' : 's'} on your books needs attention`
            : unread.length > 0
              ? `${unread.length} unread, none urgent`
              : 'Nothing unread'
        }
      />
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Notes on your books</CardTitle>
          {unread.length > 0 && <MarkAllRead />}
        </CardHeader>
        <CardBody className="space-y-3">
          {items.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              detail="You are told about every note on a book you are Custodian of, and about anything urgent on a book you are assigned to. Observations reach the Custodian and the daily digest, and interrupt nobody."
            />
          ) : (
            <ol className="space-y-2">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={
                    'rounded-md border px-3 py-2 ' +
                    (n.readAt
                      ? 'border-hairline opacity-60'
                      : 'border-brand-bright/30 bg-brand-bright/[0.04]')
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {interrupts(n.severity) && (
                      <Chip tone={TONE[n.severity]} icon={<AlertTriangle size={11} />}>
                        {SEVERITY_LABELS[n.severity]}
                      </Chip>
                    )}
                    <Link
                      href={`/books/${n.jobBookId}/notes`}
                      className="text-xs font-medium text-ink hover:underline"
                    >
                      {n.jobNumber}
                    </Link>
                    {n.sectionNumber && <Chip tone="idle">§{n.sectionNumber}</Chip>}
                    <span className="text-2xs text-ink-secondary">{n.authorName}</span>
                    <span className="tnum ml-auto text-2xs text-ink-muted">
                      {n.createdAt.slice(0, 16).replace('T', ' ')}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary">
                    {n.body}
                  </p>
                </li>
              ))}
            </ol>
          )}

          <p className="border-t border-hairline pt-3 text-2xs leading-relaxed text-ink-secondary">
            These are yours alone — nobody else can read your list, including an Admin. A note
            marked urgent by a Client Inspector asks Fortress to look now; it does not raise a
            §11 finding or change the book&rsquo;s score, which stays a Fortress decision.
          </p>
        </CardBody>
      </Card>
    </>
  )
}
