import { Suspense } from 'react'
import { LoginForm } from '@/components/LoginForm'
import { providerKind } from '@/lib/data/provider'

export const dynamic = 'force-dynamic'

export default function LoginPage() {
  // Seed mode has no database and no auth. The form says so rather than
  // offering a sign-in that cannot go anywhere.
  return (
    <Suspense>
      <LoginForm configured={providerKind() === 'supabase'} />
    </Suspense>
  )
}
