'use client'

/**
 * The top-level destinations.
 *
 * Added because `/admin` and `/mtr` were reachable only by typing the
 * URL — complete screens with no path from a person to them, which is
 * the failure this codebase keeps producing in other forms.
 *
 * Capability-gated, so a client is not offered a Fortress tool. That is
 * courtesy rather than control: every page redirects on its own and the
 * database refuses under that.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { can } from '@/lib/domain/roles'
import type { Capability } from '@/lib/domain/roles'
import type { UserRole } from '@/lib/domain/types'

const LINKS: { href: string; label: string; needs?: Capability }[] = [
  { href: '/', label: 'Job books' },
  { href: '/mtr', label: 'Mill certificates', needs: 'view_internal' },
  { href: '/admin', label: 'Administration', needs: 'view_internal' },
]

export function MainNav({ role }: { role: UserRole }) {
  const pathname = usePathname()
  return (
    <nav className="hidden items-center gap-1 sm:flex">
      {LINKS.filter((l) => !l.needs || can(role, l.needs)).map((l) => {
        const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href)
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-surface-raised text-ink'
                : 'text-ink-secondary hover:bg-surface-raised hover:text-ink',
            )}
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
