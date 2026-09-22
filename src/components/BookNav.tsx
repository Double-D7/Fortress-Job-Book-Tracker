'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/welds', label: 'Weld log' },
  { href: '/torque', label: 'Torque log' },
  { href: '/nde', label: 'NDE reports' },
  { href: '/materials', label: 'Materials & MTRs' },
  { href: '/personnel', label: 'Personnel & equipment' },
  { href: '/gates', label: 'Gates' },
  { href: '/audits', label: 'Audits' },
  { href: '/timeliness', label: 'Timeliness' },
  { href: '/flags', label: 'Flags' },
  { href: '/documents', label: 'Documents' },
  { href: '/export', label: 'Turnover' },
]

export function BookNav({ bookId }: { bookId: string }) {
  const pathname = usePathname()
  const base = `/books/${bookId}`
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-hairline pb-px">
      {TABS.map((t) => {
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
