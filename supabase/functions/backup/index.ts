/**
 * The nightly backup, from inside Supabase.
 *
 * Supabase's own backups are a rolling window of days. §15 retention is
 * years, and the two are not the same promise: a document deleted in
 * March is gone from a seven-day window by April while the standard still
 * requires it. This writes the cold copy that outlives the window, into
 * SharePoint, in the folder shape the books arrived in — one folder per
 * book, numbered section folders inside. Somebody opening it in Explorer
 * on the worst day sees what they have always had.
 *
 * ## Why it runs here rather than on Vercel
 *
 * It reads every document in every book, so it cannot run under any one
 * person's session — it needs the service role. DEPLOY.md says of the web
 * deployment: "If a SUPABASE_SERVICE_ROLE_KEY is already set on the
 * deployment from an earlier setup, clear it." Running here keeps that
 * true, and the Graph secret sits beside it rather than in a third place.
 *
 * ## Why a run is bounded and repeatable
 *
 * One facility book is roughly 850MB. An Edge Function has minutes, not
 * hours, so a run that tried to finish the whole archive would be killed
 * partway every night and never converge. Instead each invocation does a
 * bounded amount of work, records exactly what it wrote, and stops. The
 * next invocation picks up what is still missing, because `backup_object`
 * knows what is already there. Schedule it as often as you like; it
 * converges and then costs almost nothing, because a night with no
 * changes writes nothing.
 *
 * ## What decides that a file needs writing
 *
 * Its sha256. Comparing timestamps would re-upload a book every time a
 * row was touched for an unrelated reason; comparing nothing would miss a
 * document replaced by one of the same size.
 *
 * ## What this never does
 *
 * Delete. A replaced document is moved into `_superseded/<date>/` and
 * kept. A backup that can remove things is a backup that can be told to
 * remove things.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { Graph, graphConfigFromEnv } from './graph.ts'
// One file, two runtimes — the same split `_shared/digest.ts` uses, and
// for the same reason. A second copy would drift, and the backup folder
// and the screen would come to disagree about where a document lives.
import {
  documentPath, joinPath, pathTooLong, supersededPath,
} from '../_shared/backupPaths.ts'
import { redactCredentials } from '../_shared/redact.ts'

const BUCKET = 'job-book-documents'

/** Per invocation. Comfortably inside an Edge Function's wall clock even
 *  when every file is a large one, and the run resumes next time. */
const MAX_FILES = Number(Deno.env.get('BACKUP_MAX_FILES') ?? 150)
const MAX_BYTES = Number(Deno.env.get('BACKUP_MAX_BYTES') ?? 400 * 1024 * 1024)

interface DocRow {
  id: string
  job_book_id: string
  section_id: string | null
  original_filename: string
  storage_path: string
  sha256: string
  byte_size: number | null
}

