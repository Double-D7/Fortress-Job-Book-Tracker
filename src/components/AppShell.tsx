import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'
import { DEMO_VIEWER } from '@/lib/data/provider'

const ROLE_LABELS: Record<string, string> = {
  fortress_admin: 'Fortress Admin',
  qaqc_manager: 'QA/QC Manager',
  qaqc_tech: 'QA/QC Tech',
  fortress_read_only: 'Fortress Read-Only',
  client_user: 'Client User',
  third_party_inspector: 'Third-Party Inspector',
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const viewer = DEMO_VIEWER
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hairline bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand">
              <ShieldCheck size={16} className="text-brand-bright" />
            </span>
            <span className="text-sm font-semibold tracking-tight">
              Fortress <span className="text-ink-secondary font-normal">Job Book Tracker</span>
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-xs font-medium leading-tight">{viewer.fullName}</div>
              <div className="text-2xs leading-tight text-ink-muted">{ROLE_LABELS[viewer.role]}</div>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-raised text-2xs font-semibold text-ink-secondary">
              {viewer.fullName.split(' ').map((p) => p[0]).join('').slice(0, 2)}
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
