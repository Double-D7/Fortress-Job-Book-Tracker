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
 * ## What it copies
 *
 * Every filed document, and the shared mill certificate library. The
 * library is not attached to any one book — the certificate for a heat is
 * the same certificate wherever that heat was welded — so it goes to
 * `_library/` once rather than being duplicated into every book that used
 * it.
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
 * ## Why documents and certificates share one loop
 *
 * They are the same job: hash, compare, move the old copy aside, upload,
 * record. Two loops would be two implementations of superseding, and the
 * one exercised less often would be the one that quietly stopped keeping
 * the previous version. Only the path differs, and that is decided in
 * `_shared/backupPaths.ts` for both.
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
  documentPath, joinPath, libraryPath, librarySupersededPath, pathTooLong,
  supersededPath, type PlannedFile,
} from '../_shared/backupPaths.ts'
import { redactCredentials } from '../_shared/redact.ts'

const BUCKET = 'job-book-documents'

/** Per invocation. Comfortably inside an Edge Function's wall clock even
 *  when every file is a large one, and the run resumes next time. */
const MAX_FILES = Number(Deno.env.get('BACKUP_MAX_FILES') ?? 150)
const MAX_BYTES = Number(Deno.env.get('BACKUP_MAX_BYTES') ?? 400 * 1024 * 1024)

/** Enough to recognise which documents are affected without turning the
 *  run row into a list of every one of them. */
const MAX_EXAMPLES = 5

interface DocRow {
  id: string
  job_book_id: string
  section_id: string | null
  original_filename: string
  storage_path: string
  sha256: string
  byte_size: number | null
}

interface MtrRow {
  id: string
  original_filename: string
  storage_path: string
  sha256: string
  byte_size: number | null
}

/** One file to copy, with everywhere it might go already decided. */
interface Item {
  kind: 'document' | 'mtr'
  id: string
  storagePath: string
  sha256: string
  byteSize: number | null
  filename: string
  jobBookId: string | null
  plan: PlannedFile
  /** Where the copy already in place goes when this one replaces it. */
  aside: (supersededOn: string) => PlannedFile
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
  let written = 0, skipped = 0, failed = 0, missing = 0, bytes = 0
  const missingExamples: string[] = []

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

    const [{ data: docs }, { data: mtrs }, { data: existing }] = await Promise.all([
      supabase.from('document')
        .select('id, job_book_id, section_id, original_filename, storage_path, sha256, byte_size')
        .is('deleted_at', null)
        .order('uploaded_at'),
      supabase.from('mtr_document')
        .select('id, original_filename, storage_path, sha256, byte_size')
        .is('deleted_at', null)
        .order('uploaded_at'),
      // What is already in place, by source. Keyed on kind as well as the
      // key, because a document and a certificate are separate rows that
      // could in principle carry the same identifier.
      supabase.from('backup_object')
        .select('id, kind, source_key, remote_path, sha256')
        .is('superseded_at', null),
    ])

    const liveBySource = new Map(
      (existing ?? []).map((o) => [`${o.kind}:${o.source_key}`, o]),
    )

    const items: Item[] = []

    for (const doc of (docs ?? []) as DocRow[]) {
      const book = bookById.get(doc.job_book_id)
      // A document whose book is gone has nowhere to be filed. Counted as
      // skipped rather than failed: there is nothing to retry.
      if (!book) { skipped += 1; continue }
      items.push({
        kind: 'document',
        id: doc.id,
        storagePath: doc.storage_path,
        sha256: doc.sha256,
        byteSize: doc.byte_size,
        filename: doc.original_filename,
        jobBookId: doc.job_book_id,
        plan: documentPath(
          book, sectionById.get(doc.section_id ?? '') ?? null, doc.original_filename,
        ),
        aside: (on) => supersededPath(book, doc.original_filename, on),
      })
    }

