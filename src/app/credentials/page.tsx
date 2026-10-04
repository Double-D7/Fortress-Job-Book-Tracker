import { redirect } from 'next/navigation'
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
  const entries = await getDataProvider().listPersonnelLibrary(viewer, search || undefined)

  return (
    <>
      <SectionHeading
        title="Personnel credentials"
        subtitle="Every CWI and NDT card on file, shared by every job book. A card follows the person onto each book they work (§7, §8)"
      />
      <PersonnelLibrary
        entries={entries}
        canManage={can(viewer.role, 'edit_records')}
        search={search}
      />
    </>
  )
}
