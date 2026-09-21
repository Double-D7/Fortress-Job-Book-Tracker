import { notFound, redirect} from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { reconcileNde } from '@/lib/domain/reconcile'
import { certValidOn } from '@/lib/domain/certificates'
import { isWithin } from '@/lib/domain/dates'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, Metric, Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { num } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function NdePage({ params }: { params: Promise<{ bookId: string }> }) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params
  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) notFound()

  const rec = reconcileNde(b.welds, b.ndeReports)
  const techById = new Map(b.ndtTechnicians.map((t) => [t.id, t]))
  const docById = new Map(b.documents.map((d) => [d.id, d]))

  // Reports sharing a date, method and vendor with another live report: the
  // "- Corrected" case, where nothing marks which version governs.
  const dateKey = (r: (typeof b.ndeReports)[number]) => `${r.reportDate}|${r.method}|${r.ndtCompany ?? ''}`
  const dateCounts = new Map<string, number>()
  for (const r of b.ndeReports) if (!r.isSuperseded) {
    dateCounts.set(dateKey(r), (dateCounts.get(dateKey(r)) ?? 0) + 1)
  }

  const sorted = [...b.ndeReports].sort((a, c) => (a.reportDate < c.reportDate ? 1 : -1))

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Reports on file" value={num(b.ndeReports.length)} />
        <Metric label="Welds linked to a report" value={num(rec.linkedCount)} />
        <Metric
          label="Examined welds with no report"
          value={num(rec.weldsClaimingNdeWithoutReport.length)}
          tone={rec.weldsClaimingNdeWithoutReport.length ? 'progress' : 'complete'}
          sub="the weld log claims an examination the book cannot evidence"
        />
        <Metric
          label="Report lines naming an unknown weld"
          value={num(rec.reportLinesWithoutWeld.length)}
          tone={rec.reportLinesWithoutWeld.length ? 'progress' : 'complete'}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>NDE reports</CardTitle>
          <span className="text-2xs text-ink-muted">
            Superseded reports are struck through, never removed
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th><Th>Report</Th><Th>Method</Th><Th>Vendor</Th>
                <Th>Technician</Th><Th className="text-right">Lines</Th>
                <Th>References</Th><Th>Findings</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const tech = r.technicianId ? techById.get(r.technicianId) : null
                const certOk = r.technicianId
                  ? !!certValidOn(b.certificates, 'ndt_technician', r.technicianId, r.reportDate)
                  : false
                const inWindow = isWithin(r.reportDate, b.book.constructionStart, b.book.constructionEnd)
                const wrongJob =
                  (r.referencedPad ?? '').toUpperCase() !== (b.book.drillPadName ?? '').toUpperCase() ||
                  (r.referencedFacility ?? '').toUpperCase() !== b.book.jobNumber.toUpperCase()
                const sameDate = (dateCounts.get(dateKey(r)) ?? 0) > 1
                const doc = r.documentId ? docById.get(r.documentId) : null

                return (
                  <Tr key={r.id} className={r.isSuperseded ? 'opacity-50' : undefined}>
                    <Td className="tnum font-mono">{r.reportDate}</Td>
                    <Td className={r.isSuperseded ? 'line-through' : undefined}>
                      <span className="font-mono">{r.reportNumber}</span>
                      {doc && <div className="mt-0.5 text-2xs text-ink-muted">{doc.originalFilename}</div>}
                    </Td>
                    <Td>{r.method}</Td>
                    <Td className="text-ink-secondary">{r.ndtCompany}</Td>
                    <Td className="text-ink-secondary">
                      {tech?.fullName ?? '—'}
                      {tech && !certOk && (
                        <Chip tone="critical" className="ml-1.5">cert not valid on this date</Chip>
                      )}
                    </Td>
                    <Td className="tnum text-right font-mono">{num(r.lines.length)}</Td>
                    <Td className="font-mono text-ink-secondary">
                      {r.referencedFacility} / {r.referencedPad}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {wrongJob && (
                          <Chip tone="critical" icon={<AlertTriangle size={10} />}>Wrong job</Chip>
                        )}
                        {!inWindow && <Chip tone="progress">Outside construction window</Chip>}
                        {sameDate && <Chip tone="progress">Shares date with another live report</Chip>}
                        {!wrongJob && inWindow && !sameDate && !(tech && !certOk) && (
                          <Chip tone="complete">Clean</Chip>
                        )}
                      </div>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </div>
  )
}
