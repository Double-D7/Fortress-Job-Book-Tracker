import { Suspense } from 'react'
import { LoginForm } from '@/components/LoginForm'
import { providerKind } from '@/lib/data/provider'

export const dynamic = 'force-dynamic'

export default function LoginPage() {
  // Seed mode has no database and no auth. The form says so rather than
  // offering a sign-in that cannot go anywhere.
  return (
    <Suspense>
      <LoginForm
        configured={providerKind() === 'supabase'}
        // Off unless the Azure provider is actually switched on in
        // Supabase. `signInWithOAuth` navigates away before it can report
        // an unconfigured provider, so the person lands on a raw JSON
        // error page with nothing this application can do about it. A
        // door that only leads there does not belong on the screen.
        microsoftEnabled={process.env.NEXT_PUBLIC_MICROSOFT_SIGNIN === 'on'}
      />
    </Suspense>
  )
}
