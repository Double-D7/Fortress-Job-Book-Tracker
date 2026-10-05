import { redirect } from 'next/navigation'
import { CredentialFiler } from '@/components/CredentialFiler'
import { PersonnelLibrary } from '@/components/PersonnelLibrary'
import { SectionHeading } from '@/components/ui/primitives'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { can } from '@/lib/domain/roles'

export const dynamic = 'force-dynamic'

export default async function CredentialsPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')

  const { q } = await searchParams
  const search = (q ?? '').trim()
  const provider = getDataProvider()
  const canManage = can(viewer.role, 'edit_records')
  const [entries, rosters] = await Promise.all([
    provider.listPersonnelLibrary(viewer, search || undefined),
    provider.listCredentialRosters(viewer),
  ])

  return (
    <>
      <SectionHeading
        title="Personnel credentials"
        subtitle="Every CWI and NDT card on file, shared by every job book. A card follows the person onto each book they work (§7, §8)"
      />
      {canManage && (
        <div className="mb-4">
          <CredentialFiler cwis={rosters.cwis} technicians={rosters.technicians} />
        </div>
      )}
      <PersonnelLibrary
        entries={entries}
        canManage={canManage}
        search={search}
      />
    </>
  )
}
