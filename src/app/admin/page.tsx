import { Card, CardBody, CardHeader, CardTitle, Chip, Table, Td, Th, Tr } from '@/components/ui/primitives'
import { buildTemplateSections } from '@/lib/domain/checklist'
import { SectionHeading } from '@/components/ui/primitives'

export const dynamic = 'force-dynamic'

const ROLES = [
  { role: 'Fortress Admin', scope: 'All orgs, all jobs',
    caps: 'Full CRUD · users · templates and weights · client orgs · audit log' },
  { role: 'QA/QC Manager', scope: 'All Fortress jobs',
    caps: 'Create/edit any book · approve sections · resolve flags · issue inspector grants · export' },
  { role: 'QA/QC Tech', scope: 'Assigned jobs only',
    caps: 'Edit records and upload on assigned jobs · mark ready for review · cannot approve own sections' },
  { role: 'Fortress Read-Only', scope: 'All Fortress jobs', caps: 'View everything internal · no edits' },
  { role: 'Client User', scope: 'Own client org only',
    caps: 'View completion · browse and download approved documents · no internal fields' },
  { role: 'Third-Party Inspector', scope: 'Granted books only',
    caps: 'Read-only on approved contents of one book · time-limited · optional comments · every view logged' },
]

export default function AdminPage() {
  const flowline = buildTemplateSections('flowline', 'tpl')
  const facility = buildTemplateSections('facility', 'tpl')

  return (
    <>
      <SectionHeading
        title="Administration"
        subtitle="Roles, section templates and scoring weights"
      />
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Roles and scope</CardTitle></CardHeader>
          <CardBody className="p-0">
            <Table>
              <thead><tr><Th>Role</Th><Th>Scope</Th><Th>Capabilities</Th></tr></thead>
              <tbody>
                {ROLES.map((r) => (
                  <Tr key={r.role}>
                    <Td className="whitespace-nowrap font-medium">{r.role}</Td>
                    <Td className="whitespace-nowrap text-ink-secondary">{r.scope}</Td>
                    <Td className="text-ink-secondary">{r.caps}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Section templates and weights</CardTitle>
            <span className="text-2xs text-ink-muted">
              Versioned, so a score computed last quarter reproduces exactly
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>§</Th><Th>Title</Th><Th>Applies to</Th><Th>Requirement</Th>
                  <Th className="text-right">Flowline weight</Th><Th className="text-right">Facility weight</Th>
                </tr>
              </thead>
              <tbody>
                {flowline.map((s) => {
                  const f = facility.find((x) => x.sectionNumber === s.sectionNumber)
                  return (
                    <Tr key={s.sectionNumber}>
                      <Td className="tnum whitespace-nowrap font-mono text-ink-muted">{s.sectionNumber}</Td>
                      <Td>{s.title}</Td>
                      <Td>
                        <Chip tone={s.appliesTo === 'both' ? 'idle' : 'brand'}>
                          {s.appliesTo}
                        </Chip>
                      </Td>
                      <Td className="text-ink-secondary">{s.requirementType.replace(/_/g, ' ')}</Td>
                      <Td className="tnum text-right font-mono">{s.weight}</Td>
                      <Td className="tnum text-right font-mono text-ink-secondary">{f ? f.weight : '—'}</Td>
                    </Tr>
                  )
                })}
                <tr className="border-t-2 border-hairline bg-surface-raised/50">
                  <Td colSpan={4} className="font-semibold">Total</Td>
                  <Td className="tnum text-right font-mono font-semibold">
                    {flowline.reduce((s, x) => s + x.weight, 0)}
                  </Td>
                  <Td className="tnum text-right font-mono font-semibold">
                    {facility.reduce((s, x) => s + x.weight, 0)}
                  </Td>
                </tr>
              </tbody>
            </Table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Facility book type</CardTitle></CardHeader>
          <CardBody>
            <p className="text-xs leading-relaxed text-ink-secondary">
              The facility checklist has not been published yet. The facility template above is
              scaffolded from the shared 22 sections with sections 19–22 active and the combined
              flowline map absent; its weights mirror the flowline weights with the combined map&apos;s
              6 points redistributed across the four separate map and drawing sections. When the real
              checklist lands, it is a template version bump — new `section_definition` rows against a
              new `book_template` — and no migration. Historical scores continue to resolve against
              the template version they were computed under.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
