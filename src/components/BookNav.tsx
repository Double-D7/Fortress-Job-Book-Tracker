'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { can } from '@/lib/domain/roles'
import type { Capability } from '@/lib/domain/roles'
import type { UserRole } from '@/lib/domain/types'

/**
 * `needs` names the capability a tab requires, where it requires one.
 *
 * Hiding a tab is not access control — every page behind these redirects
 * or refuses on its own, and the database refuses under that. It is so a
 * client reading their operator's book is not offered six tabs of
 * Fortress's internal working material that would bounce them back here.
 */
const TABS: { href: string; label: string; needs?: Capability }[] = [
  { href: '', label: 'Overview' },
  { href: '/welds', label: 'Weld log' },
  { href: '/torque', label: 'Torque log' },
  { href: '/nde', label: 'NDE reports' },
  { href: '/materials', label: 'Materials & MTRs' },
  { href: '/personnel', label: 'Personnel & equipment' },
  { href: '/gates', label: 'Gates', needs: 'view_internal' },
  { href: '/audits', label: 'Audits', needs: 'view_internal' },
  { href: '/timeliness', label: 'Timeliness', needs: 'view_internal' },
  { href: '/flags', label: 'Flags', needs: 'view_internal' },
  { href: '/documents', label: 'Documents' },
  { href: '/notes', label: 'Notes' },
  { href: '/access', label: 'Access', needs: 'view_internal' },
  { href: '/export', label: 'Turnover', needs: 'export_package' },
]

export function BookNav({ bookId, role }: { bookId: string; role: UserRole }) {
  const pathname = usePathname()
  const base = `/books/${bookId}`
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-hairline pb-px">
      {TABS.filter((t) => !t.needs || can(role, t.needs)).map((t) => {
        const href = `${base}${t.href}`
        const active = t.href === '' ? pathname === base : pathname.startsWith(href)
        return (
          <Link
            key={t.href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors',
              active
                ? 'border-brand-bright bg-brand-bright/[0.08] text-ink'
                : 'border-transparent text-ink-secondary hover:bg-surface-raised hover:text-ink',
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
