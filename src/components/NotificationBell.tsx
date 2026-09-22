/**
 * The unread marker in the header.
 *
 * Counts what interrupts — Critical and Needs-attention — and not
 * observations. A badge that counts everything is a badge people stop
 * looking at, and then the Critical one is missed too, which is the
 * failure this whole feature exists to prevent.
 *
 * A server component: the count is read on each render under the
 * viewer's own session, so there is no polling and no client-side copy
 * of "what am I allowed to see".
 */
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { badgeCount } from '@/lib/domain/notifications'

export async function NotificationBell() {
  const viewer = await currentViewer()
  if (!viewer) return null

  const unread = await getDataProvider()
    .listNotifications(viewer, { unreadOnly: true, limit: 100 })
  const count = badgeCount(unread)

  // No bell at all for somebody who can never receive one — every
  // external role, and View Only. An empty bell invites a click that
  // leads nowhere and suggests the feature is broken.
  if (unread.length === 0 && count === 0) {
    return (
      <Link
        href="/notifications"
        aria-label="Notifications"
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
      >
        <Bell size={15} />
      </Link>
    )
  }

  return (
    <Link
      href="/notifications"
      aria-label={
        count > 0
          ? `Notifications, ${count} needing attention`
          : `Notifications, ${unread.length} unread`
      }
      className="relative flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-raised hover:text-ink"
    >
      <Bell size={15} />
      {count > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-critical px-1 text-[10px] font-semibold leading-none text-canvas">
          {count > 9 ? '9+' : count}
        </span>
      ) : (
        // Unread observations: a dot, not a number. Present without
        // demanding anything.
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-ink-muted" />
      )}
    </Link>
  )
}
