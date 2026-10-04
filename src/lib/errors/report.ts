/**
 * Recording a failure, from wherever it happened.
 *
 * Deliberately best-effort and deliberately silent about its own
 * problems. This runs on the path where something has already gone
 * wrong, and an error reporter that throws turns one broken page into
 * two, or into a loop where the report of a failure is itself a
 * failure. Every call here either records something or gives up.
 *
 * It talks to Postgres rather than to a reporting service because this
 * deployment already has a database, already has RLS to decide who may
 * read the result, and must not hold another vendor's credential — the
 * web deployment deliberately carries no powerful secret.
 */
import { createClient } from '@supabase/supabase-js'
import {
  fingerprintError, referenceCode, topAppFrame, type ErrorShape,
} from '@/lib/domain/errorReport'
import { redactCredentials } from '../../../supabase/functions/_shared/redact'

/** How long a group stays quiet after being reported. */
const NOTIFY_AFTER_MINUTES = 60

/**
 * A client with no session, used on purpose.
 *
 * The caller may have no cookies — an error on the sign-in screen is the
 * one most worth hearing about — and `report_error` takes no identity
 * from its arguments, so there is nothing to gain by presenting one.
 */
function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

/**
 * Values that must never ride along in a message.
 *
 * Postgres connection strings and keys turn up in driver errors, and an
 * error table is read by more people than hold those secrets. The same
 * reasoning, and the same helper, as the backup's run rows.
 */
function credentials(): (string | undefined)[] {
  return [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.RESEND_API_KEY,
  ]
}

export interface ReportResult {
  reference: string
  occurrences: number
  shouldNotify: boolean
}

/**
 * Record one failure and say whether it is worth an alert.
 *
 * Returns null when nothing could be recorded, which the caller should
 * treat as "no reference to show" rather than as a second failure.
 */
export async function reportError(shape: ErrorShape): Promise<ReportResult | null> {
  try {
    const fingerprint = fingerprintError(shape)
    const reference = referenceCode(fingerprint)
    const supabase = anonClient()
    if (!supabase) return { reference, occurrences: 1, shouldNotify: false }

    const { data, error } = await supabase.rpc('report_error', {
      p_fingerprint: fingerprint,
      p_reference: reference,
      p_error_name: shape.name || 'Error',
      p_message: redactCredentials(shape.message ?? '', credentials()),
      p_route: shape.route ?? null,
      p_app_frame: topAppFrame(shape.stack),
      p_notify_after_minutes: NOTIFY_AFTER_MINUTES,
    })
    if (error) return { reference, occurrences: 1, shouldNotify: false }

    const row = Array.isArray(data) ? data[0] : data
    return {
      reference: (row?.reference as string) ?? reference,
      occurrences: (row?.occurrences as number) ?? 1,
      shouldNotify: Boolean(row?.should_notify),
    }
  } catch {
    // Nothing is rethrown. A reporter that fails loudly on the error
    // path is worse than one that fails quietly.
    return null
  }
}
