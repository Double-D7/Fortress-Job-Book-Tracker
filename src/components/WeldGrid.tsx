'use client'

/**
 * The weld log — the heaviest screen in the application.
 *
 * Rows are virtualized because a book carries thousands of joints and the
 * brief requires 5,000+ without lag: only the visible window is in the DOM,
 * so filtering 2,342 rows stays instant.
 *
 * The per-welder rollup above the grid is the most-audited number in the
 * book, so it is shown on the same screen as the data it summarizes rather
 * than on a separate report — a manager can see a percentage and the rows
 * behind it without navigating.
 */
import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertCircle, Check } from 'lucide-react'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { cn, num, pct } from '@/lib/utils'

export interface WeldRow {
  id: string
  line: string
  workbook: string
  weldNumber: string
  weldDate: string | null
  welders: string | null
  jointType: string | null
  component: string | null
  heats: string
  cwi: string | null
  visual: string | null
  xray: string | null
  method: string | null
  ndtResult: string | null
  linked: boolean
  status: string
  complete: boolean
  missing: string[]
}

export interface Rollup {
  welderId: string
  initials: string
  fullName: string
  totalWelds: number
  totalXrays: number
  xrayPct: number
  cwiPass: number
  cwiFail: number
  pctInspected: number
  ndtPass: number
  ndtFail: number
  meetsRequirement: boolean
}

const ROW_HEIGHT = 33

