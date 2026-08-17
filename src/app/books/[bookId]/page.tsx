/**
 * Job book overview — the money screen.
 *
 * Every number here expands. The section list carries each score's own
 * explanation inline rather than behind a tooltip, because §5.4 requires
 * the decomposition to be present, not merely available: a manager reading
 * "Section 12 — 92.2%" needs to see "2,342 joints, 2,159 complete · 152
 * missing CWI initials" without another click.
 */
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, Info, TriangleAlert } from 'lucide-react'
import { DEMO_VIEWER, getDataProvider } from '@/lib/data/provider'
import { scoreBook, weightLoss } from '@/lib/domain/scoring'
import { countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import { xrayTotals } from '@/lib/domain/welders'
import { torqueTotals } from '@/lib/domain/torque'
import { reconcileHeats } from '@/lib/domain/reconcile'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, Metric, ProgressBar, Ring, bandTone,
} from '@/components/ui/primitives'
import { num, pct } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const SECTION_STATUS: Record<string, { label: string; tone: 'complete' | 'progress' | 'idle' | 'info' }> = {
  not_started: { label: 'Not started', tone: 'idle' },
  in_progress: { label: 'In progress', tone: 'progress' },
  ready_for_review: { label: 'Ready for review', tone: 'info' },
  approved: { label: 'Approved', tone: 'complete' },
  na: { label: 'N/A', tone: 'idle' },
}

