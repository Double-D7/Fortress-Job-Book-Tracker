import { notFound, redirect} from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { reconcileHeats } from '@/lib/domain/reconcile'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, Metric, Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { num, pct } from '@/lib/utils'

export const dynamic = 'force-dynamic'

/**
 * Materials and MTRs.
 *
 * The two reconciliation reports below are what an auditor spot-checks, and
 * they are only possible because the heat number is the record and the MTR
 * is its attachment. Inverted — a folder of PDFs with the heat in the
 * filename — neither question can be answered at all.
 */
export default async function MaterialsPage({ params }: { params: Promise<{ bookId: string }> }) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params
  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) notFound()

  const rec = reconcileHeats(b.welds, b.materialHeats)
  const heatById = new Map(b.materialHeats.map((h) => [h.heatNumber.trim(), h]))
  const docById = new Map(b.documents.map((d) => [d.id, d]))
  const unidentified = b.materialHeats.filter((h) => h.mtrStatus === 'unidentified')

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Heats referenced by welds" value={num(rec.referencedHeats.length)} />
        <Metric
          label="MTR coverage"
          value={pct(rec.coveragePct)}
          tone={rec.coveragePct >= 100 ? 'complete' : 'progress'}
          sub="of referenced heats with a report on file"
        />
        <Metric
          label="Heats without an MTR"
          value={num(rec.heatsWithoutMtr.length)}
          tone={rec.heatsWithoutMtr.length ? 'critical' : 'complete'}
        />
        <Metric
          label="MTRs no weld references"
          value={num(rec.mtrsWithoutWelds.length)}
          tone={rec.mtrsWithoutWelds.length ? 'info' : 'complete'}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Heats without an MTR on file</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {rec.heatsWithoutMtr.length === 0 ? (
              <div className="p-5"><EmptyState title="Every referenced heat has an MTR" /></div>
            ) : (
              <Table>
                <thead>
                  <tr><Th>Heat</Th><Th className="text-right">Welds</Th><Th>Material record</Th></tr>
                </thead>
                <tbody>
                  {rec.heatsWithoutMtr.map((h) => (
                    <Tr key={h.heatNumber}>
                      <Td className="font-mono font-medium">{h.heatNumber}</Td>
                      <Td className="tnum text-right font-mono">{num(h.weldCount)}</Td>
                      <Td>
                        {h.hasRecord
                          ? <Chip tone="progress">Record exists, no report attached</Chip>
                          : <Chip tone="critical">No material record at all</Chip>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>MTRs on file that no weld references</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {rec.mtrsWithoutWelds.length === 0 ? (
              <div className="p-5"><EmptyState title="Every MTR on file is referenced" /></div>
            ) : (
              <Table>
                <thead>
                  <tr><Th>Heat</Th><Th>Component</Th><Th>File</Th></tr>
                </thead>
                <tbody>
                  {rec.mtrsWithoutWelds.map((h) => (
                    <Tr key={h.id}>
                      <Td className="font-mono font-medium">{h.heatNumber}</Td>
                      <Td className="text-ink-secondary">{h.componentType ?? '—'}</Td>
                      <Td className="text-2xs text-ink-muted">
                        {h.mtrDocumentId ? docById.get(h.mtrDocumentId)?.originalFilename ?? '—' : '—'}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      {unidentified.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>MTRs filed under a bare heat number</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="mb-3 text-xs leading-relaxed text-ink-secondary">
              These {unidentified.length} reports carry no identifiable component, size or grade —
              only a heat number, and in several cases only in the filename. They cannot be
              reconciled against a weld until someone opens each one and records what it certifies.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {unidentified.map((h) => (
                <Chip key={h.id} tone="progress" className="font-mono">{h.heatNumber}</Chip>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Heat register</CardTitle>
          <span className="text-2xs text-ink-muted">{num(b.materialHeats.length)} records</span>
        </CardHeader>
        <CardBody className="p-0">
          <div className="max-h-[520px] overflow-y-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Heat</Th><Th>Component</Th><Th>Size</Th><Th>Sch/Class</Th>
                  <Th>Grade</Th><Th className="text-right">Welds</Th><Th>MTR</Th>
                </tr>
              </thead>
              <tbody>
                {b.materialHeats.map((h) => {
                  const weldCount = b.welds.filter(
                    (w) => w.status !== 'not_used' && w.heatNumbers.includes(h.heatNumber),
                  ).length
                  return (
                    <Tr key={h.id}>
                      <Td className="font-mono font-medium">{h.heatNumber}</Td>
                      <Td className="text-ink-secondary">{h.componentType ?? '—'}</Td>
                      <Td className="text-ink-secondary">{h.nominalSize ?? '—'}</Td>
                      <Td className="text-ink-secondary">{h.scheduleOrClass ?? '—'}</Td>
                      <Td className="text-ink-secondary">{h.grade ?? '—'}</Td>
                      <Td className="tnum text-right font-mono">{weldCount ? num(weldCount) : '—'}</Td>
                      <Td>
                        {h.mtrStatus === 'on_file' ? <Chip tone="complete">On file</Chip>
                          : h.mtrStatus === 'unidentified' ? <Chip tone="progress">Unidentified</Chip>
                          : h.mtrStatus === 'illegible' ? <Chip tone="progress">Illegible</Chip>
                          : <Chip tone="critical">Missing</Chip>}
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