export function WeldGrid({
  rows, rollups, totals, lines, requiredXrayPct,
}: {
  rows: WeldRow[]
  rollups: Rollup[]
  totals: { totalWeldCredits: number; totalXrayCredits: number; xrayPct: number; jointCount: number; creditOverstatementPct: number }
  lines: { code: string; workbook: string }[]
  requiredXrayPct: number
}) {
  const [line, setLine] = useState<string>('')
  const [query, setQuery] = useState('')
  const [incompleteOnly, setIncompleteOnly] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (line && r.line !== line) return false
      if (incompleteOnly && (r.complete || r.status === 'not_used')) return false
      if (!q) return true
      return (
        r.weldNumber.toLowerCase().includes(q) ||
        r.line.toLowerCase().includes(q) ||
        (r.welders ?? '').toLowerCase().includes(q) ||
        r.heats.toLowerCase().includes(q) ||
        (r.component ?? '').toLowerCase().includes(q) ||
        (r.xray ?? '').toLowerCase().includes(q)
      )
    })
  }, [rows, line, query, incompleteOnly])

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 18,
  })

  const incompleteCount = rows.filter((r) => !r.complete && r.status !== 'not_used').length

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Welder rollup — inspection percentages</CardTitle>
          <span className="text-2xs text-ink-muted">
            Welder-credit basis: a split-pass joint is credited to every welder on it
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Welder</Th>
                <Th className="text-right">Welds</Th>
                <Th className="text-right">X-rays</Th>
                <Th className="text-right">% X-ray</Th>
                <Th className="text-right">CWI pass</Th>
                <Th className="text-right">CWI fail</Th>
                <Th className="text-right">% inspected</Th>
                <Th className="text-right">NDT pass</Th>
                <Th className="text-right">NDT fail</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rollups.map((r) => (
                <Tr key={r.welderId}>
                  <Td>
                    <span className="font-mono text-xs font-medium">{r.initials}</span>
                    <span className="ml-2 text-ink-secondary">{r.fullName}</span>
                  </Td>
                  <Td className="tnum text-right font-mono">{num(r.totalWelds)}</Td>
                  <Td className="tnum text-right font-mono">{num(r.totalXrays)}</Td>
                  <Td className={cn('tnum text-right font-mono font-medium',
                    r.meetsRequirement ? 'text-status-complete' : 'text-status-critical')}>
                    {pct(r.xrayPct)}
                  </Td>
                  <Td className="tnum text-right font-mono text-ink-secondary">{num(r.cwiPass)}</Td>
                  <Td className="tnum text-right font-mono text-ink-secondary">{num(r.cwiFail)}</Td>
                  <Td className="tnum text-right font-mono text-ink-secondary">{pct(r.pctInspected)}</Td>
                  <Td className="tnum text-right font-mono text-ink-secondary">{num(r.ndtPass)}</Td>
                  <Td className="tnum text-right font-mono text-ink-secondary">{num(r.ndtFail)}</Td>
                  <Td>
                    {r.meetsRequirement
                      ? <Chip tone="complete" icon={<Check size={11} />}>Meets {requiredXrayPct}%</Chip>
                      : <Chip tone="critical" icon={<AlertCircle size={11} />}>Below {requiredXrayPct}%</Chip>}
                  </Td>
                </Tr>
              ))}
              <tr className="border-t-2 border-hairline bg-surface-raised/50">
                <Td className="font-semibold">Total</Td>
                <Td className="tnum text-right font-mono font-semibold">{num(totals.totalWeldCredits)}</Td>
                <Td className="tnum text-right font-mono font-semibold">{num(totals.totalXrayCredits)}</Td>
                <Td className="tnum text-right font-mono font-semibold">{pct(totals.xrayPct)}</Td>
                <Td colSpan={6} className="text-2xs text-ink-muted">
                  {num(totals.jointCount)} physical joints — the credit total above exceeds it by{' '}
                  {pct(totals.creditOverstatementPct)} because split-pass joints are credited to
                  each welder.
                </Td>
              </tr>
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto">Detailed weld log</CardTitle>
          <select
            value={line}
            onChange={(e) => setLine(e.target.value)}
            aria-label="Filter by line"
            className="rounded-md border border-hairline bg-surface-raised px-2 py-1 text-xs text-ink"
          >
            <option value="">All lines ({lines.length})</option>
            {lines.map((l) => (
              <option key={l.code} value={l.code}>{l.code} — {l.workbook}</option>
            ))}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search weld, welder, heat, X-ray…"
            aria-label="Search welds"
            className="w-56 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-xs text-ink placeholder:text-ink-muted"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-ink-secondary">
            <input
              type="checkbox"
              checked={incompleteOnly}
              onChange={(e) => setIncompleteOnly(e.target.checked)}
              className="accent-[rgb(124_77_255)]"
            />
            Incomplete only ({num(incompleteCount)})
          </label>
        </CardHeader>
        <CardBody className="p-0">
          <div className="border-b border-hairline px-5 py-2 text-2xs text-ink-muted">
            Showing {num(filtered.length)} of {num(rows.length)} rows
          </div>

          {filtered.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No welds match these filters" />
            </div>
          ) : (
            <>
              <div className="w-full overflow-x-auto">
                <div className="min-w-[1180px]">
                  <div className="grid grid-cols-[70px_74px_92px_120px_66px_150px_150px_58px_60px_84px_66px_72px_60px]
                                  gap-x-2 border-b border-hairline bg-surface px-5 py-2
                                  text-2xs font-medium uppercase tracking-wide text-ink-muted">
                    <span>Line</span><span>Weld</span><span>Date</span>
                    <span>Welder R/H/F/C</span><span>Joint</span><span>Component</span>
                    <span>Heat numbers</span><span>CWI</span><span>Visual</span>
                    <span>X-ray</span><span>Method</span><span>NDT</span><span>State</span>
                  </div>
                  <div ref={parentRef} className="h-[560px] overflow-y-auto">
                    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                      {virtualizer.getVirtualItems().map((v) => {
                        const r = filtered[v.index]!
                        return (
                          <div
                            key={r.id}
                            className={cn(
                              'absolute left-0 top-0 grid w-full items-center gap-x-2 border-b',
                              'border-hairline/50 px-5 text-xs transition-colors hover:bg-brand-bright/[0.06]',
                              'grid-cols-[70px_74px_92px_120px_66px_150px_150px_58px_60px_84px_66px_72px_60px]',
                              r.status === 'not_used' && 'opacity-45',
                            )}
                            style={{ height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
                          >
                            <span className="truncate font-mono text-ink-secondary">{r.line}</span>
                            <span className="truncate font-mono font-medium">{r.weldNumber}</span>
                            <span className="tnum truncate font-mono text-ink-secondary">{r.weldDate ?? '—'}</span>
                            <span className="truncate font-mono text-ink-secondary">{r.welders ?? '—'}</span>
                            <span className="truncate text-ink-secondary">{r.jointType ?? '—'}</span>
                            <span className="truncate text-ink-secondary" title={r.component ?? ''}>
                              {r.component ?? '—'}
                            </span>
                            <span className="truncate font-mono text-ink-secondary" title={r.heats}>
                              {r.heats || '—'}
                            </span>
                            <span className="truncate font-mono text-ink-secondary">{r.cwi ?? '—'}</span>
                            <span>
                              {r.visual
                                ? <Chip tone={r.visual === 'Pass' ? 'complete' : 'critical'}>{r.visual}</Chip>
                                : <span className="text-ink-muted">—</span>}
                            </span>
                            <span className="truncate font-mono text-ink-secondary">{r.xray ?? '—'}</span>
                            <span className="truncate text-ink-secondary">{r.method ?? '—'}</span>
                            <span>
                              {r.ndtResult
                                ? <Chip tone={r.ndtResult === 'Pass' ? 'complete' : 'critical'}>
                                    {r.ndtResult}{!r.linked && ' ⚠'}
                                  </Chip>
                                : <span className="text-ink-muted">—</span>}
                            </span>
                            <span>
                              {r.status === 'not_used'
                                ? <Chip tone="idle">Not used</Chip>
                                : r.complete
                                  ? <Chip tone="complete" icon={<Check size={10} />}>OK</Chip>
                                  : <Chip tone="progress" title={r.missing.join(', ')}>
                                      {r.missing.length} gap{r.missing.length === 1 ? '' : 's'}
                                    </Chip>}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
