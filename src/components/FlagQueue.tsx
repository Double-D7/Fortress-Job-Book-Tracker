'use client'

/**
 * The flag queue.
 *
 * Findings are grouped by rule rather than listed flat: a single systemic
 * problem — 278 future-dated connections, say — is one decision for a
 * manager, not 278. The individual records stay reachable underneath, since
 * resolving the group still requires looking at what is in it.
 *
 * Resolution requires a note. That is enforced by a database constraint as
 * well as by this form; auditors ask why a flag was closed, and "someone
 * clicked resolve" is not an answer.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, Info, TriangleAlert } from 'lucide-react'
import type { AggregatedFinding } from '@/lib/domain/flags'
import type { FlagSeverity } from '@/lib/domain/types'
import { Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState } from '@/components/ui/primitives'
import { cn, num } from '@/lib/utils'

const SEVERITY_META: Record<FlagSeverity, { tone: 'critical' | 'progress' | 'info'; icon: React.ReactNode; label: string }> = {
  critical: { tone: 'critical', icon: <AlertTriangle size={12} />, label: 'Critical' },
  warning: { tone: 'progress', icon: <TriangleAlert size={12} />, label: 'Warning' },
  info: { tone: 'info', icon: <Info size={12} />, label: 'Info' },
}

export function FlagQueue({
  findings, counts, initialSeverity,
}: {
  findings: AggregatedFinding[]
  counts: { critical: number; warning: number; info: number; total: number; totalRecords: number }
  initialSeverity: FlagSeverity | 'all'
}) {
  const [severity, setSeverity] = useState<FlagSeverity | 'all'>(initialSeverity)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Findings arrive already aggregated by rule from the domain, so the
  // queue shows one row per problem rather than one per record.
  const groups = useMemo(
    () => findings.filter((f) => severity === 'all' || f.severity === severity),
    [findings, severity],
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'critical', 'warning', 'info'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSeverity(s)}
            aria-pressed={severity === s}
            className={cn(
              'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
              severity === s
                ? 'border-brand-bright/50 bg-brand-bright/[0.12] text-ink'
                : 'border-hairline bg-surface text-ink-secondary hover:bg-surface-raised',
            )}
          >
            {s === 'all' ? 'All' : SEVERITY_META[s].label}
            <span className="tnum ml-1.5 text-ink-muted">
              {num(s === 'all' ? counts.total : counts[s])}
            </span>
          </button>
        ))}
        <span className="ml-auto text-2xs text-ink-muted">
          {num(counts.total)} finding{counts.total === 1 ? '' : 's'} across{' '}
          {num(counts.totalRecords)} record{counts.totalRecords === 1 ? '' : 's'}
        </span>
      </div>

      {groups.length === 0 ? (
        <EmptyState title="No open flags at this severity" />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const meta = SEVERITY_META[g.severity]
            const open = expanded === g.ruleId
            return (
              <Card key={g.ruleId}>
                <CardHeader className="flex flex-wrap items-center gap-2">
                  <Chip tone={meta.tone} icon={meta.icon}>{meta.label}</Chip>
                  <CardTitle className="mr-auto">{g.title}</CardTitle>
                  {g.sectionNumber && <Chip tone="idle">Section {g.sectionNumber}</Chip>}
                  {g.occurrences > 1 && (
                    <span className="tnum text-xs text-ink-muted">
                      {num(g.occurrences)} records
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => setExpanded(open ? null : g.ruleId)}
                    aria-expanded={open}
                    disabled={g.occurrences === 1}
                  >
                    <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
                    {open ? 'Hide' : g.occurrences === 1 ? '' : 'Show records'}
                  </Button>
                </CardHeader>
                <CardBody className="space-y-3">
                  <p className="text-xs leading-relaxed text-ink-secondary">{g.detail}</p>
                  <p className="font-mono text-2xs text-ink-muted">{g.ruleId}</p>

                  {open && (
                    <>
                      <ul className="max-h-96 divide-y divide-hairline/60 overflow-y-auto rounded-md border border-hairline">
                        {g.records.map((f) => (
                          <li key={f.fingerprint} className="px-3 py-2">
                            <div className="text-xs text-ink">{f.title}</div>
                            <div className="mt-0.5 text-2xs leading-relaxed text-ink-muted">{f.detail}</div>
                            {f.entityType && (
                              <div className="mt-1 font-mono text-2xs text-ink-muted">
                                {f.entityType}
                                {f.entityId ? ` · ${f.entityId}` : ''}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                      {g.recordsTruncated && (
                        <p className="text-2xs text-ink-muted">
                          Showing {num(g.records.length)} of {num(g.occurrences)} records. Filter the
                          record grid to this condition for the rest.
                        </p>
                      )}
                    </>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <input
                      placeholder="Resolution note (required)"
                      aria-label={`Resolution note for ${g.ruleId}`}
                      className="min-w-0 flex-1 rounded-md border border-hairline bg-surface-raised px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-muted"
                    />
                    <Button variant="secondary">Assign</Button>
                    <Button variant="primary">Resolve</Button>
                  </div>
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
