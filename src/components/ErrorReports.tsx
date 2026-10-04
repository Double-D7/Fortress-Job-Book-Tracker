'use client'

/**
 * Failures the application has recorded.
 *
 * The point of this screen is to be empty. An empty table is the
 * system saying nothing has broken, which is information somebody can
 * act on; before it existed, the same silence meant only that nobody
 * had been told.
 *
 * One row per fault, not per occurrence. A page broken all morning is a
 * single line reading 240, because a list of 240 identical rows is read
 * exactly as often as no list at all.
 *
 * The reference is the first column on purpose. It is what a person on
 * site reads out, and matching their call to a row is the whole job of
 * this screen.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, CheckCircle2, Loader2 } from 'lucide-react'
import type { ErrorReportRow } from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export function ErrorReports({
  reports, canResolve,
}: {
  reports: ErrorReportRow[]
  canResolve: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = reports.filter((r) => !r.resolvedAt)
  const closed = reports.filter((r) => r.resolvedAt)

  async function resolve(id: string) {
    setBusy(id); setError(null)
    try {
      const res = await fetch(`/api/error-reports/${id}`, { method: 'POST' })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!json.ok) setError(json.error ?? 'That did not work.')
      else router.refresh()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Application errors</CardTitle>
        <span className="text-2xs text-ink-muted">
          {open.length === 0
            ? 'Nothing has failed'
            : `${open.length} open · one row per fault, not per occurrence`}
        </span>
      </CardHeader>

      <CardBody className="p-0">
        {reports.length === 0 ? (
          <div className="flex items-center gap-2 px-5 py-6 text-xs text-ink-secondary">
            <CheckCircle2 size={14} className="text-status-complete" />
            No failures recorded. This table being empty is the system saying so, rather
            than nobody having reported one.
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Reference</Th>
                <Th>What failed</Th>
                <Th>Where</Th>
                <Th className="text-right">Times</Th>
                <Th>Last seen</Th>
                {canResolve && <Th className="w-20" />}
              </tr>
            </thead>
            <tbody>
              {[...open, ...closed].map((r) => (
                <Tr key={r.id} className={r.resolvedAt ? 'opacity-50' : undefined}>
                  <Td className="font-mono tracking-widest text-ink">{r.reference}</Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      {!r.resolvedAt && (
                        <AlertTriangle size={11} className="shrink-0 text-status-critical" />
                      )}
                      <span className="font-medium text-ink">{r.errorName}</span>
                    </div>
                    <div className="mt-0.5 max-w-xl truncate text-2xs text-ink-secondary">
                      {r.message}
                    </div>
                  </Td>
                  <Td className="font-mono text-2xs text-ink-secondary">{r.route ?? '—'}</Td>
                  <Td className="tnum text-right font-mono">{r.occurrences}</Td>
                  <Td className="text-2xs text-ink-secondary">{when(r.lastSeenAt)}</Td>
                  {canResolve && (
                    <Td className="text-right">
                      {r.resolvedAt
                        ? <Chip tone="complete">Closed</Chip>
                        : (
                          <Button
                            variant="ghost"
                            disabled={busy === r.id}
                            onClick={() => void resolve(r.id)}
                          >
                            {busy === r.id
                              ? <Loader2 size={12} className="animate-spin" />
                              : <Check size={12} />}
                            Close
                          </Button>
                        )}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {error && <p className="px-5 py-2 text-2xs text-status-critical">{error}</p>}
      </CardBody>

      {reports.length > 0 && (
        <CardBody className="border-t border-hairline">
          <p className="text-2xs leading-relaxed text-ink-muted">
            Closing a fault records that it was dealt with. It reopens by itself if it
            happens again, so a bug that comes back cannot sit closed and unnoticed.
          </p>
        </CardBody>
      )}
    </Card>
  )
}
