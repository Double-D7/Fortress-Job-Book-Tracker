/**
 * Why an upload failed.
 *
 * A QA/QC Manager uploading marked-up isometrics was told "Could not
 * reach the server." The server answered immediately; it refused the
 * request for being too large, and the refusal was an HTML error page
 * rather than JSON, so `res.json()` threw and landed in the same catch
 * as a dropped connection. That sends somebody to look at their wifi
 * when the answer is on the file size.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_REQUEST_BYTES, describeUploadFailure, postForJson, tooLargeFor,
} from '@/lib/http/uploadLimits'

const file = (name: string, mb: number) => ({ name, size: Math.round(mb * 1024 * 1024) })

describe('whether a batch can be sent at all', () => {
  it('passes a batch inside the limit', () => {
    expect(tooLargeFor([file('a.pdf', 1), file('b.pdf', 2)])).toBeNull()
  })

  it('refuses a batch over it, and says to split it', () => {
    const over = tooLargeFor([file('a.pdf', 3), file('b.pdf', 3)])
    expect(over).not.toBeNull()
    expect(over!.message).toMatch(/fewer files/)
  })

  it('says plainly when one file is too big on its own', () => {
    // The distinction that matters. Telling somebody to split a batch
    // that is one 9 MB scan sends them round a loop that cannot end.
    const over = tooLargeFor([file('ISO-114-MRK.pdf', 9)])
    expect(over!.individuallyOversize).toEqual(['ISO-114-MRK.pdf'])
    expect(over!.message).toMatch(/Splitting the batch will not help/)
  })

  it('names the oversize files rather than the whole batch', () => {
    const over = tooLargeFor([file('small.pdf', 0.5), file('huge.pdf', 12)])
    expect(over!.individuallyOversize).toEqual(['huge.pdf'])
    expect(over!.message).toContain('huge.pdf')
    expect(over!.message).not.toContain('small.pdf')
  })

  it('does not list more than three names', () => {
    const over = tooLargeFor(
      [1, 2, 3, 4, 5].map((n) => file(`iso-${n}.pdf`, 9)))
    expect(over!.message).toMatch(/and 2 more/)
  })

  it('leaves headroom under the platform ceiling for multipart framing', () => {
    // A batch measured at exactly the limit arrives over it: the
    // boundary markers, field names and the classification JSON all
    // ride along with the bytes.
    expect(MAX_REQUEST_BYTES).toBeLessThan(4.5 * 1024 * 1024)
  })
})

describe('what a failure is called', () => {
  it('calls a dropped connection a dropped connection', () => {
    expect(describeUploadFailure(null, false)).toMatch(/Could not reach the server/)
  })

  it('does NOT call a size rejection a dropped connection', () => {
    // The bug, stated as a test.
    const msg = describeUploadFailure({ status: 413, ok: false }, true)
    expect(msg).not.toMatch(/Could not reach the server/)
    expect(msg).toMatch(/over 4 MB/)
  })

  it('calls a timeout a timeout', () => {
    expect(describeUploadFailure({ status: 504, ok: false }, true)).toMatch(/too long/)
  })

  it('calls an expired session an expired session', () => {
    expect(describeUploadFailure({ status: 401, ok: false }, false)).toMatch(/session/i)
  })

  it('says the platform refused it when the answer was not ours', () => {
    const msg = describeUploadFailure({ status: 500, ok: false }, true)
    expect(msg).toMatch(/before it reached the application/)
    expect(msg).toMatch(/500/)
  })

  it('says nothing was filed ONLY where that is certainly true', () => {
    // A 413 never reached the route, so nothing can have been written.
    expect(describeUploadFailure({ status: 413, ok: false }, true))
      .toMatch(/nothing was filed/)

    // A timeout, a 500 or a dropped connection may have caught the
    // function part way through a commit. Claiming nothing landed is
    // how somebody files a duplicate on purpose.
    for (const r of [{ status: 504, ok: false }, { status: 500, ok: false }, null]) {
      const msg = describeUploadFailure(r, true)
      expect(msg).not.toMatch(/nothing was filed/)
      expect(msg).toMatch(/Check the documents list below/)
    }
  })
})

describe('reading the answer', () => {
  /** Runs `run` with `fetch` replaced, and always puts it back. */
  async function withFetch<T>(
    stub: (...args: Parameters<typeof fetch>) => Promise<Response>,
    run: () => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = stub as typeof fetch
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  const responds = (body: string, status: number) =>
    async () => new Response(body, { status })

  it('prefers the application\'s own wording over a status code', async () => {
    // Our refusals are JSON and say something useful. A message derived
    // from the status would be worse than the one the route wrote.
    const res = await withFetch(
      responds(JSON.stringify({ ok: false, error: 'That batch exceeds 512 MB.' }), 422),
      () => postForJson('/x', { method: 'POST' }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toBe('That batch exceeds 512 MB.')
  })

  it('turns a non-JSON platform refusal into a size message', async () => {
    const res = await withFetch(
      responds('<html>Request Entity Too Large</html>', 413),
      () => postForJson('/x', { method: 'POST' }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/over 4 MB/)
    expect(res.error).not.toMatch(/Could not reach/)
  })

  it('reports a thrown fetch as unreachable, which is the one case it is', async () => {
    const res = await withFetch(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => postForJson('/x', { method: 'POST' }),
    )
    expect(res.error).toMatch(/Could not reach the server/)
  })

  it('passes a good answer through', async () => {
    const res = await withFetch(
      responds(JSON.stringify({ ok: true, preview: { files: [] } }), 200),
      () => postForJson<{ preview: unknown }>('/x', { method: 'PUT' }),
    )
    expect(res.ok).toBe(true)
    expect(res.data!.preview).toEqual({ files: [] })
  })
})

describe('an expired session', () => {
  async function withFetch<T>(
    stub: (...args: Parameters<typeof fetch>) => Promise<Response>,
    run: () => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = stub as typeof fetch
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  it('is named, rather than reported as a refusal with a 200', async () => {
    // The middleware bounces an unauthenticated API call to the
    // sign-in page, which answers 200 with HTML. Verified against
    // production: a GET to the staged route returns 200 and
    // x-matched-path: /login. Without this case the generic branch
    // says "the server refused the upload (HTTP 200)", which reads as
    // nonsense and hides the one thing the person has to do.
    const res = await withFetch(
      async () => {
        const r = new Response('<html>sign in</html>', { status: 200 })
        Object.defineProperty(r, 'redirected', { value: true })
        Object.defineProperty(r, 'url', { value: 'https://app.fortressqc.com/login?next=%2Fapi' })
        return r
      },
      () => postForJson('/api/x', { method: 'PUT' }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/session has expired/)
    expect(res.error).not.toMatch(/HTTP 200/)
  })
})
