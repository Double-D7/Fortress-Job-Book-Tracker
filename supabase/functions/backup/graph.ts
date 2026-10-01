/**
 * Microsoft Graph, app-only, for the nightly backup.
 *
 * The application holds one permission — `Sites.Selected` — which grants
 * nothing by itself. After an administrator consents, the app can reach
 * zero SharePoint sites; it reaches exactly one because a second,
 * explicit grant named that site. So the blast radius of a leaked token
 * here is one document library, and the kill switch is revoking that one
 * grant.
 *
 * ## Why uploads are not one PUT
 *
 * A facility job book runs to roughly 850MB and section 15 alone is
 * 286MB. Graph takes a simple PUT up to 4MB and wants an upload session
 * above it, and an Edge Function has 256MB of memory, so a large file is
 * streamed through in chunks and never held whole. Buffering would work
 * on every file anybody tested with and fail on the ones that matter.
 *
 * ## What this never does
 *
 * It does not delete. A document replaced by a newer version is moved
 * into `_superseded/`, because a backup that can remove things is a
 * backup that can be told to remove things.
 */

import { describeCredentialShape } from '../_shared/credentialShape.ts'

const GRAPH = 'https://graph.microsoft.com/v1.0'

/** Graph wants chunks that are a multiple of 320 KiB. 8 MiB is inside an
 *  Edge Function's memory and few enough round trips to be quick. */
const CHUNK = 8 * 320 * 1024

export interface GraphConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  /** The site the per-site grant names, as `{hostname},{siteId},{webId}`
   *  or the `hostname:/sites/path:` form Graph accepts. */
  siteId: string
  /** Drive within that site. Resolved once and cached when absent. */
  driveId?: string
}

export function graphConfigFromEnv(): GraphConfig | { error: string } {
  const tenantId = Deno.env.get('GRAPH_TENANT_ID')
  const clientId = Deno.env.get('GRAPH_CLIENT_ID')
  const clientSecret = Deno.env.get('GRAPH_CLIENT_SECRET')
  const siteId = Deno.env.get('GRAPH_SITE_ID')

  // Named individually rather than as "configuration is missing", because
  // the usual cause is one of four being absent and the message should
  // say which.
  const missing = [
    ['GRAPH_TENANT_ID', tenantId], ['GRAPH_CLIENT_ID', clientId],
    ['GRAPH_CLIENT_SECRET', clientSecret], ['GRAPH_SITE_ID', siteId],
  ].filter(([, v]) => !v).map(([k]) => k)

  if (missing.length > 0) {
    return { error: `Not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.` }
  }
  return {
    tenantId: tenantId!, clientId: clientId!,
    clientSecret: clientSecret!, siteId: siteId!,
  }
}

/** Client credentials. No user is involved and none can be. */
export async function accessToken(cfg: GraphConfig): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  )
  const body = await res.json()
  if (!res.ok) {
    // Entra's own description is far more useful than a status code: it
    // names an unconsented permission or a wrong secret outright.
    //
    // What it will not tell you is which wrong thing is in the box, and
    // "Invalid client secret provided" reads the same for a Secret ID, a
    // stray newline and an expired secret. The shape of the configured
    // value distinguishes them without disclosing it.
    const shape = describeCredentialShape(cfg.clientSecret, { clientId: cfg.clientId })
    throw new Error(
      `Graph token request failed (${res.status}): ` +
      `${body.error_description ?? body.error ?? 'no detail'}` +
      (shape ? ` [GRAPH_CLIENT_SECRET: ${shape}]` : ''),
    )
  }
  return body.access_token as string
}

export class Graph {
  constructor(private cfg: GraphConfig, private token: string) {}

