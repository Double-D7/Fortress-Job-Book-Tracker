'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/primitives'

export function MarkAllRead({ jobBookId }: { jobBookId?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await fetch('/api/notifications', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobBookId: jobBookId ?? null }),
          })
          router.refresh()
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCheck size={13} />}
      Mark all read
    </Button>
  )
}
