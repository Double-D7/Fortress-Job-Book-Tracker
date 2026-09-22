import Link from 'next/link'
import { notFound, redirect} from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { collectedOf, scoreSection } from '@/lib/domain/scoring'
import type { JobBookBundle } from '@/lib/domain/types'
import { evaluateFlags } from '@/lib/domain/flags'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, ProgressBar,
  Table, Td, Th, Tr, bandTone,
} from '@/components/ui/primitives'
import { SectionSignOff } from '@/components/SectionSignOff'
import { SectionUpload } from '@/components/SectionUpload'
import { OverviewImport } from '@/components/OverviewImport'
import { WeldLogImport } from '@/components/WeldLogImport'
import { TorqueLogImport } from '@/components/TorqueLogImport'
import { registerForSection } from '@/lib/domain/upload'
import { bytes, num, pct } from '@/lib/utils'

export const dynamic = 'force-dynamic'

/** Mirrors the RLS write predicate; the database remains the control. */
const CAN_UPLOAD = new Set(['fortress_admin', 'qaqc_manager', 'qaqc_tech'])

const REGISTER_LABELS: Record<string, string> = {
  material_heat: 'Heat number', torque_wrench: 'Wrench ID', welder: 'Welder stamp',
  cwi: 'CWI', ndt_technician: 'NDT technician', nde_report: 'Report number',
  pressure_test: 'Test number', isometric: 'Isometric', weld_line: 'Line',
  cp_test_point: 'Test point', ut_reading: 'Location', construction_area: 'Construction area',
}

/**
 * The controlled register a section's identifier is picked from.
 *
 * §9.1: "Every reference to a welder, an inspector, a technician, a wrench,
 * a heat or a drawing resolves to a register entry. Identity is never
 * inferred from a filename and never entered as free text." A dropdown is
 * that rule made unavoidable.
 */
function registerKeysFor(sectionNumber: string, b: JobBookBundle) {
  switch (registerForSection(sectionNumber)) {
    case 'material_heat':
      return b.materialHeats.map((h) => ({ value: h.heatNumber, label: h.heatNumber }))
    case 'torque_wrench':
      return b.torqueWrenches.map((w) => ({ value: w.wrenchId, label: w.wrenchId }))
    case 'welder':
      return b.welders.map((w) => ({ value: w.initials, label: `${w.initials} — ${w.fullName}` }))
    case 'cwi':
      return b.cwis.map((c) => ({ value: c.initials, label: `${c.initials} — ${c.fullName}` }))
    case 'ndt_technician':
      return b.ndtTechnicians.map((t) => ({
        value: t.initials ?? t.fullName, label: t.fullName }))
    case 'nde_report':
      return b.ndeReports.map((r) => ({
        value: r.reportNumber ?? r.id.slice(0, 8), label: r.reportNumber ?? r.id.slice(0, 8) }))
    case 'pressure_test':
      return b.pressureTests.map((t) => ({ value: t.testIdentifier, label: t.testIdentifier }))
    case 'weld_line':
      return b.weldLines.map((l) => ({ value: l.lineCode, label: l.lineCode }))
    case 'construction_area':
      return (b.book.constructionAreas ?? []).map((a) => ({ value: a, label: a }))
    case 'isometric': {
      // No isometric register exists yet, so this offers what the records
      // actually reference rather than an empty list.
      const isos = new Set<string>()
      for (const w of b.welds) if (w.isometricNumber) isos.add(w.isometricNumber)
      for (const c of b.torqueConnections) if (c.isoNumber) isos.add(c.isoNumber)
      return [...isos].sort().map((i) => ({ value: i, label: i }))
    }
    default:
      return []
  }
}

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
        registerLabel={REGISTER_LABELS[registerForSection(number) ?? ''] ?? 'Identifier'}
        registerKeys={registerKeysFor(number, b)}
      />

      {/*
        The overview sheet is the one document in the book that is also a
        dataset: it carries the whole welder roster with stamps and WPQ
        expiry dates. Filing it as a PDF and stopping there is how a book
        ends up with a populated §11 and an empty welder register.
      */}
      {number === '11' && (
        <OverviewImport bookId={bookId} canUpload={CAN_UPLOAD.has(viewer.role)} />
      )}

      {/*
        §12 is the population every other integrity claim resolves to — a
        weld's welder, its date, its inspection. Holding it as a PDF and
        stopping there is why the weld grid, the qualification checks and
        the tier rules had nothing to read.
      */}
      {number === '12' && (
        <WeldLogImport bookId={bookId} canUpload={CAN_UPLOAD.has(viewer.role)} />
      )}

      {/*
        §14's wrench ids are what make §11.1 answerable: a connection
        torqued with an uncalibrated wrench is a Critical finding, and
        with the log held as a PDF there was nothing to check it against.
        Every torque rule in the flags engine ran over an empty set.
      */}
      {number === '14' && (
        <TorqueLogImport bookId={bookId} canUpload={CAN_UPLOAD.has(viewer.role)} />
      )}

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
            <div className="max-h-[460px] overflow-auto">
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
          <SectionSignOff
            bookId={bookId}
            sectionNumber={number}
            status={section.status}
            canApprove={canApprove}
            isOwnSubmission={isOwnSubmission}
          />
        </CardBody>
      </Card>
    </div>
  )
}
