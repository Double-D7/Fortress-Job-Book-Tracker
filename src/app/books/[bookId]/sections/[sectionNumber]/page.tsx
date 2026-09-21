import Link from 'next/link'
import { notFound, redirect} from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { collectedOf, scoreSection } from '@/lib/domain/scoring'
import { evaluateFlags } from '@/lib/domain/flags'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, ProgressBar,
  Table, Td, Th, Tr, bandTone,
} from '@/components/ui/primitives'
import { SectionUpload } from '@/components/SectionUpload'
import { bytes, num, pct } from '@/lib/utils'

export const dynamic = 'force-dynamic'

/** Mirrors the RLS write predicate; the database remains the control. */
const CAN_UPLOAD = new Set(['fortress_admin', 'qaqc_manager', 'qaqc_tech'])

/**
 * Section detail.
 *
 * The score's inputs are rendered as a table rather than prose: §5.4 wants
 * the decomposition available to an auditor, and a numerator over a
 * denominator is the form an auditor checks.
 */
export default async function SectionDetail({
  params,
}: { params: Promise<{ bookId: string; sectionNumber: string }> }) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId, sectionNumber } = await params
  const number = decodeURIComponent(sectionNumber)
  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) notFound()

  const def = b.sectionDefinitions.find((d) => d.sectionNumber === number)
  if (!def) notFound()
  const section = b.sections.find((s) => s.sectionDefinitionId === def.id)
  if (!section) notFound()

  const score = scoreSection(def, section, b)
  const docs = b.documents.filter((d) => d.sectionId === section.id && !d.deletedAt)
  const flags = evaluateFlags(b).filter((f) => f.sectionNumber === number)

  const canApprove = viewer.role === 'qaqc_manager' || viewer.role === 'fortress_admin'
  const isOwnSubmission = section.readyForReviewBy === viewer.id

  return (
    <div className="space-y-4">
      <Link href={`/books/${bookId}`}
            className="inline-flex items-center gap-1.5 text-xs text-ink-secondary hover:text-ink">
        <ArrowLeft size={13} /> All sections
      </Link>

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="tnum font-mono text-sm text-ink-muted">{def.sectionNumber}</span>
                <h2 className="text-base font-semibold tracking-tight">{def.title}</h2>
              </div>
              {def.notes && <p className="mt-1 text-xs text-ink-secondary">{def.notes}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="idle">{def.requirementType.replace(/_/g, ' ')}</Chip>
                <Chip tone="brand">weight {def.weight}</Chip>
                {section.status === 'na' && <Chip tone="idle">N/A</Chip>}
                {def.isSupplemental && <Chip tone="idle">Supplemental — unscored</Chip>}
              </div>
            </div>
            <div className="text-right">
              <div className={`tnum text-3xl font-semibold ${
                !score.countsTowardTotal ? 'text-ink-muted'
                  : { complete: 'text-status-complete', progress: 'text-status-progress',
                      critical: 'text-status-critical', idle: '', info: '', brand: '' }[bandTone(score.pct)]
              }`}>
                {score.countsTowardTotal && def.weight > 0 ? pct(score.pct) : '—'}
              </div>
              {score.countsTowardTotal && def.weight > 0 && (
                <>
                  <ProgressBar value={score.pct} className="mt-2 w-32" />
                  {/* Evidence in the book but not yet approved. Shown because
                      a tech who uploads eleven drawings and watches the
                      headline stay at 0% cannot tell a working upload from a
                      broken one — and will stop trusting the screen. */}
                  {collectedOf(score) > score.pct && (
                    <div className="mt-1.5 text-2xs text-ink-secondary">
                      <span className="tnum font-medium text-ink">{pct(collectedOf(score))}</span>
                      {' '}collected, awaiting approval
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <p className="mt-4 rounded-md border border-hairline bg-surface-raised px-3 py-2 text-xs leading-relaxed text-ink-secondary">
            {score.explanation}
          </p>
          {section.naReason && (
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">{section.naReason}</p>
          )}
        </CardBody>
      </Card>

      {score.inputs.length > 0 && (
        <Card>
          <CardHeader><CardTitle>How this score is calculated</CardTitle></CardHeader>
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr><Th>Input</Th><Th className="text-right">Count</Th><Th className="text-right">Of</Th><Th>Detail</Th></tr>
              </thead>
              <tbody>
                {score.inputs.map((i, k) => (
                  <Tr key={k}>
                    <Td>{i.label}</Td>
                    <Td className="tnum text-right font-mono">{num(i.numerator)}</Td>
                    <Td className="tnum text-right font-mono text-ink-secondary">{num(i.denominator)}</Td>
                    <Td className="text-2xs text-ink-muted">{i.detail ?? ''}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      <SectionUpload
        bookId={bookId}
        sectionNumber={number}
        sectionTitle={def.title}
        canUpload={CAN_UPLOAD.has(viewer.role)}
      />

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Documents ({num(docs.length)})</CardTitle>
        </CardHeader>
        <CardBody className={docs.length ? 'p-0' : undefined}>
          {docs.length === 0 ? (
            <EmptyState
              title="No documents in this section"
              detail={
                ['16', '17', '18'].includes(number)
                  ? 'This section is required by the governing checklist and is entirely absent ' +
                    'from the delivered book. It cannot be signed off until it is supplied.'
                  : `The checklist requires at least ${def.minDocuments} document(s) here.`
              }
            />
          ) : (
            <div className="max-h-[460px] overflow-y-auto">
              <Table>
                <thead>
                  <tr><Th>File</Th><Th className="text-right">Size</Th><Th>Uploaded</Th><Th>State</Th></tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <Tr key={d.id}>
                      <Td>
                        <div className="text-ink">{d.originalFilename}</div>
                        <div className="font-mono text-2xs text-ink-muted">{d.normalizedFilename}</div>
                      </Td>
                      <Td className="tnum whitespace-nowrap text-right font-mono text-ink-secondary">
                        {bytes(d.byteSize ?? 0)}
                      </Td>
                      <Td className="tnum whitespace-nowrap font-mono text-2xs text-ink-secondary">
                        {d.uploadedAt.slice(0, 10)}
                      </Td>
                      <Td>
                        {d.approvedAt ? <Chip tone="complete">Approved</Chip> : <Chip tone="progress">Unapproved</Chip>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      {flags.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Open flags in this section ({num(flags.length)})</CardTitle></CardHeader>
          <CardBody className="space-y-2">
            {flags.slice(0, 15).map((f) => (
              <div key={f.fingerprint} className="rounded-md border border-hairline px-3 py-2">
                <div className="flex items-center gap-2">
                  <Chip tone={f.severity === 'critical' ? 'critical' : f.severity === 'warning' ? 'progress' : 'info'}>
                    {f.severity}
                  </Chip>
                  <span className="text-xs text-ink">{f.title}</span>
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-ink-muted">{f.detail}</p>
              </div>
            ))}
            {flags.length > 15 && (
              <Link href={`/books/${bookId}/flags`} className="block text-xs text-brand-bright hover:underline">
                See all {num(flags.length)} in the flag queue →
              </Link>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Sign-off</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-secondary">
            Section approval is a two-person control. A QA/QC tech may mark a section ready for
            review but cannot approve it, and no one may approve a section they submitted
            themselves. The rule is enforced in the database, so it holds for any caller — not
            only for this screen.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={section.status === 'approved'}>
              Mark ready for review
            </Button>
            <Button variant="primary" disabled={!canApprove || isOwnSubmission || section.status === 'na'}>
              Approve section
            </Button>
            {!canApprove && (
              <span className="text-2xs text-ink-muted">
                Approval requires a QA/QC Manager or Admin.
              </span>
            )}
            {isOwnSubmission && (
              <span className="text-2xs text-status-progress">
                You submitted this section, so you cannot approve it.
              </span>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
