'use client'

/**
 * The two-person sign-off, wired up.
 *
 * These buttons were decoration: correctly disabled, correctly explained,
 * and connected to nothing. Which meant no section in this application
 * could ever be approved — and since a document section scores on
 * *approved* documents, no book could ever pass 0% on the sections that
 * matter.
 *
 * The rules are not re-implemented here. `approve_section()` in the
 * database refuses a tech, refuses the submitter, and writes the audit
 * row; this shows what it said.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/primitives'

interface Props {
  bookId: string
  sectionNumber: string
  status: string
  canApprove: boolean
  isOwnSubmission: boolean
}

export function SectionSignOff({
  bookId, sectionNumber, status, canApprove, isOwnSubmission,
}: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState<'ready' | 'approve' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function run(action: 'ready' | 'approve') {
    setBusy(action); setError(null); setDone(null)
    try {
      const res = await fetch(
        `/api/books/${bookId}/sections/${encodeURIComponent(sectionNumber)}/signoff`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }) },
      )
      const json = await res.json()
      if (!json.ok) setError(json.error ?? 'That did not go through.')
      else {
        setDone(action === 'ready' ? 'Marked ready for review.' : 'Section approved.')
        // The score is derived and the status changed, so the page is
        // re-fetched rather than patched in the browser.
        router.refresh()
      }
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={busy !== null || status === 'approved'}
          onClick={() => void run('ready')}
        >
          {busy === 'ready'
            ? <><Loader2 size={13} className="animate-spin" /> Submitting…</>
            : 'Mark ready for review'}
        </Button>
        <Button
          variant="primary"
          disabled={busy !== null || !canApprove || isOwnSubmission || status === 'na'}
          onClick={() => void run('approve')}
        >
          {busy === 'approve'
            ? <><Loader2 size={13} className="animate-spin" /> Approving…</>
            : 'Approve section'}
        </Button>
        {!canApprove && (
          <span className="text-2xs text-ink-muted">
            Approval requires a QA/QC Manager or Admin.
          </span>
        )}
        {isOwnSubmission && canApprove && (
          <span className="text-2xs text-status-progress">
            You submitted this section, so you cannot approve it.
          </span>
        )}
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-md bg-status-critical/10 p-2.5 text-2xs leading-relaxed text-status-critical">
          <AlertTriangle size={13} className="mt-px shrink-0" />{error}
        </p>
      )}
      {done && (
        <p className="flex items-center gap-2 rounded-md bg-status-complete/10 p-2.5 text-2xs text-status-complete">
          <Check size={13} className="shrink-0" />{done}
        </p>
      )}
    </div>
  )
}
