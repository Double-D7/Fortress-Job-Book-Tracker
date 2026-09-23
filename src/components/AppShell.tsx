import Link from 'next/link'
import { currentViewer } from '@/lib/data/provider'
import { BrandMark } from '@/components/BrandMark'
import { roleLabel } from '@/lib/domain/roles'
import { NotificationBell } from '@/components/NotificationBell'
import { MainNav } from '@/components/MainNav'

export async function AppShell({ children }: { children: React.ReactNode }) {
  // Null only on a page that is itself public; the middleware redirects
  // everything else before it gets here.
  const viewer = await currentViewer()
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hairline bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark size={32} />
            <span className="text-sm font-semibold tracking-tight">
              Fortress <span className="text-ink-secondary font-normal">Job Book Tracker</span>
            </span>
          </Link>
          {viewer && <MainNav role={viewer.role} />}
          <div className="ml-auto flex items-center gap-3">
            {viewer && <>
              <NotificationBell />
              <div className="hidden text-right sm:block">
                <div className="text-xs font-medium leading-tight">{viewer.fullName}</div>
                {/* The capability table's label, not a fourth hand-written
                    copy of the role names. */}
                <div className="text-2xs leading-tight text-ink-muted">{roleLabel(viewer.role)}</div>
              </div>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-raised text-2xs font-semibold text-ink-secondary">
                {viewer.fullName.split(' ').map((p) => p[0]).join('').slice(0, 2)}
              </div>
            </>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
