import { notFound, redirect } from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import {
  TIMELINESS_ESCALATION_PCT, TIMELINESS_TARGET_PCT, byStandard, entryTimeliness,
  escalationWeeks, weeklyTimeliness,
} from '@/lib/domain/timeliness'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, Metric,
  ProgressBar, SectionHeading, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

export const dynamic = 'force-dynamic'

const WORK_WEEK_LABEL: Record<string, string> = {
  mon_fri: 'Monday to Friday',
  mon_sat: 'Monday to Saturday',
  all_days: 'seven days',
}

export default async function TimelinessPage({
  params,
}: {
  params: Promise<{ bookId: string }>
}) {
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params

  const bundle = await getDataProvider().getBundle(viewer, bookId)
  if (!bundle) notFound()

  // §8 measures Fortress's own process. A client is owed a complete book,
  // not a report on how promptly Fortress's crews file their paperwork.
  const FORTRESS = new Set(['fortress_admin', 'qaqc_manager', 'qaqc_tech', 'fortress_read_only'])
  if (!FORTRESS.has(viewer.role)) {
    return (
      <EmptyState
        title="Not visible on this account"
        detail="Entry timeliness is Fortress's internal measure of how promptly records reach the job book."
      />
    )
  }

  const r = entryTimeliness(bundle)
  const weeks = weeklyTimeliness(bundle)
  const escalations = escalationWeeks(weeks)
  const rows = byStandard(r)
  const week = WORK_WEEK_LABEL[bundle.book.workWeek ?? 'mon_fri'] ?? 'Monday to Friday'

  const tone = r.ratePct == null
    ? 'idle'
    : r.ratePct >= TIMELINESS_TARGET_PCT
      ? 'complete'
      : r.ratePct < TIMELINESS_ESCALATION_PCT ? 'critical' : 'progress'

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Entry timeliness"
        subtitle={
          <>
            FDS-JBMP-001 §8. Each record&rsquo;s work date against the moment it was entered,
            counted in the crew&rsquo;s working days — this book works {week}.
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Entry timeliness rate"
          value={r.ratePct == null ? '—' : `${r.ratePct}%`}
          tone={tone}
          sub={r.ratePct == null ? 'nothing measurable' : `target ${TIMELINESS_TARGET_PCT}%`}
        />
        <Metric
          label="Within standard"
          value={`${r.withinStandard} / ${r.totalMeasured}`}
          sub="measurable entries"
        />
        <Metric
          label="Not measurable"
          value={r.unmeasurable}
          tone={r.unmeasurable > 0 ? 'progress' : undefined}
          sub="excluded from the rate"
        />
        <Metric
          label="Entered before the work"
          value={r.enteredBeforeWork}
          tone={r.enteredBeforeWork > 0 ? 'critical' : undefined}
          sub="records predating what they report"
        />
      </div>

      {r.ratePct == null && (
        <Card>
          <CardBody className="text-xs text-ink-secondary">
            <p>
              No record in this book can be timed. Every entry either carries no entry stamp or
              was loaded in bulk, and §8.3 measures the work date carried on the record against
              the date it was entered — neither of which a bulk load can supply.
            </p>
            <p className="mt-2">
              This is reported as no rate rather than as 0%. A migrated book has no §8 history,
              and scoring one as a total failure would make the number useless the first time
              anybody read it.
            </p>
          </CardBody>
        </Card>
      )}

      {escalations.length > 0 && (
        <Card className="border-status-critical/30">
          <CardHeader>
            <CardTitle>Escalation due under §8.3</CardTitle>
          </CardHeader>
          <CardBody className="text-xs text-ink-secondary">
            This book has been below {TIMELINESS_ESCALATION_PCT}% for two consecutive measured
            weeks, most recently the week of {escalations[escalations.length - 1]!.periodStart}.
            §8.3 escalates that to the Project Manager and the VP of Operations.
          </CardBody>
        </Card>
      )}

      {rows.length > 0 && (
        <Card>
          <CardHeader><CardTitle>By standard (§8.1)</CardTitle></CardHeader>
          <CardBody className="overflow-x-auto p-0">
            <Table>
              <thead>
                <Tr>
                  <Th>Work event</Th>
                  <Th>Standard</Th>
                  <Th>Responsible</Th>
                  <Th className="text-right">On time</Th>
                  <Th className="text-right">Late</Th>
                  <Th className="text-right">Not measurable</Th>
                  <Th className="text-right">Rate</Th>
                </Tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Tr key={row.standard.id}>
                    <Td>
                      {row.standard.event}
                      <span className="ml-1 text-ink-muted">§{row.standard.sectionNumber}</span>
                    </Td>
                    <Td className="text-ink-secondary">{row.standard.statedAs}</Td>
                    <Td className="text-ink-secondary">{row.standard.responsible}</Td>
                    <Td className="tnum text-right">{row.onTime}</Td>
                    <Td className="tnum text-right">{row.late || ''}</Td>
                    <Td className="tnum text-right text-ink-muted">{row.unmeasurable || ''}</Td>
                    <Td className="text-right">
                      {row.ratePct == null ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        <Chip tone={row.ratePct >= TIMELINESS_TARGET_PCT ? 'complete' : 'critical'}>
                          {row.ratePct}%
                        </Chip>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      {weeks.length > 0 && (
        <Card>
          <CardHeader><CardTitle>By week (§8.3)</CardTitle></CardHeader>
          <CardBody className="space-y-2">
            {weeks.slice(-12).map((w) => (
              <div key={w.periodStart} className="flex flex-wrap items-center gap-3 text-xs">
                <span className="tnum w-24 text-ink-secondary">{w.periodStart}</span>
                <div className="min-w-[8rem] flex-1">
                  <ProgressBar
                    value={w.ratePct ?? 0}
                    tone={
                      w.ratePct == null ? 'idle'
                      : w.ratePct >= TIMELINESS_TARGET_PCT ? 'complete'
                      : w.ratePct < TIMELINESS_ESCALATION_PCT ? 'critical' : 'progress'
                    }
                  />
                </div>
                <span className="tnum w-14 text-right text-ink">
                  {w.ratePct == null ? '—' : `${w.ratePct}%`}
                </span>
                <span className="tnum w-24 text-right text-ink-muted">
                  {w.withinStandard}/{w.totalMeasured}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {r.late.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Late entries, worst first</CardTitle>
          </CardHeader>
          <CardBody className="overflow-x-auto p-0">
            <Table>
              <thead>
                <Tr>
                  <Th>Record</Th>
                  <Th>Work date</Th>
                  <Th>Due in the book</Th>
                  <Th>Entered</Th>
                  <Th className="text-right">Business days late</Th>
                </Tr>
              </thead>
              <tbody>
                {r.late.slice(0, 100).map((a) => (
                  <Tr key={`${a.standardId}-${a.recordId}`}>
                    <Td>{a.recordLabel}</Td>
                    <Td className="tnum">{a.workDate}</Td>
                    <Td className="tnum text-ink-secondary">{a.dueBy}</Td>
                    <Td className="tnum">{a.enteredOn}</Td>
                    <Td className="tnum text-right">{a.daysLate}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {r.late.length > 100 && (
              <p className="px-4 py-2 text-2xs text-ink-muted">
                Showing the 100 latest of {r.late.length}.
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  )
}
