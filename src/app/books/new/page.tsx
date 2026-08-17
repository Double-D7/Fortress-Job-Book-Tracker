import { DEMO_VIEWER, getDataProvider } from '@/lib/data/provider'
import { scopePrompts } from '@/lib/domain/scaffold'
import { NewJobBookWizard } from '@/components/NewJobBookWizard'

export const dynamic = 'force-dynamic'

export default async function NewJobBookPage() {
  const orgs = await getDataProvider().listClientOrgs(DEMO_VIEWER)
  return (
    <NewJobBookWizard
      orgs={orgs}
      flowlinePrompts={scopePrompts('flowline')}
      facilityPrompts={scopePrompts('facility')}
      canCreate={DEMO_VIEWER.role === 'qaqc_manager' || DEMO_VIEWER.role === 'fortress_admin'}
    />
  )
}
