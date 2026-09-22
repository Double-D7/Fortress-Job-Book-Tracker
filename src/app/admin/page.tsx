import { redirect } from 'next/navigation'
import { Card, CardBody, CardHeader, CardTitle, Chip, Table, Td, Th, Tr } from '@/components/ui/primitives'
import { buildTemplateSections } from '@/lib/domain/checklist'
import { SectionHeading } from '@/components/ui/primitives'
import { UserAdmin } from '@/components/UserAdmin'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { CAPABILITY_LABELS, ROLES, can } from '@/lib/domain/roles'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  // The directory and the capability matrix are Fortress's own material.
  // A client user reaching this URL is redirected rather than shown an
  // empty table, which would read as "there is nobody here".
  if (!can(viewer.role, 'view_internal')) redirect('/')

  const provider = getDataProvider()
  const [users, orgs] = await Promise.all([
    provider.listUsers(viewer),
    provider.listClientOrgs(viewer),
  ])

  const flowline = buildTemplateSections('flowline', 'tpl')
  const facility = buildTemplateSections('facility', 'tpl')

  return (
    <>
      <SectionHeading
        title="Administration"
        subtitle="People, roles, section templates and scoring weights"
      />
      <div className="space-y-4">
        <UserAdmin
          users={users}
          orgs={orgs}
          canManage={can(viewer.role, 'manage_users')}
          viewerId={viewer.id}
        />

        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>What each role can do</CardTitle>
            <span className="text-2xs text-ink-muted">
              Enforced by the database, not by this table
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <Tr>
                    <Th>Capability</Th>
                    {ROLES.map((r) => (
                      <Th key={r.role} className="text-center">{r.label}</Th>
                    ))}
                  </Tr>
                </thead>
                <tbody>
                  {CAPABILITY_LABELS.map(({ capability, label }) => (
                    <Tr key={capability}>
                      <Td className="whitespace-nowrap text-ink-secondary">{label}</Td>
                      {ROLES.map((r) => (
                        <Td key={r.role} className="text-center">
                          {r.capabilities.has(capability)
                            ? <Chip tone="complete">Yes</Chip>
                            : <span className="text-ink-muted">—</span>}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                  <Tr>
                    <Td className="whitespace-nowrap font-medium">Sees</Td>
                    {ROLES.map((r) => (
                      <Td key={r.role} className="text-center text-2xs text-ink-secondary">
                        {r.scopeLabel}
                      </Td>
                    ))}
                  </Tr>
                </tbody>
              </Table>
            </div>
            <p className="border-t border-hairline px-4 py-3 text-2xs leading-relaxed text-ink-secondary">
              This table is generated from the same capability definitions the interface uses
              to decide which controls to render, and the test suite compares those
              definitions against the Row Level Security predicates in the migrations — so a
              row here that disagrees with the database fails the build rather than
              misleading a reader. Nothing on this screen is the control itself: every write
              is refused again by Postgres, under the caller&rsquo;s own session, whether it
              arrives from these screens or from the API directly. Adding a note is the one
              capability that depends on more than the role, because a Client Inspector needs
              a grant on that particular book which carries the right.
            </p>
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
