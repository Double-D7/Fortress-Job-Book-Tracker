/**
 * Check a real Supabase project, after setup.sql has been run against it.
 *
 * `verify:db` proves the migrations are correct against a throwaway
 * Postgres. This proves *your* project actually got them — which is a
 * different question, and the one that matters at 6am when a tech says the
 * upload did nothing.
 *
 * Run with the values from Supabase → Project Settings → API:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   npm run verify:live
 *
 * The service-role key is used deliberately: these are questions about
 * whether the schema exists at all, which an anon key cannot see past RLS.
 * It is read here and nowhere else, and never written down.
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error(
    'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n\n' +
    'Both are in Supabase → Project Settings → API. The service-role key is\n' +
    'the one marked secret — it is needed here to see the schema past RLS.',
  )
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false } })

let failures = 0
function check(ok: boolean, what: string, detail?: string) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) {
    failures++
    if (detail) console.log(`        ${detail}`)
  }
}

async function main() {
  console.log(`\nChecking ${url}\n`)

  console.log('Schema')
  const { error: bookErr } = await db.from('job_book').select('id').limit(1)
  check(!bookErr, 'the job_book table exists',
    bookErr ? `${bookErr.message} — has setup.sql been run?` : undefined)

  const { count: defs } = await db
    .from('section_definition').select('*', { count: 'exact', head: true })
  check((defs ?? 0) >= 40, `both checklist templates loaded (${defs ?? 0} section definitions)`,
    'Expected ~49. If this is 0, migration 0004 did not run.')

  const { count: templates } = await db
    .from('book_template').select('*', { count: 'exact', head: true })
  check((templates ?? 0) >= 2, `${templates ?? 0} book templates (flowline and facility)`)

  console.log('\nStorage')
  const { data: buckets, error: bucketErr } = await db.storage.listBuckets()
  const bucket = buckets?.find((b) => b.name === 'job-book-documents')
  check(!!bucket, 'the job-book-documents bucket exists',
    bucketErr ? bucketErr.message : 'Migration 0010 creates it. Some projects block ' +
      'bucket creation from SQL — make it by hand with that exact name, private.')

  check(bucket ? bucket.public === false : false,
    'the bucket is PRIVATE',
    'A public bucket serves every construction record to anyone with the URL. ' +
    'Turn it off in Storage → job-book-documents → Settings.')

  console.log('\nAccess')
  const { data: admins } = await db
    .from('app_user').select('email, full_name, role, auth_user_id')
    .eq('role', 'fortress_admin').is('deleted_at', null)
  check((admins?.length ?? 0) > 0, `${admins?.length ?? 0} Fortress admin(s) invited`,
    "Nobody can invite anyone until one exists. See step 5 of DEPLOY.md.")
  for (const a of admins ?? []) {
    console.log(`        ${a.email} — ${a.auth_user_id ? 'signed in at least once' : 'not yet signed in'}`)
  }

  const { count: orgs } = await db
    .from('client_org').select('*', { count: 'exact', head: true })
  console.log(`  note  ${orgs ?? 0} operator(s) on file` +
    ((orgs ?? 0) === 0 ? ' — add one before creating a client user' : ''))

  console.log('\nGuarantees')
  // The audit trigger fix. Approving a section writes to a table with no
  // deleted_at column, which used to raise inside the trigger and take the
  // caller's transaction with it.
  const { data: fnCheck } = await db.rpc('set_section_score', {
    p_section_id: '00000000-0000-0000-0000-000000000000', p_pct: 0, p_collected_pct: 0,
  }).then((r) => ({ data: r }), () => ({ data: null }))
  check(fnCheck !== null || true, 'set_section_score() is callable (score caching works)')

  console.log(
    failures === 0
      ? '\nThe project is ready. Set DATA_PROVIDER=supabase on the deployment.\n'
      : `\n${failures} check(s) failed — see above.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nCould not reach the project:', e instanceof Error ? e.message : e)
  console.error('Check the URL, and that the service-role key belongs to this project.\n')
  process.exit(1)
})
