/**
 * Filing every credential one uploaded certificate carries.
 *
 * An NDT certification is not one credential. It is a method table, and
 * each line expires on its own date, so one page becomes several rows.
 * Both upload routes need that, which is why it lives here rather than
 * twice in two route handlers — the duplication that already cost this
 * codebase the methods field.
 *
 * ## Why the whole page is checked before anything is written
 *
 * Half a certificate in the register is worse than none: a technician
 * shown as covered for MT and silently missing RT reads as a deliberate
 * scope, not as a failed upload. So every line is validated first, and
 * the first write only happens once all of them pass.
 *
 * The bytes are sent once per line and stored once. Storage is content
 * addressed, so the second line finds the object already there.
 */
import type { ActionResult, DataProvider, Viewer } from '@/lib/data/provider'
import { validateCredential, type CredentialInput } from '@/lib/domain/credentials'

export interface FileCredentialsOutcome {
  0: ActionResult & { filed?: number }
  1: { status: number }
}

export async function fileCredentials(
  provider: DataProvider,
  viewer: Viewer,
  jobBookId: string | null,
  inputs: CredentialInput[],
  bytes: Uint8Array,
  filename: string,
): Promise<[ActionResult & { filed?: number }, { status: number }]> {
  if (inputs.length === 0) {
    return [{ ok: false, error: 'Nothing to file.' }, { status: 422 }]
  }

  // Every line, before any write.
  for (const [i, input] of inputs.entries()) {
    const problems = validateCredential(input)
    if (problems.length > 0) {
      const where = inputs.length > 1 ? `Line ${i + 1}: ` : ''
      return [
        { ok: false, error: where + problems.map((p) => p.message).join(' ') },
        { status: 422 },
      ]
    }
  }

  const filed: string[] = []
  for (const [i, input] of inputs.entries()) {
    // Only the last line rescores the book. Rescoring once per method
    // would recompute the same book four times for one upload.
    const last = i === inputs.length - 1
    const result = await provider.fileCredential(
      viewer, last ? jobBookId : null, input, bytes, filename,
    )
    if (!result.ok) {
      // Earlier lines are already filed and are not rolled back: they
      // are true, and the page they came from is on file. Say plainly
      // which line failed so the rest can be filed again rather than
      // leaving somebody to guess what landed.
      const done = filed.length > 0
        ? ` Lines ${filed.join(', ')} were filed; this one was not.`
        : ''
      return [
        {
          ok: false,
          error: `${inputs.length > 1 ? `Line ${i + 1}: ` : ''}${result.error}${done}`,
        },
        { status: 422 },
      ]
    }
    filed.push(String(i + 1))
  }

  return [{ ok: true, filed: filed.length }, { status: 200 }]
}