  static async connect(cfg: GraphConfig): Promise<Graph> {
    return new Graph(cfg, await accessToken(cfg))
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    })
  }

  /** The default document library of the granted site. */
  async driveId(): Promise<string> {
    if (this.cfg.driveId) return this.cfg.driveId
    const res = await this.call(`/sites/${this.cfg.siteId}/drive?$select=id`)
    if (!res.ok) {
      const detail = await res.text()
      throw new Error(
        `Cannot read the drive for site ${this.cfg.siteId} (${res.status}). ` +
        `A 403 here usually means consent was granted but the per-site ` +
        `permission was not: POST /sites/{siteId}/permissions. ${detail}`,
      )
    }
    this.cfg.driveId = (await res.json()).id as string
    return this.cfg.driveId
  }

  /** Graph addresses an item by path relative to the drive root. */
  private itemPath(remotePath: string): string {
    const encoded = remotePath.split('/').map(encodeURIComponent).join('/')
    return `/drives/${this.cfg.driveId}/root:/${encoded}`
  }

  /**
   * Upload bytes to a path, creating every folder on the way.
   *
   * Small files go in one PUT. Anything larger streams through an upload
   * session, a chunk at a time, so a 286MB section never has to fit in
   * memory at once.
   */
  async upload(remotePath: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
    await this.driveId()
    if (size <= 4 * 1024 * 1024) {
      const res = await this.call(`${this.itemPath(remotePath)}:/content`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: await new Response(body).arrayBuffer(),
      })
      if (!res.ok) throw new Error(`Upload of ${remotePath} failed (${res.status}): ${await res.text()}`)
      return
    }

    const session = await this.call(`${this.itemPath(remotePath)}:/createUploadSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace' },
      }),
    })
    if (!session.ok) {
      throw new Error(`Upload session for ${remotePath} failed (${session.status}): ${await session.text()}`)
    }
    const uploadUrl = (await session.json()).uploadUrl as string

    const reader = body.getReader()
    let buffer = new Uint8Array(0)
    let sent = 0

    const flush = async (chunk: Uint8Array) => {
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(chunk.length),
          'content-range': `bytes ${sent}-${sent + chunk.length - 1}/${size}`,
        },
        body: chunk,
      })
      if (!res.ok && res.status !== 201 && res.status !== 202) {
        throw new Error(
          `Chunk ${sent}-${sent + chunk.length - 1} of ${remotePath} failed (${res.status}): ${await res.text()}`,
        )
      }
      sent += chunk.length
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        const next = new Uint8Array(buffer.length + value.length)
        next.set(buffer)
        next.set(value, buffer.length)
        buffer = next
      }
      while (buffer.length >= CHUNK) {
        await flush(buffer.subarray(0, CHUNK))
        buffer = buffer.subarray(CHUNK)
      }
      if (done) break
    }
    if (buffer.length > 0) await flush(buffer)

    if (sent !== size) {
      throw new Error(`${remotePath}: sent ${sent} bytes of a declared ${size}.`)
    }
  }

  /**
   * Move an item aside rather than deleting it.
   *
   * Used when a document is replaced: the previous copy goes to
   * `_superseded/` and stays there. Nothing in this module deletes.
   */
  async moveAside(fromPath: string, toPath: string): Promise<void> {
    await this.driveId()
    const toParent = toPath.slice(0, toPath.lastIndexOf('/'))
    const name = toPath.slice(toPath.lastIndexOf('/') + 1)
    await this.ensureFolder(toParent)

    const res = await this.call(this.itemPath(fromPath), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        parentReference: { path: `/drives/${this.cfg.driveId}/root:/${
          toParent.split('/').map(encodeURIComponent).join('/')}` },
      }),
    })
    // A 404 means the file we meant to move aside is not there. That is
    // not a failure worth stopping a run for: the outcome we wanted —
    // nothing of the old version in place — already holds.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Could not move ${fromPath} aside (${res.status}): ${await res.text()}`)
    }
  }

  /** Create a folder path if it is not already there. */
  async ensureFolder(path: string): Promise<void> {
    if (!path) return
    await this.driveId()
    const segments = path.split('/').filter(Boolean)
    let built = ''
    for (const segment of segments) {
      const parent = built
      built = built ? `${built}/${segment}` : segment
      const res = await this.call(
        parent
          ? `${this.itemPath(parent)}:/children`
          : `/drives/${this.cfg.driveId}/root/children`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: segment,
            folder: {},
            // The folder usually exists already; this is the documented
            // way to say "fine either way" without a read first.
            '@microsoft.graph.conflictBehavior': 'fail',
          }),
        },
      )
      if (!res.ok && res.status !== 409) {
        throw new Error(`Could not create folder ${built} (${res.status}): ${await res.text()}`)
      }
    }
  }
}
