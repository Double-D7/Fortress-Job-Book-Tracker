import { redirect } from 'next/navigation'
import { MtrLibrary } from '@/components/MtrLibrary'
import { SectionHeading } from '@/components/ui/primitives'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { can } from '@/lib/domain/roles'

export const dynamic = 'force-dynamic'

export default async function MtrPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')

  const { q } = await searchParams
  const search = (q ?? '').trim()
  const entries = await getDataProvider().listMtrLibrary(viewer, search || undefined)

  return (
    <>
      <SectionHeading
        title="Mill certificates"
        subtitle="One certificate per heat number, shared by every job book (§15)"
      />
      <MtrLibrary
        entries={entries}
        canUpload={can(viewer.role, 'edit_records')}
        search={search}
      />
    </>
  )
}