    for (const mtr of (mtrs ?? []) as MtrRow[]) {
      items.push({
        kind: 'mtr',
        id: mtr.id,
        storagePath: mtr.storage_path,
        sha256: mtr.sha256,
        byteSize: mtr.byte_size,
        filename: mtr.original_filename,
        jobBookId: null,
        plan: libraryPath(mtr.original_filename),
        aside: (on) => librarySupersededPath(mtr.original_filename, on),
      })
    }

    for (const item of items) {
      if (written >= MAX_FILES || bytes >= MAX_BYTES) {
        detail.push({ note: 'Reached this run\'s limit; the rest goes next run.' })
        break
      }

      const prior = liveBySource.get(`${item.kind}:${item.id}`)
      if (prior && prior.sha256 === item.sha256) { skipped += 1; continue }

      const remotePath = joinPath(item.plan)

      if (pathTooLong(item.plan)) {
        // Reported, never truncated: two documents fighting over one
        // shortened name is worse than one that did not get written.
        failed += 1
        detail.push({ [item.kind]: item.id, error: `Path is too long for SharePoint: ${remotePath}` })
        continue
      }

      try {
        const file = await supabase.storage.from(BUCKET).download(item.storagePath)
        if (file.error || !file.data) {
          // The application lists this file and has no bytes for it. That
          // is a hole in the catalogue, not a backup failure — nothing
          // here can fix it and retrying nightly never will. Counted
          // apart so it cannot turn every run amber and bury a real
          // upload failure underneath a hundred identical entries.
          missing += 1
          if (missingExamples.length < MAX_EXAMPLES) missingExamples.push(item.filename)
          continue
        }

        // Only once the bytes are in hand: a replaced file's previous
        // version is moved aside, so the live path is free. Doing this
        // before the download would move a copy aside to make room for
        // something that then turned out not to exist.
        if (prior) {
          const aside = joinPath(item.aside(new Date().toISOString()))
          await graph.moveAside(prior.remote_path as string, aside)
          await supabase.from('backup_object')
            .update({ superseded_at: new Date().toISOString(), remote_path: aside })
            .eq('id', prior.id as string)
        }

        const size = item.byteSize ?? file.data.size
        await graph.ensureFolder(item.plan.folders.join('/'))
        await graph.upload(remotePath, file.data.stream(), size)

        await supabase.from('backup_object').insert({
          kind: item.kind,
          source_key: item.id,
          job_book_id: item.jobBookId,
          remote_path: remotePath,
          sha256: item.sha256,
          byte_size: size,
        })

        written += 1
        bytes += size
      } catch (e) {
        // One bad file does not end the night. The rest of the archive is
        // still worth writing, and this one is named in the run detail.
        failed += 1
        detail.push({ [item.kind]: item.id, path: remotePath, error: redact(e) })
      }
    }

    if (missing > 0) {
      // One line, not one per file. The count is the finding; a few names
      // are enough to start looking.
      detail.push({
        note: `${missing} ${missing === 1 ? 'file is' : 'files are'} listed by the ` +
          `application with no stored bytes, so there was nothing to copy. ` +
          `This is a gap in the catalogue rather than a backup failure.`,
        examples: missingExamples.join(', '),
      })
    }

    await supabase.from('backup_run').update({
      finished_at: new Date().toISOString(),
      // Missing bytes do not make a run partial. A run that wrote
      // everything it had bytes for did its job, and saying otherwise
      // every night is how a genuine failure stops being noticed.
      status: failed > 0 ? 'partial' : 'ok',
      files_written: written, files_skipped: skipped, files_failed: failed,
      files_missing: missing,
      bytes_written: bytes,
      detail: detail.length > 0 ? detail : null,
    }).eq('id', runId)

    return Response.json({ ok: true, written, skipped, failed, missing, bytes })
  } catch (e) {
    await supabase.from('backup_run').update({
      finished_at: new Date().toISOString(),
      status: 'failed',
      files_written: written, files_skipped: skipped, files_failed: failed,
      files_missing: missing,
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
