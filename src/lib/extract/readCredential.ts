/**
 * The one part of extraction that talks to the network.
 *
 * Kept apart from `credentialExtraction.ts` on purpose. Everything that
 * decides what lands in a form field is pure and tested; this file only
 * turns bytes into a request and a response into the shape that module
 * already knows how to handle. When something goes wrong in extraction
 * it is nearly always in the mapping, and the mapping does not need an
 * API key to exercise.
 *
 * Nothing here writes to the register. It returns a draft for a person
 * to check against the page.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import {
  EXTRACTION_MODEL, EXTRACTION_PROMPT, ExtractedCredential,
  contentBlockFor, extractionToDraft, type CredentialDraft,
} from './credentialExtraction'

export type ReadResult =
  | { ok: true; draft: CredentialDraft }
  /** No key configured. Distinguished from a failure because it is a
   *  deployment question, not a problem with the page. */
  | { ok: false; reason: 'not_configured'; error: string }
  /** The model could not produce a reading of this page. */
  | { ok: false; reason: 'unreadable'; error: string }
  | { ok: false; reason: 'failed'; error: string }

/** Read per call rather than at module load, so adding the key to the
 *  deployment takes effect without a rebuild — the same reason the
 *  Resend sender reads its key per call. */
function apiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY
}

export function extractionConfigured(): boolean {
  return !!apiKey()
}

export async function readCredential(
  bytes: Uint8Array,
  filename: string,
): Promise<ReadResult> {
  const key = apiKey()
  if (!key) {
    return {
      ok: false,
      reason: 'not_configured',
      error: 'Reading certificates is not switched on for this deployment. '
        + 'Type the fields in, or ask an administrator to add ANTHROPIC_API_KEY.',
    }
  }

  const block = contentBlockFor(bytes, filename)

  try {
    const client = new Anthropic({ apiKey: key })
    const response = await client.messages.parse({
      model: EXTRACTION_MODEL,
      max_tokens: 8000,
      // A wallet card is not a reasoning problem. Low effort reads it
      // as accurately and returns in a fraction of the time, which
      // matters when somebody is waiting on a form to fill itself in.
      output_config: {
        effort: 'low',
        format: zodOutputFormat(ExtractedCredential),
      },
      messages: [{
        role: 'user',
        content: [
          block.type === 'document'
            ? {
              type: 'document' as const,
              source: {
                type: 'base64' as const,
                media_type: 'application/pdf' as const,
                data: block.data,
              },
            }
            : {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: block.mediaType as
                  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: block.data,
              },
            },
          { type: 'text' as const, text: EXTRACTION_PROMPT },
        ],
      }],
    })

    // Null when the response did not parse against the schema. Treated
    // as unreadable rather than thrown: the page is still filable by
    // hand, and that is what the person is told.
    const parsed = response.parsed_output
    if (!parsed) {
      return {
        ok: false,
        reason: 'unreadable',
        error: 'The certificate could not be read. Type the fields in from the page.',
      }
    }

    return { ok: true, draft: extractionToDraft(parsed) }
  } catch (e) {
    // Never throws to the caller. A failed read must leave somebody
    // able to file the credential by hand, not staring at an error.
    const message = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      reason: 'failed',
      error: `The certificate could not be read: ${message}`,
    }
  }
}
