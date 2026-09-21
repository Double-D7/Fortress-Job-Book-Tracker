import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { redirect } from 'next/navigation'
import { scopePrompts } from '@/lib/domain/scaffold'
import { NewJobBookWizard } from '@/components/NewJobBookWizard'

export const dynamic = 'force-dynamic'

export default async function NewJobBookPage() {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const orgs = await getDataProvider().listClientOrgs(viewer)
  return (
    <NewJobBookWizard
      orgs={orgs}
      flowlinePrompts={scopePrompts('flowline')}
      facilityPrompts={scopePrompts('facility')}
      canCreate={viewer.role === 'qaqc_manager' || viewer.role === 'fortress_admin'}
    />
  )
}
