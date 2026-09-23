/**
 * Session refresh, and the gate in front of every page.
 *
 * Supabase access tokens are short-lived. A Server Component cannot write
 * cookies, so without a middleware pass the refreshed token is computed and
 * then thrown away, and a tech filling in a section gets signed out
 * mid-upload. This runs before the request reaches a page, refreshes the
 * session, and writes the new cookies on the response.
 *
 * It is a gate, not *the* gate. Row Level Security is what actually keeps
 * one operator out of another's book, and it holds whether or not this file
 * is correct — `supabase/tests/security.sql` proves it against a real
 * Postgres. What this adds is that an unauthenticated visitor gets the
 * sign-in page instead of an empty dashboard that looks like a job book
 * with nothing in it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { canonicalTarget } from '@/lib/domain/canonicalHost'

/** Reachable with no session. Everything else requires one. */
const PUBLIC_PATHS = ['/login', '/auth/callback', '/auth/signout']

export async function middleware(request: NextRequest) {
  // Before anything else, including any call to Supabase: a request that
  // is about to be sent to another hostname should not first spend a round
  // trip revalidating a session that hostname cannot see anyway.
  //
  // 308 rather than 302 so a POST to an API route keeps its method and its
  // body. A 302 would silently turn an upload into a GET.
  const moved = canonicalTarget({
    host: request.headers.get('host'),
    path: request.nextUrl.pathname,
    search: request.nextUrl.search,
    canonicalHost: process.env.CANONICAL_HOST,
    isProduction: process.env.VERCEL_ENV === 'production',
  })
  if (moved) return NextResponse.redirect(moved, 308)

  // Seed mode has no auth and no database. Gating it would lock everyone
  // out of the demo, and there is nothing behind the gate to protect.
  if (process.env.DATA_PROVIDER !== 'supabase') return NextResponse.next()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.next()

  let response = NextResponse.next({ request })

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        for (const { name, value } of list) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of list) response.cookies.set(name, value, options as never)
      },
    },
  })

  // `getUser` revalidates against the auth server rather than trusting the
  // cookie's contents. `getSession` would read a token the browser could
  // have edited, which is not a basis for deciding what to render.
  const { data: { user } } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))

  if (!user && !isPublic) {
    const signIn = request.nextUrl.clone()
    signIn.pathname = '/login'
    // Carried so a deep link survives the round trip: a tech following a
    // link to section 14 lands on section 14, not on the dashboard.
    signIn.searchParams.set('next', path + request.nextUrl.search)
    return NextResponse.redirect(signIn)
  }
  if (user && path === '/login') {
    const home = request.nextUrl.clone()
    home.pathname = '/'
    home.search = ''
    return NextResponse.redirect(home)
  }

  return response
}

export const config = {
  // Everything except Next's own assets and the favicon. API routes are
  // deliberately included: they need the refreshed session too, and each
  // one re-checks the viewer itself.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