export default async function BookOverview({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params
  const b = await getDataProvider().getBundle(DEMO_VIEWER, bookId)
  if (!b) notFound()

  const score = scoreBook(b)
  const flags = countBySeverity(evaluateFlags(b))
  const xray = xrayTotals(b.welds, b.book, b.welders)
  const torque = torqueTotals(b.torqueConnections, b.book)
  const heats = reconcileHeats(b.welds, b.materialHeats)
  const losses = weightLoss(score).slice(0, 5)
  const defsById = new Map(b.sectionDefinitions.map((d) => [d.id, d]))

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card>
          <CardBody className="flex flex-col items-center py-6">
            <Ring value={score.overallPct} sublabel="overall completion" />
            <p className="mt-4 text-center text-2xs leading-relaxed text-ink-muted">
              {score.weightApplied.toFixed(1)} of {score.weightAvailable} weight points earned
              across {score.sections.filter((s) => s.countsTowardTotal && s.weight > 0).length} scoring
              sections.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Open flags</CardTitle></CardHeader>
          <CardBody className="space-y-2">
            <FlagRow icon={<AlertTriangle size={13} />} tone="critical" label="Critical" n={flags.critical} bookId={bookId} />
            <FlagRow icon={<TriangleAlert size={13} />} tone="progress" label="Warning" n={flags.warning} bookId={bookId} />
            <FlagRow icon={<Info size={13} />} tone="info" label="Info" n={flags.info} bookId={bookId} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Where the points are going</CardTitle></CardHeader>
          <CardBody className="space-y-2.5">
            {losses.map((l) => (
              <div key={l.sectionNumber} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-ink-secondary">
                  <span className="tnum text-ink-muted">{l.sectionNumber}</span> · {l.title}
                </span>
                <span className="tnum shrink-0 font-medium text-status-critical">−{l.lost}</span>
              </div>
            ))}
            <p className="pt-1 text-2xs leading-relaxed text-ink-muted">
              Weight points lost, largest first. Closing the top item moves the overall
              percentage more than closing the rest combined.
            </p>
          </CardBody>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Weld credits"
            value={num(xray.totalWeldCredits)}
            sub={xray.jointCount === 0
              ? 'No joints entered yet'
              : `${num(xray.jointCount)} joints — credit basis overstates by ${pct(xray.creditOverstatementPct)}`}
          />
          <Metric
            label="X-ray coverage"
            value={xray.totalWeldCredits === 0 ? '—' : pct(xray.xrayPct)}
            sub={xray.totalWeldCredits === 0
              ? 'No welds entered yet'
              : `${num(xray.totalXrayCredits)} of ${num(xray.totalWeldCredits)} · job minimum ${b.book.requiredXrayPct}%`}
            tone={xray.totalWeldCredits === 0
              ? 'idle'
              : xray.xrayPct >= b.book.requiredXrayPct ? 'complete' : 'critical'}
          />
          <Metric
            label="Torque inspection"
            value={torque.totalConnections === 0 ? '—' : pct(torque.inspectionPct, 2)}
            sub={torque.totalConnections === 0
              ? 'No connections entered yet'
              : `${num(torque.inspectedConnections)} of ${num(torque.totalConnections)} connections`}
            tone={torque.totalConnections === 0
              ? 'idle'
              : torque.meetsRequirement ? 'complete' : 'critical'}
          />
          {/* An empty book references no heats, and "0 of 0" is vacuously
              100%. Showing that in green would be the exact false
              reassurance the declared-scope work exists to remove. */}
          <Metric
            label="MTR coverage"
            value={heats.referencedHeats.length === 0 ? '—' : pct(heats.coveragePct)}
            sub={heats.referencedHeats.length === 0
              ? 'No welds reference a heat number yet'
              : `${num(heats.heatsWithoutMtr.length)} referenced heats with no MTR on file`}
            tone={heats.referencedHeats.length === 0
              ? 'idle'
              : heats.coveragePct >= 100 ? 'complete' : 'progress'}
          />
        </div>

        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Sections</CardTitle>
            <span className="text-2xs text-ink-muted">
              Titles are verbatim from the governing checklist
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <ul className="divide-y divide-hairline/60">
              {score.sections.map((s) => {
                const def = b.sectionDefinitions.find((d) => d.sectionNumber === s.sectionNumber)
                const status = SECTION_STATUS[s.status] ?? SECTION_STATUS.in_progress!
                return (
                  <li key={s.sectionNumber}>
                    <Link
                      href={`/books/${bookId}/sections/${encodeURIComponent(s.sectionNumber)}`}
                      className="block px-5 py-3 transition-colors hover:bg-brand-bright/[0.06]"
                    >
                      <div className="flex items-start gap-3">
                        <span className="tnum mt-0.5 w-10 shrink-0 text-xs font-medium text-ink-muted">
                          {s.sectionNumber}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-ink">{s.title}</span>
                            <Chip tone={status.tone}>{status.label}</Chip>
                            {def?.isSupplemental && <Chip tone="idle">Supplemental · unscored</Chip>}
                            {s.requirementType === 'derived' && <Chip tone="idle">Derived</Chip>}
                          </div>
                          <p className="mt-1 text-2xs leading-relaxed text-ink-secondary">
                            {s.explanation}
                          </p>
                          {s.countsTowardTotal && s.weight > 0 && (
                            <div className="mt-2 flex items-center gap-3">
                              <ProgressBar value={s.pct} className="max-w-xs" />
                              <span className="tnum shrink-0 text-2xs text-ink-muted">
                                weight {s.weight}
                              </span>
                            </div>
                          )}
                        </div>
                        <span
                          className={`tnum w-16 shrink-0 text-right text-sm font-semibold ${
                            !s.countsTowardTotal
                              ? 'text-ink-muted'
                              : { complete: 'text-status-complete', progress: 'text-status-progress',
                                  critical: 'text-status-critical', idle: '', info: '', brand: '' }[bandTone(s.pct)]
                          }`}
                        >
                          {s.countsTowardTotal && s.weight > 0 ? pct(s.pct) : '—'}
                        </span>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function FlagRow({
  icon, tone, label, n, bookId,
}: { icon: React.ReactNode; tone: 'critical' | 'progress' | 'info'; label: string; n: number; bookId: string }) {
  return (
    <Link
      href={`/books/${bookId}/flags?severity=${label.toLowerCase()}`}
      className="flex items-center justify-between rounded-md px-2 py-1.5 transition-colors hover:bg-surface-raised"
    >
      <Chip tone={tone} icon={icon}>{label}</Chip>
      <span className="tnum text-sm font-semibold">{num(n)}</span>
    </Link>
  )
}
