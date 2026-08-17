/**
 * Document storage.
 *
 * Job book documents are client-confidential construction records. They are
 * never served from a permanent public URL — every access is a short-lived
 * signed URL, and every access is written to the audit log before the URL
 * is handed out, so a download that happens is a download that was recorded.
 */
import { createClient } from './server'

export const DOCUMENT_BUCKET = 'job-book-documents'
/** Long enough to start a download, short enough that a leaked link is
 *  worthless by the time it is shared. */
export const SIGNED_URL_TTL_SECONDS = 120

export async function signDocumentUrl(documentId: string): Promise<string | null> {
  const supabase = await createClient()

  // RLS decides whether this row is visible at all. An inspector without a
  // live grant, or a client user from another operator, gets nothing here —
  // not a redacted row, no row.
  const { data: doc } = await supabase
    .from('document')
    .select('storage_path, normalized_filename')
    .eq('id', documentId)
    .is('deleted_at', null)
    .single()
  if (!doc) return null

  // Log before signing: the audit record must exist even if the download is
  // abandoned, because "who was given access to this file" is the question,
  // not "who finished downloading it".
  await supabase.rpc('log_document_access', { p_document_id: documentId, p_action: 'download' })

  const { data } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(doc.storage_path as string, SIGNED_URL_TTL_SECONDS, {
      download: doc.normalized_filename as string,
    })
  return data?.signedUrl ?? null
}
