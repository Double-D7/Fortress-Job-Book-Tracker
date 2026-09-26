/**
 * Stable record ids that Postgres will accept.
 *
 * The importers key their records on natural keys so a re-import of a
 * corrected log updates the same rows rather than laying a second copy of
 * the book beside the first. That is right, and the way it was done was
 * not: the id was the natural key itself, as text —
 * `<job-book-uuid>:weld:1140`, `<line-uuid>:7`, `<book>:pt:Test #1
 * B-Spec`, `<book>:tq:2-PF-21024-DCL:0`.
 *
 * Every one of those columns is `uuid`. Postgres rejects the lot:
 *
 *     select pg_input_is_valid('…:weld:1','uuid')  ->  false
 *
 * So the weld log, the torque log and the pressure test importers could
 * never write a row to the real database. The seed provider is an
 * in-memory map keyed on strings, so it accepted them happily and every
 * test passed — the same divergence between two implementations of one
 * contract that this codebase has produced before, and the reason the
 * defect survived: §12 alone carries 20 of the 100 weight points and
 * nobody could have imported it.
 *
 * The fix keeps the natural key and hashes it into a real UUID. Same
 * input, same id, for ever — so re-import still updates — and the value
 * is something the column can hold.
 *
 * RFC 4122 §4.3, version 5: SHA-1 over the namespace bytes followed by
 * the name, first 16 bytes, with the version and variant bits forced.
 * Written out rather than taken from a dependency because it is fifteen
 * lines and this is the identity of every record in the book.
 */
import { createHash } from 'node:crypto'

/**
 * The namespace every Fortress record id is derived under.
 *
 * A fixed, arbitrary UUID. It never changes: changing it would change
 * every id and break the re-import matching this exists to provide.
 */
const FORTRESS_NAMESPACE = '6f9b1a52-4d3e-5c88-9f21-7a0c3e8b45d1'

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/** RFC 4122 v5. Deterministic: the same name always yields the same id. */
export function uuidV5(name: string, namespace: string = FORTRESS_NAMESPACE): string {
  const hash = createHash('sha1')
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest()

  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6]! & 0x0f) | 0x50  // version 5
  b[8] = (b[8]! & 0x3f) | 0x80  // RFC 4122 variant

  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The id for a record, derived from what identifies it in the book.
 *
 * `kind` keeps the spaces apart, so a weld numbered `1` and a pressure
 * test numbered `1` on the same job never collide.
 */
export function recordId(kind: string, ...parts: (string | number)[]): string {
  return uuidV5(`${kind}:${parts.map((p) => String(p).trim().toUpperCase()).join(':')}`)
}
