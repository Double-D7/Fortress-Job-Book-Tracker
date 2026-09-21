import { notFound, redirect} from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { certHistory, evaluateCert, upcomingExpiries } from '@/lib/domain/certificates'
import { continuityStatus, qualifiedOn, rollupByWelder } from '@/lib/domain/welders'
import { reconcileWrenches } from '@/lib/domain/torque'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { num, pct } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const CERT_CHIP = {
  valid: { tone: 'complete' as const, label: 'Valid' },
  expiring_soon: { tone: 'progress' as const, label: 'Expiring soon' },
  expired: { tone: 'critical' as const, label: 'Expired' },
  missing: { tone: 'critical' as const, label: 'Missing' },
}

/**
 * Personnel and equipment.
 *
 * The column that matters is not "is this certificate valid today" but
 * "was it valid on every day this person worked". Both are shown, because
 * they answer different questions and a book can fail either one.
 */
export default async function PersonnelPage({ params }: { params: Promise<{ bookId: string }> }) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params
  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) notFound()

  const asOf = b.book.dataAsOfDate ?? new Date().toISOString().slice(0, 10)
  const rollups = rollupByWelder(b.welds, b.welders, b.book)
  const expiries = upcomingExpiries(b.certificates, 365, asOf)
  const rec = reconcileWrenches(b.torqueConnections, b.torqueWrenches)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Welders</CardTitle>
          <span className="text-2xs text-ink-muted">
            Keyed by initials and qualification record, never by the name as typed in a log
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Welder</Th><Th>Also spelled</Th><Th className="text-right">Welds</Th>
                <Th className="text-right">% X-ray</Th><Th>Qualification</Th>
                <Th>Qualified on every weld date</Th><Th>Continuity</Th>
              </tr>
            </thead>
            <tbody>
              {b.welders.map((w) => {
                const r = rollups.find((x) => x.welderId === w.id)
                const quals = b.welderQualifications.filter((q) => q.welderId === w.id)
                const workDates = b.welds
                  .filter((x) => x.status !== 'not_used' && x.weldDate &&
                    [x.rootWelderId, x.hotWelderId, x.fillWelderId, x.capWelderId].includes(w.id))
                  .map((x) => x.weldDate!)
                const badDates = workDates.filter((d) => !qualifiedOn(w.id, d, b.welderQualifications))
                const cont = continuityStatus(w.id, b.welds, asOf)
                return (
                  <Tr key={w.id}>
                    <Td>
                      <span className="font-mono font-medium">{w.initials}</span>
                      <span className="ml-2 text-ink-secondary">{w.fullName}</span>
                    </Td>
                    <Td className="text-2xs text-ink-muted">
                      {w.nameAliases.length ? w.nameAliases.join(', ') : '—'}
                    </Td>
                    <Td className="tnum text-right font-mono">{num(r?.totalWelds ?? 0)}</Td>
                    <Td className="tnum text-right font-mono">{pct(r?.xrayPct ?? 0)}</Td>
                    <Td className="text-ink-secondary">
                      {quals.length
                        ? quals.map((q) => (
                            <div key={q.id} className="tnum font-mono text-2xs">
                              {q.code.replace('_', ' ')} · {q.qualificationDate}
                            </div>
                          ))
                        : '—'}
                    </Td>
                    <Td>
                      {badDates.length === 0
                        ? <Chip tone="complete">Yes</Chip>
                        : <Chip tone="critical">
                            No — {num(badDates.length)} weld{badDates.length === 1 ? '' : 's'} before qualification
                          </Chip>}
                    </Td>
                    <Td className="text-2xs text-ink-secondary">
                      {cont.lastWeldDate
                        ? <>last weld {cont.lastWeldDate}; lapses {cont.lapsesOn}{' '}
                            {cont.lapsed && <Chip tone="progress" className="ml-1">Lapsed</Chip>}</>
                        : '—'}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Certified welding inspectors</CardTitle></CardHeader>
          <CardBody className="p-0">
            <Table>
              <thead><tr><Th>Inspector</Th><Th>Certificate</Th><Th>Expires</Th><Th>Status</Th></tr></thead>
              <tbody>
                {b.cwis.map((c) => {
                  const cert = certHistory(b.certificates, 'cwi', c.id)[0] ?? null
                  const e = evaluateCert(cert, b.book.certExpiryWarningDays, asOf)
                  const chip = CERT_CHIP[e.status]
                  return (
                    <Tr key={c.id}>
                      <Td><span className="font-mono">{c.initials}</span>
                        <span className="ml-2 text-ink-secondary">{c.fullName}</span></Td>
                      <Td className="text-ink-secondary">{cert?.certType ?? '—'}</Td>
                      <Td className="tnum font-mono text-ink-secondary">{e.expiresOn ?? '—'}</Td>
                      <Td><Chip tone={chip.tone}>{chip.label}</Chip></Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>NDT technicians</CardTitle></CardHeader>
          <CardBody className="p-0">
            <Table>
              <thead><tr><Th>Technician</Th><Th>Class</Th><Th>Expires</Th><Th>Status</Th></tr></thead>
              <tbody>
                {b.ndtTechnicians.map((t) => {
                  const cert = certHistory(b.certificates, 'ndt_technician', t.id)[0] ?? null
                  const e = evaluateCert(cert, b.book.certExpiryWarningDays, asOf)
                  const chip = CERT_CHIP[e.status]
                  const reports = b.ndeReports.filter((r) => r.technicianId === t.id)
                  const uncovered = reports.filter(
                    (r) => !cert?.issueDate || r.reportDate < cert.issueDate ||
                      (cert.expiryDate ? r.reportDate > cert.expiryDate : false),
                  )
                  return (
                    <Tr key={t.id}>
                      <Td>{t.fullName}
                        <div className="text-2xs text-ink-muted">{t.employer}</div></Td>
                      <Td className="text-ink-secondary">{t.classification ?? '—'}</Td>
                      <Td className="tnum font-mono text-ink-secondary">{e.expiresOn ?? '—'}</Td>
                      <Td>
                        <Chip tone={chip.tone}>{chip.label}</Chip>
                        {uncovered.length > 0 && (
                          <Chip tone="critical" className="ml-1">
                            {num(uncovered.length)} report{uncovered.length === 1 ? '' : 's'} outside cover
                          </Chip>
                        )}
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Torque wrenches</CardTitle>
          <span className="text-2xs text-ink-muted">
            {rec.onRoster.length} rostered · {rec.inUse.length} used · {rec.certified.length} certified
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Wrench</Th><Th className="text-right">Capacity</Th><Th className="text-right">Uses</Th>
                <Th>Calibrated</Th><Th>Due</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {b.torqueWrenches.map((w) => {
                const cert = certHistory(b.certificates, 'torque_wrench', w.id)[0] ?? null
                const e = evaluateCert(cert, b.book.certExpiryWarningDays, asOf)
                const chip = CERT_CHIP[e.status]
                const uses = rec.usageCounts[w.wrenchId] ?? 0
                return (
                  <Tr key={w.id}>
                    <Td className="font-mono font-medium">{w.wrenchId}</Td>
                    <Td className="tnum text-right font-mono text-ink-secondary">
                      {w.capacityFtLb ? `${num(w.capacityFtLb)} ft-lb` : '—'}
                    </Td>
                    <Td className="tnum text-right font-mono">{uses ? num(uses) : '—'}</Td>
                    <Td className="tnum font-mono text-ink-secondary">
                      {w.lastCalibrationDate ?? '—'}
                    </Td>
                    <Td className="tnum font-mono text-ink-secondary">
                      {w.calibrationDueDate ?? (w.lastCalibrationDate
                        ? <span className="font-sans text-ink-muted">open</span>
                        : '—')}
                    </Td>
                    <Td className="space-x-1">
                      {/* An unread certificate is filed, not missing. Showing
                          it as "missing" was this application telling a crew
                          their calibrated wrench had no calibration. */}
                      {w.certOnFile && !w.lastCalibrationDate
                        ? <Chip tone="info">Filed, not read</Chip>
                        : <Chip tone={chip.tone}>{chip.label}</Chip>}
                      {!w.onRoster && uses > 0 && <Chip tone="progress">Not on roster</Chip>}
                      {w.certOnFile && uses === 0 && <Chip tone="info">Never used</Chip>}
                      {w.rosterClaimedCalibrationDate && w.lastCalibrationDate &&
                        w.rosterClaimedCalibrationDate !== w.lastCalibrationDate &&
                        <Chip tone="progress">
                          Roster says {w.rosterClaimedCalibrationDate}
                        </Chip>}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Upcoming expiries</CardTitle></CardHeader>
        <CardBody className="p-0">
          {expiries.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No certificates lapse within a year of the book's as-of date"
                detail={`Evaluated as of ${asOf}.`}
              />
            </div>
          ) : (
            <Table>
              <thead><tr><Th>Certificate</Th><Th>Subject</Th><Th>Expires</Th><Th className="text-right">Days</Th></tr></thead>
              <tbody>
                {expiries.map((x) => (
                  <Tr key={x.certificate.id}>
                    <Td>{x.certificate.certType}</Td>
                    <Td className="font-mono text-2xs text-ink-secondary">
                      {x.certificate.subjectType} · {x.certificate.subjectId}
                    </Td>
                    <Td className="tnum font-mono">{x.expiresOn}</Td>
                    <Td className="tnum text-right font-mono">{num(x.daysUntilExpiry)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
