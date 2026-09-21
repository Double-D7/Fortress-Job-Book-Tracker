/**
 * Browser-side Supabase client.
 *
 * Only sign-in runs through this. Everything that reads or writes a job
 * book goes through the server client in `server.ts`, where the session
 * cookie is attached and Row Level Security is in force — a browser client
 * holding the publishable key can reach nothing on its own, which is the
 * point of putting the rules in the database.
 */
import { createBrowserClient } from '@supabase/ssr'

/** Null when the app is running in seed mode, where there is no database
 *  and no auth to sign in to. */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createBrowserClient(url, key)
}