Deno.serve(async (req) => {
  // An Edge Function is a public URL and `verify_jwt` is off, because
  // pg_cron has no user session to present a JWT for. The shared secret
  // is what stands in for that.
  //
  // Unset means refuse, never "open" — the same rule the digest follows.
  // Treating an absent secret as no gate is how a public URL that writes
  // a tenant's whole archive ends up callable by anyone who learns it.
  const secret = Deno.env.get('BACKUP_SECRET')
  if (!secret || req.headers.get('x-backup-secret') !== secret) {
    return new Response(
      secret ? 'Forbidden' : 'BACKUP_SECRET is not set; refusing to run.',
      { status: 403 },
    )
  }

  const cfg = graphConfigFromEnv()
  if ('error' in cfg) {
    // A configuration problem is reported as a failed run rather than a
    // silent no-op, because an absence of runs is the alarm and a backup
    // that never starts must not look like one that had nothing to do.
    return await recordFailure(cfg.error)
  }

  /** What gets written into `backup_run.error`, with this run's own
   *  credentials taken back out. See `_shared/redact.ts` for why. */
  const redact = (e: unknown): string =>
    redactCredentials(String(e), [cfg.clientSecret, secret])

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: run } = await supabase
    .from('backup_run').insert({ status: 'running' }).select('id').single()
  const runId = run?.id as string

  const detail: Record<string, string>[] = []
  let written = 0, skipped = 0, failed = 0, bytes = 0

  try {
    const graph = await Graph.connect(cfg)
    await graph.driveId() // fails loudly here if the per-site grant is missing

    const [{ data: books }, { data: sections }, { data: defs }] = await Promise.all([
      supabase.from('job_book').select('id, job_number, facility_name, drill_pad_name')
        .is('deleted_at', null),
      supabase.from('job_book_section').select('id, job_book_id, section_definition_id'),
      supabase.from('section_definition').select('id, section_number, title'),
    ])

    const bookById = new Map((books ?? []).map((b) => [b.id as string, {
      code: b.job_number as string,
      name: (b.facility_name ?? b.drill_pad_name ?? b.job_number) as string,
    }]))
    const defById = new Map((defs ?? []).map((d) => [d.id as string, d]))
    const sectionById = new Map((sections ?? []).map((s) => {
      const def = defById.get(s.section_definition_id as string)
      return [s.id as string, def
        ? { sectionNumber: def.section_number as string, title: def.title as string }
        : null]
    }))

    const { data: docs } = await supabase
      .from('document')
      .select('id, job_book_id, section_id, original_filename, storage_path, sha256, byte_size')
      .is('deleted_at', null)
      .order('uploaded_at')

    // What is already in place, by source. A document whose hash matches
    // the live backup row is already there and costs nothing tonight.
    const { data: existing } = await supabase
      .from('backup_object')
      .select('id, source_key, remote_path, sha256')
      .eq('kind', 'document')
      .is('superseded_at', null)
    const liveBySource = new Map(
      (existing ?? []).map((o) => [o.source_key as string, o]),
    )

    for (const doc of (docs ?? []) as DocRow[]) {
      if (written >= MAX_FILES || bytes >= MAX_BYTES) {
        detail.push({ note: 'Reached this run\'s limit; the rest goes next run.' })
        break
      }

      const book = bookById.get(doc.job_book_id)
      if (!book) { skipped += 1; continue }

      const prior = liveBySource.get(doc.id)
      if (prior && prior.sha256 === doc.sha256) { skipped += 1; continue }

      const plan = documentPath(
        book, sectionById.get(doc.section_id ?? '') ?? null, doc.original_filename,
      )
      const remotePath = joinPath(plan)

      if (pathTooLong(plan)) {
        // Reported, never truncated: two documents fighting over one
        // shortened name is worse than one that did not get written.
        failed += 1
        detail.push({ document: doc.id, error: `Path is too long for SharePoint: ${remotePath}` })
        continue
      }

      try {
        // A changed document: move the copy already there aside first, so
        // the previous version survives under _superseded.
        if (prior) {
          const aside = supersededPath(book, doc.original_filename, new Date().toISOString())
          await graph.moveAside(prior.remote_path as string, joinPath(aside))
          await supabase.from('backup_object')
            .update({ superseded_at: new Date().toISOString(), remote_path: joinPath(aside) })
            .eq('id', prior.id as string)
        }

        const file = await supabase.storage.from(BUCKET).download(doc.storage_path)
        if (file.error || !file.data) {
          failed += 1
          detail.push({ document: doc.id, error: `Not in storage: ${file.error?.message ?? 'no body'}` })
          continue
        }

        const size = doc.byte_size ?? file.data.size
        await graph.ensureFolder(plan.folders.join('/'))
        await graph.upload(remotePath, file.data.stream(), size)

        await supabase.from('backup_object').insert({
          kind: 'document',
          source_key: doc.id,
          job_book_id: doc.job_book_id,
          remote_path: remotePath,
          sha256: doc.sha256,
          byte_size: size,
        })

        written += 1
        bytes += size
      } catch (e) {
        // One bad file does not end the night. The rest of the archive is
        // still worth writing, and this one is named in the run detail.
        failed += 1
        detail.push({ document: doc.id, path: remotePath, error: redact(e) })
      }
    }

    await supabase.from('backup_run').update({
      finished_at: new Date().toISOString(),
      status: failed > 0 ? 'partial' : 'ok',
      files_written: written, files_skipped: skipped, files_failed: failed,
      bytes_written: bytes,
      detail: detail.length > 0 ? detail : null,
    }).eq('id', runId)

    return Response.json({ ok: true, written, skipped, failed, bytes })
  } catch (e) {
    await supabase.from('backup_run').update({
      finished_at: new Date().toISOString(),
      status: 'failed',
      files_written: written, files_skipped: skipped, files_failed: failed,
      bytes_written: bytes,
      error: redact(e),
      detail: detail.length > 0 ? detail : null,
    }).eq('id', runId)
    return Response.json({ ok: false, error: redact(e) }, { status: 500 })
  }

  async function recordFailure(error: string): Promise<Response> {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    await sb.from('backup_run').insert({
      status: 'failed', finished_at: new Date().toISOString(), error,
    })
    return Response.json({ ok: false, error }, { status: 503 })
  }
})
