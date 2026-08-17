'use client'

/**
 * Torque connection grid.
 *
 * The wrench-calibration verdict is a column, not a separate report: the
 * question "was this wrench certified on the day this flange was torqued?"
 * is the one an auditor asks per row, and answering it inline is the whole
 * point of holding torque records as data rather than as a PDF.
 */
import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Card, CardBody, CardHeader, CardTitle, Chip, EmptyState } from '@/components/ui/primitives'
import { cn, num } from '@/lib/utils'

export interface TorqueRow {
  id: string
  flange: string
  iso: string
  size: string
  bolts: number | null
  required: number | null
  actual: number | null
  wrench: string
  wrenchVerdict: string
  cpTest: boolean
  torqueDate: string | null
  employee: string
  inspectionDate: string | null
  inspector: string
  complete: boolean
}

const ROW_HEIGHT = 33
const COLS = 'grid-cols-[92px_78px_58px_54px_78px_72px_74px_150px_54px_96px_66px_96px_66px]'

export function TorqueGrid({
  rows, verdictLabels,
}: {
  rows: TorqueRow[]
  verdictLabels: Record<string, { label: string; tone: 'complete' | 'critical' | 'progress' }>
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'uninspected' | 'wrench_issue' | 'cp'>('all')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'uninspected' && r.inspectionDate) return false
      if (filter === 'wrench_issue' && r.wrenchVerdict === 'valid') return false
      if (filter === 'cp' && !r.cpTest) return false
      if (!q) return true
      return (
        r.flange.toLowerCase().includes(q) ||
        r.iso.toLowerCase().includes(q) ||
        r.wrench.toLowerCase().includes(q)
      )
    })
  }, [rows, query, filter])

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 18,
  })

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="mr-auto">Detailed torque log</CardTitle>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          aria-label="Filter connections"
          className="rounded-md border border-hairline bg-surface-raised px-2 py-1 text-xs text-ink"
        >
          <option value="all">All connections</option>
          <option value="uninspected">Not inspected</option>
          <option value="wrench_issue">Wrench calibration issue</option>
          <option value="cp">CP test = Y</option>
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search flange, ISO, wrench…"
          aria-label="Search connections"
          className="w-52 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-xs text-ink placeholder:text-ink-muted"
        />
      </CardHeader>
      <CardBody className="p-0">
        <div className="border-b border-hairline px-5 py-2 text-2xs text-ink-muted">
          Showing {num(filtered.length)} of {num(rows.length)} connections
        </div>
        {filtered.length === 0 ? (
          <div className="p-5"><EmptyState title="No connections match these filters" /></div>
        ) : (
          <div className="w-full overflow-x-auto">
            <div className="min-w-[1180px]">
              <div className={cn('grid gap-x-2 border-b border-hairline bg-surface px-5 py-2',
                'text-2xs font-medium uppercase tracking-wide text-ink-muted', COLS)}>
                <span>Flange</span><span>ISO</span><span>Size</span><span>Bolts</span>
                <span className="text-right">Req ft-lb</span><span className="text-right">Act ft-lb</span>
                <span>Wrench</span><span>Calibration verdict</span><span>CP</span>
                <span>Torqued</span><span>By</span><span>Inspected</span><span>Inspector</span>
              </div>
              <div ref={parentRef} className="h-[520px] overflow-y-auto">
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((v) => {
                    const r = filtered[v.index]!
                    const verdict = verdictLabels[r.wrenchVerdict]
                    return (
                      <div
                        key={r.id}
                        className={cn('absolute left-0 top-0 grid w-full items-center gap-x-2 border-b',
                          'border-hairline/50 px-5 text-xs transition-colors hover:bg-brand-bright/[0.06]', COLS)}
                        style={{ height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
                      >
                        <span className="truncate font-mono font-medium">{r.flange}</span>
                        <span className="truncate font-mono text-ink-secondary">{r.iso || '—'}</span>
                        <span className="truncate text-ink-secondary">{r.size || '—'}</span>
                        <span className="tnum truncate font-mono text-ink-secondary">{r.bolts ?? '—'}</span>
                        <span className="tnum truncate text-right font-mono text-ink-secondary">{r.required ?? '—'}</span>
                        <span className="tnum truncate text-right font-mono">{r.actual ?? '—'}</span>
                        <span className="truncate font-mono">{r.wrench || '—'}</span>
                        <span className="truncate">
                          {verdict
                            ? <Chip tone={verdict.tone}>{verdict.label}</Chip>
                            : <span className="text-ink-muted">—</span>}
                        </span>
                        <span>{r.cpTest ? <Chip tone="info">Y</Chip> : <span className="text-ink-muted">N</span>}</span>
                        <span className="tnum truncate font-mono text-ink-secondary">{r.torqueDate ?? '—'}</span>
                        <span className="truncate font-mono text-ink-secondary">{r.employee || '—'}</span>
                        <span className="tnum truncate font-mono text-ink-secondary">{r.inspectionDate ?? '—'}</span>
                        <span className="truncate font-mono text-ink-secondary">{r.inspector || '—'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
