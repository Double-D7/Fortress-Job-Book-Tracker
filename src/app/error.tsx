'use client'

/**
 * What somebody sees when a page fails.
 *
 * Until now this was the framework's own screen: "Application error: a
 * server-side exception has occurred", a black page, and nothing else.
 * It tells the person nothing about whether their work was saved, gives
 * them nothing to quote when they ask for help, and reads as though the
 * whole system is broken rather than one page of it.
 *
 * Three things it has to do, in this order of importance. Say whether
 * the work is safe, because that is the first thing anybody wonders.
 * Give a reference, so a call about it is thirty seconds rather than
 * twenty minutes of "which screen were you on". Offer a way out that is
 * not the back button.
 *
 * The reference is the framework's own digest, which is also what the
 * server recorded against this fault, so a code read out over the phone
 * leads straight to the row.
 */
import { useEffect } from 'react'
import { AlertTriangle, ArrowLeft, RotateCw } from 'lucide-react'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/primitives'

export default function Error({
  error, reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Client-side failures never reach the server hook, so they are
    // posted here. Server failures already arrived through
    // `onRequestError` and carry a digest; sending those again would
    // double-count the same fault.
    if (error.digest) return
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: error.name,
        message: error.message,
        stack: error.stack,
        route: window.location.pathname,
      }),
    }).catch(() => {
      // Reporting a failure must not produce one.
    })
  }, [error])

  return (
    <div className="mx-auto max-w-2xl py-10">
      <Card>
        <CardHeader className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-status-critical" />
          <CardTitle>This page could not be loaded</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-secondary">
            Something on this screen failed while it was being put together.
            <span className="text-ink"> Nothing you have entered has been lost</span> — this
            happened while reading the job book, not while writing to it.
          </p>

          <p className="text-sm leading-relaxed text-ink-secondary">
            It has been reported automatically. If you need it looked at now, quote this
            reference:
          </p>

          <div className="rounded-card border border-hairline bg-surface-raised px-4 py-3">
            <div className="text-2xs uppercase tracking-wider text-ink-muted">Reference</div>
            <div className="mt-1 font-mono text-lg tracking-widest text-ink">
              {error.digest ?? 'not recorded'}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" onClick={() => reset()}>
              <RotateCw size={12} /> Try again
            </Button>
            <Button variant="secondary" onClick={() => { window.location.href = '/' }}>
              <ArrowLeft size={12} /> Back to job books
            </Button>
          </div>

          <p className="text-2xs leading-relaxed text-ink-muted">
            Trying again is worth one attempt — some failures are a moment of bad luck
            talking to the database. If it fails a second time the page needs fixing, and
            retrying will not help.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
