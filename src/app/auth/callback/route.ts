/**
 * Where a sign-in link lands.
 *
 * Supabase sends the browser here with a one-time `code`; this exchanges it
 * for a session and writes the cookies. Until that happens the visitor is
 * authenticated with Supabase but has no session on this origin, so every
 * page would bounce them back to sign-in — which is precisely the loop this
 * route exists to close.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')

  // Carried through the round trip so a tech following a link to section 14
  // lands on section 14 rather than the dashboard.
  const next = url.searchParams.get('next') ?? '/'
  // Only same-origin paths. An open redirect on a sign-in callback hands an
  // attacker a link that looks like yours and ends somewhere else.
  const target = next.startsWith('/') && !next.startsWith('//') ? next : '/'

  const fail = (reason: string) => {
    const back = new URL('/login', url.origin)
    back.searchParams.set('error', reason)
    return NextResponse.redirect(back)
  }

  if (!code) {
    // Supabase reports its own failures here rather than in the exchange.
    const described = url.searchParams.get('error_description')
    return fail(described ?? 'That sign-in link was not valid. Ask for a new one.')
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return fail(
      /expired|invalid/i.test(error.message)
        ? 'That link has expired or was already used. Sign-in links work once, within the hour.'
        : error.message,
    )
  }

  return NextResponse.redirect(new URL(target, url.origin))
}
