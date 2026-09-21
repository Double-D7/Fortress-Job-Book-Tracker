import { notFound, redirect} from 'next/navigation'
import { Download, FileArchive, FileText } from 'lucide-react'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { scoreBook } from '@/lib/domain/scoring'
import { countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { bytes, num, pct } from '@/lib/utils'

export const dynamic = 'force-dynamic'

/**
 * Turnover package.
 *
 * The generated checklist is the deliverable the operator audits against,
 * so it is rendered here exactly as it will export — same section numbers,
 * same verbatim titles, same order. What is on this screen is what ships.
 */
export default async function ExportPage({ params }: { params: Promise<{ bookId: string }> }) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params
  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) notFound()

  const score = scoreBook(b)
  const flags = countBySeverity(evaluateFlags(b))
  const live = b.documents.filter((d) => !d.deletedAt)
  const approved = live.filter((d) => d.approvedAt)
  const totalBytes = live.reduce((s, d) => s + (d.byteSize ?? 0), 0)
  const blocking = score.sections.filter((s) => s.countsTowardTotal && s.weight > 0 && s.pct === 0)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Turnover readiness</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Overall completion</div>
              <div className="tnum mt-1 text-2xl font-semibold">{pct(score.overallPct)}</div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Documents</div>
              <div className="tnum mt-1 text-2xl font-semibold">
                {num(approved.length)}<span className="text-base text-ink-muted">/{num(live.length)}</span>
              </div>
              <div className="text-2xs text-ink-secondary">approved · {bytes(totalBytes)}</div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Open critical flags</div>
              <div className="tnum mt-1 text-2xl font-semibold text-status-critical">{num(flags.critical)}</div>
            </div>
          </div>

          {blocking.length > 0 && (
            <div className="rounded-md border border-status-critical/30 bg-status-critical/[0.07] px-3.5 py-3">
              <p className="text-xs font-medium text-status-critical">
                {blocking.length} required section{blocking.length === 1 ? ' is' : 's are'} entirely absent
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {blocking.map((s) => (
                  <li key={s.sectionNumber} className="text-2xs text-ink-secondary">
                    <span className="tnum font-mono text-ink-muted">{s.sectionNumber}</span> · {s.title}
                    <span className="ml-1 text-ink-muted">({s.weight} weight points)</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-2xs leading-relaxed text-ink-muted">
                A package can be generated in this state — Fortress may need to ship an interim
                book — but the completeness report will say so on its face, and the operator will
                read it there rather than discovering it later.
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary"><FileText size={13} /> Generate bookmarked PDF package</Button>
            <Button variant="secondary"><FileArchive size={13} /> Original files (ZIP)</Button>
            <Button variant="secondary"><Download size={13} /> Noble-format Excel logs</Button>
          </div>
          <p className="text-2xs leading-relaxed text-ink-muted">
            The PDF package carries a cover sheet, an auto-generated table of contents keyed to the
            section numbering below, every approved document in section order, and a signed
            completeness report reproducing this page's figures.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Job book checklist — as it will export</CardTitle>
          <span className="text-2xs text-ink-muted">Section 1, generated from live status</span>
        </CardHeader>
        <CardBody className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>§</Th><Th>Section</Th><Th className="text-right">Docs</Th>
                <Th className="text-right">Complete</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {score.sections.map((s) => {
                const def = b.sectionDefinitions.find((d) => d.sectionNumber === s.sectionNumber)!
                const sec = b.sections.find((x) => x.sectionDefinitionId === def.id)!
                const count = live.filter((d) => d.sectionId === sec.id).length
                return (
                  <Tr key={s.sectionNumber}>
                    <Td className="tnum whitespace-nowrap font-mono text-ink-muted">{s.sectionNumber}</Td>
                    <Td>{s.title}</Td>
                    <Td className="tnum text-right font-mono text-ink-secondary">{count ? num(count) : '—'}</Td>
                    <Td className="tnum text-right font-mono">
                      {s.countsTowardTotal && s.weight > 0 ? pct(s.pct) : '—'}
                    </Td>
                    <Td>
                      {sec.status === 'na' ? <Chip tone="idle">N/A</Chip>
                        : def.isSupplemental ? <Chip tone="idle">Supplemental</Chip>
                        : s.pct === 0 && s.weight > 0 ? <Chip tone="critical">Absent</Chip>
                        : s.pct >= 100 ? <Chip tone="complete">Complete</Chip>
                        : <Chip tone="progress">Partial</Chip>}
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
