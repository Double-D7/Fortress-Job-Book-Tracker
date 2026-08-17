/**
 * Server-side Supabase client.
 *
 * Every query issued through this client carries the caller's session, so
 * Row Level Security is in force. That is deliberate and non-negotiable:
 * client isolation and inspector scoping are database guarantees, and a
 * query that bypasses them is a query that bypasses the whole security
 * model.
 *
 * The service-role key is NOT used here. It exists for migrations and for
 * the storage signing path in `storage.ts`, and using it to serve a page
 * would silently disable every policy in `0003_rls.sql`.
 */
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Viewer } from '@/lib/data/provider'
import type { UserRole } from '@/lib/domain/types'

export async function createClient() {
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required for the ' +
      'supabase data provider. Set DATA_PROVIDER=seed to run against the DP452 reference book.',
    )
  }
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options as never)
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Session refresh happens in middleware instead.
        }
      },
    },
  })
}

/**
 * Resolve the signed-in viewer from `app_user`.
 *
 * Returns null rather than throwing when there is no session: an
 * unauthenticated caller sees the sign-in page, not an error. There is no
 * anonymous read path anywhere in this application.
 */
export async function getViewer(): Promise<Viewer | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('app_user')
    .select('id, email, full_name, role, client_org_id')
    .eq('auth_user_id', user.id)
    .is('deleted_at', null)
    .eq('is_active', true)
    .single()
  if (!data) return null

  return {
    id: data.id as string,
    email: data.email as string,
    fullName: data.full_name as string,
    role: data.role as UserRole,
    clientOrgId: (data.client_org_id as string | null) ?? null,
  }
}
