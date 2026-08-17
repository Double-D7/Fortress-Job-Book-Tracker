import { ShieldCheck } from 'lucide-react'
import { Button, Card, CardBody } from '@/components/ui/primitives'

export default function LoginPage() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardBody className="space-y-5 p-7">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand">
              <ShieldCheck size={19} className="text-brand-bright" />
            </span>
            <div>
              <div className="text-sm font-semibold tracking-tight">Fortress</div>
              <div className="text-2xs text-ink-muted">Job Book Tracker</div>
            </div>
          </div>

          <div className="space-y-2">
            <Button variant="primary" className="w-full py-2">
              Sign in with Microsoft
            </Button>
            <p className="text-center text-2xs text-ink-muted">
              Fortress staff sign in with their Microsoft 365 account.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-hairline" />
            <span className="text-2xs text-ink-muted">external users</span>
            <span className="h-px flex-1 bg-hairline" />
          </div>

          <div className="space-y-2">
            <input
              type="email"
              placeholder="you@company.com"
              aria-label="Email address"
              className="w-full rounded-md border border-hairline bg-surface-raised px-3 py-2 text-xs text-ink placeholder:text-ink-muted"
            />
            <Button variant="secondary" className="w-full py-2">Email me a sign-in link</Button>
            <p className="text-center text-2xs leading-relaxed text-ink-muted">
              Client and inspector access is scoped to specific job books and, for inspectors,
              time-limited. Every document view is logged.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
