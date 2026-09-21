'use client'

/**
 * Signing in.
 *
 * This page was a mockup: two buttons with no handlers and an email box
 * wired to nothing, so clicking "Sign in with Microsoft" did exactly what
 * it was built to do, which was nothing. The rule this breaks is the same
 * one the dead Upload button broke — a control that looks live and isn't
 * costs more than no control at all, because the person clicking it
 * concludes the system is broken rather than unbuilt.
 *
 * Both paths are real now, and both report what actually went wrong. A
 * provider that has not been configured in Supabase says so in those words
 * rather than failing silently.
 */
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, Check, Loader2, Mail, ShieldCheck } from 'lucide-react'
import { Button, Card, CardBody } from '@/components/ui/primitives'
import { createClient } from '@/lib/supabase/client'

export function LoginForm(
  { configured, microsoftEnabled }: { configured: boolean; microsoftEnabled: boolean },
) {
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<'microsoft' | 'email' | null>(null)
  const [sent, setSent] = useState(false)
  // Seeded from the callback route, which redirects here with a reason
  // when a link is expired or already used.
  const [error, setError] = useState<string | null>(params.get('error'))

  const next = params.get('next') ?? '/'
  const redirectTo = typeof window !== 'undefined'
    ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`
    : undefined

  /**
   * Microsoft sign-in.
   *
   * `signInWithOAuth` navigates the browser away immediately — it does not
   * wait to find out whether the provider exists. So when Azure is not
   * configured, Supabase answers the authorize URL with raw JSON
   * (`"Unsupported provider: provider is not enabled"`) and the person is
   * looking at it before any error handler here could run. There is no way
   * to catch that from this side.
   *
   * Which is why the button is not rendered at all unless the provider is
   * switched on. Handling the failure was never going to work; not
   * offering the door is the fix.
   */
  async function withMicrosoft() {
    const supabase = createClient()
    if (!supabase) return setError(NOT_CONFIGURED)
    setBusy('microsoft'); setError(null)

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: { redirectTo, scopes: 'email' },
    })
    if (error) {
      setBusy(null)
      setError(`Microsoft sign-in failed: ${error.message}`)
    }
  }

  async function withEmail(e: React.FormEvent) {
    e.preventDefault()
    const supabase = createClient()
    if (!supabase) return setError(NOT_CONFIGURED)
    setBusy('email'); setError(null)

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // Account creation is allowed here, and the allowlist is enforced a
      // layer down: a trigger on auth.users refuses an address with no
      // app_user invitation. Blocking creation from this screen instead
      // looked safer and was not — a first sign-in has to create the
      // account, so it locked out everyone including the admin who set the
      // system up.
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
    })
    setBusy(null)

    if (!error) return setSent(true)
    setError(
      // The database trigger raises this sentence verbatim; so does this
      // screen, so a person reads the same words whichever layer stopped
      // them.
      /not been invited|signups not allowed|not found/i.test(error.message)
        ? 'That address has not been invited to this system. Ask a Fortress admin to add you.'
        : /rate limit|too many|only request this after/i.test(error.message)
          ? 'Too many sign-in emails have gone out recently. Wait a minute and try again.'
          : /signups? (are )?(not allowed|disabled)/i.test(error.message)
            ? 'Sign-ups are switched off for this project. Turn "Allow new users to sign up" ' +
              'back on in Supabase — the invitation list is what restricts access, and it is ' +
              'enforced in the database.'
            : error.message,
    )
  }

  if (sent) {
    return (
      <Shell>
        <div className="space-y-3 text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-status-complete/15">
            <Check size={20} className="text-status-complete" />
          </span>
          <div className="text-sm font-medium text-ink">Check your email</div>
          <p className="text-2xs leading-relaxed text-ink-secondary">
            A sign-in link is on its way to <span className="text-ink">{email}</span>. It works
            once, within the hour.
          </p>
          <p className="text-2xs leading-relaxed text-ink-muted">
            Nothing after a minute or two? Check spam — until this project sends from a
            fortressds.com address, mail from it often lands there.
          </p>
          <Button variant="ghost" className="w-full" onClick={() => { setSent(false); setError(null) }}>
            Use a different address
          </Button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      {error && (
        <p className="flex items-start gap-2 rounded-md bg-status-critical/10 p-2.5 text-2xs leading-relaxed text-status-critical">
          <AlertTriangle size={13} className="mt-px shrink-0" />{error}
        </p>
      )}

      {!configured && (
        <p className="rounded-md bg-status-info/10 p-2.5 text-2xs leading-relaxed text-status-info">
          This instance is running the in-memory demo book. There is no database and nothing to
          sign in to — every screen is already reachable.
        </p>
      )}

      {microsoftEnabled && (
        <>
          <div className="space-y-2">
            <Button
              variant="primary" className="w-full py-2"
              onClick={() => void withMicrosoft()}
              disabled={busy !== null || !configured}
            >
              {busy === 'microsoft'
                ? <><Loader2 size={14} className="animate-spin" /> Redirecting…</>
                : 'Sign in with Microsoft'}
            </Button>
            <p className="text-center text-2xs text-ink-muted">
              Fortress staff sign in with their Microsoft 365 account.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-hairline" />
            <span className="text-2xs text-ink-muted">or by email</span>
            <span className="h-px flex-1 bg-hairline" />
          </div>
        </>
      )}

      <form className="space-y-2" onSubmit={(e) => void withEmail(e)}>
        <input
          type="email" required value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@fortressds.com"
          aria-label="Email address"
          autoComplete="email"
          className="w-full rounded-md border border-hairline bg-surface-raised px-3 py-2 text-xs text-ink placeholder:text-ink-muted"
        />
        <Button
          type="submit" variant="secondary" className="w-full py-2"
          disabled={busy !== null || !email.trim() || !configured}
        >
          {busy === 'email'
            ? <><Loader2 size={14} className="animate-spin" /> Sending…</>
            : <><Mail size={13} /> Email me a sign-in link</>}
        </Button>
        <p className="text-center text-2xs leading-relaxed text-ink-muted">
          Client and inspector access is scoped to specific job books and, for inspectors,
          time-limited. Every document view is logged.
        </p>
      </form>
    </Shell>
  )
}

const NOT_CONFIGURED =
  'This instance has no database configured, so there is nothing to sign in to.'

function Shell({ children }: { children: React.ReactNode }) {
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
          {children}
        </CardBody>
      </Card>
    </div>
  )
}
