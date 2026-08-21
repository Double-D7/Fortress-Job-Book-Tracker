import { notFound } from 'next/navigation'
import { AlertTriangle, Check } from 'lucide-react'
import { DEMO_VIEWER, getDataProvider } from '@/lib/data/provider'
import { checkWrenchCalibration, reconcileWrenches, torqueTotals } from '@/lib/domain/torque'
import { torqueCompleteness } from '@/lib/domain/completeness'
import { TorqueGrid } from '@/components/TorqueGrid'
import { Card, CardBody, CardHeader, CardTitle, Chip, Metric, Table, Td, Th, Tr } from '@/components/ui/primitives'
import { num, pct } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const VERDICT_LABEL: Record<string, { label: string; tone: 'complete' | 'critical' | 'progress' }> = {
  valid: { label: 'Valid on torque date', tone: 'complete' },
  expired: { label: 'Expired', tone: 'critical' },
  not_yet_issued: { label: 'Calibration postdates the work', tone: 'critical' },
  unknown_wrench: { label: 'Unknown wrench', tone: 'critical' },
  no_certificate: { label: 'No certificate', tone: 'critical' },
  no_wrench_recorded: { label: 'No wrench recorded', tone: 'critical' },
  no_torque_date: { label: 'No torque date', tone: 'progress' },
}

export default async function TorquePage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params
  const b = await getDataProvider().getBundle(DEMO_VIEWER, bookId)
  if (!b) notFound()

  const totals = torqueTotals(b.torqueConnections, b.book)
  const rec = reconcileWrenches(b.torqueConnections, b.torqueWrenches)

  const rows = b.torqueConnections.map((c) => {
    const check = checkWrenchCalibration(c, b.torqueWrenches)
    const comp = torqueCompleteness(c)
    return {
      id: c.id,
      flange: c.isoFlangeNumber,
      iso: c.isoNumber ?? '',
      size: c.flangePipeSize ?? '',
      bolts: c.boltCount ?? null,
      required: c.requiredTorqueFtLb ?? null,
      actual: c.actualTorqueFtLb ?? null,
      wrench: c.wrenchIdRaw ?? '',
      wrenchVerdict: check.verdict,
      cpTest: c.cpTestOnFlange,
      torqueDate: c.torqueDate ?? null,
      employee: c.employeeInitials ?? '',
      inspectionDate: c.inspectionDate ?? null,
      inspector: c.inspectorInitials ?? '',
      complete: comp.complete,
    }
  })

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Connections" value={num(totals.totalConnections)} />
        <Metric
          label="Inspected"
          value={pct(totals.inspectionPct, 2)}
          sub={`${num(totals.inspectedConnections)} of ${num(totals.totalConnections)} · minimum ${b.book.requiredTorqueInspectPct}%`}
          tone={totals.meetsRequirement ? 'complete' : 'critical'}
        />
        <Metric
          label="Wrench calibration"
          value={`${rec.inUse.length - rec.usedWithoutCertificate.length}/${rec.inUse.length}`}
          sub="wrenches used with a certificate on file"
          tone={rec.usedWithoutCertificate.length ? 'critical' : 'complete'}
        />
        <Metric
          label="CP test flanges"
          value={num(totals.cpFlaggedConnections)}
          sub="marked CP TEST = Y, tying section 14 to section 18"
          tone={totals.cpFlaggedConnections ? 'progress' : 'idle'}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Wrench roster reconciliation</CardTitle>
          <span className="text-2xs text-ink-muted">
            Roster, usage and certificates are three different sets in this book
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Wrench</Th>
                <Th className="text-right">Connections</Th>
                <Th>On roster</Th>
                <Th>Certificate</Th>
                <Th>Calibration window</Th>
                <Th>Finding</Th>
              </tr>
            </thead>
            <tbody>
              {[...new Set([...rec.onRoster, ...rec.inUse, ...rec.certified])].sort().map((id) => {
                const w = b.torqueWrenches.find((x) => x.wrenchId === id)
                const uses = rec.usageCounts[id] ?? 0
                const findings: string[] = []
                if (uses && !w?.onRoster) findings.push('used but not on the roster')
                if (uses && !w?.certOnFile) findings.push('no calibration certificate')
                if (!uses && w?.certOnFile) findings.push('certified but never used')
                if (!uses && w?.onRoster) findings.push('on roster but never used')
                // Set membership is not the whole story: a wrench can be
                // rostered, used and certified and still carry a calibration
                // that does not cover the work it was used on.
                // `certificate_unread` is excluded deliberately: it says
                // this application has not read the certificate, not that
                // the calibration failed to cover the work. Counting it
                // here printed "calibration did not cover 18 of its
                // connections" against a wrench that was calibrated.
                const badDates = b.torqueConnections.filter(
                  (c) => c.wrenchIdRaw === id &&
                    !['valid', 'no_torque_date', 'certificate_unread']
                      .includes(checkWrenchCalibration(c, b.torqueWrenches).verdict),
                )
                const unread = !!w?.certOnFile && !w.lastCalibrationDate
                if (badDates.length && w?.certOnFile) {
                  const worst = checkWrenchCalibration(badDates[0]!, b.torqueWrenches).verdict
                  findings.push(
                    worst === 'not_yet_issued'
                      ? `calibration postdates ${badDates.length} of its connections`
                      : `calibration did not cover ${badDates.length} of its connections`,
                  )
                }
                if (w?.rosterClaimedCalibrationDate && w.lastCalibrationDate &&
                    w.rosterClaimedCalibrationDate !== w.lastCalibrationDate) {
                  findings.push(
                    `roster says ${w.rosterClaimedCalibrationDate}, certificate says ` +
                    `${w.lastCalibrationDate}`,
                  )
                }
                return (
                  <Tr key={id}>
                    <Td className="font-mono font-medium">{id}</Td>
                    <Td className="tnum text-right font-mono">{uses ? num(uses) : '—'}</Td>
                    <Td>{w?.onRoster ? <Chip tone="complete">Yes</Chip> : <Chip tone="idle">No</Chip>}</Td>
                    <Td>{w?.certOnFile ? <Chip tone="complete">On file</Chip> : <Chip tone="critical">Missing</Chip>}</Td>
                    <Td className="tnum font-mono text-ink-secondary">
                      {w?.lastCalibrationDate
                        ? `${w.lastCalibrationDate} → ${w.calibrationDueDate ?? 'open'}`
                        : w?.certOnFile
                          // The certificate is filed; we have not read it.
                          // A bare dash here reads as "no calibration",
                          // which is the opposite of what is true.
                          ? <span className="font-sans text-ink-muted">certificate not yet read</span>
                          : '—'}
                    </Td>
                    <Td className="text-ink-secondary">
                      {findings.length
                        ? <span className="inline-flex items-center gap-1.5 text-status-progress">
                            <AlertTriangle size={12} />{findings.join('; ')}
                          </span>
                        : unread
                          ? <span className="text-ink-muted">
                              certificate filed; dates not read into the book
                            </span>
                          : <span className="inline-flex items-center gap-1.5 text-status-complete">
                              <Check size={12} />consistent
                            </span>}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <TorqueGrid rows={rows} verdictLabels={VERDICT_LABEL} />
    </div>
  )
}
