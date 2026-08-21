/**
 * Idempotent import.
 *
 * Running an import twice must add nothing the second time. That property
 * comes from deterministic record ids — a weld is identified by its book
 * and weld number, a connection by its book and flange number — rather
 * than from a timestamp or an insertion counter. Re-importing a corrected
 * workbook then *updates* the rows it changed and leaves the rest alone,
 * which is what a QA/QC tech actually does when a log is revised.
 *
 * Nothing commits without a preview. The diff below is what the user
 * approves, and it names the fields that would change rather than
 * reporting a row count.
 */

export interface FieldChange {
  field: string
  before: unknown
  after: unknown
}

export interface RecordChange<T> {
  id: string
  label: string
  kind: 'added' | 'updated' | 'unchanged' | 'removed'
  changes: FieldChange[]
  record: T | null
}

export interface ImportDiff<T> {
  added: RecordChange<T>[]
  updated: RecordChange<T>[]
  unchanged: RecordChange<T>[]
  /** Present in the book but absent from the workbook being imported.
   *  Never auto-deleted — a compliance record is not removed because a
   *  spreadsheet stopped mentioning it. */
  removed: RecordChange<T>[]
  summary: { added: number; updated: number; unchanged: number; removed: number }
  isNoOp: boolean
}

const IGNORED_FIELDS = new Set(['sortOrder', 'updatedAt', 'rowVersion'])

function normalizeValue(v: unknown): unknown {
  if (v == null || v === '') return null
  if (Array.isArray(v)) return v.map(normalizeValue).join('|')
  return v
}

function diffRecord<T extends object>(before: T, after: T): FieldChange[] {
  const out: FieldChange[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of keys) {
    if (IGNORED_FIELDS.has(k)) continue
    const a = normalizeValue((before as Record<string, unknown>)[k])
    const b = normalizeValue((after as Record<string, unknown>)[k])
    if (String(a) !== String(b)) out.push({ field: k, before: a, after: b })
  }
  return out
}

/**
 * Compare incoming records against what the book already holds.
 *
 * `label` produces the human-readable name shown in the preview, so a
 * reviewer sees "Weld 1041 · CWI result Pass → Fail" rather than a uuid.
 */
export function diffImport<T extends { id: string }>(
  existing: T[],
  incoming: T[],
  label: (r: T) => string,
): ImportDiff<T> {
  const byId = new Map(existing.map((r) => [r.id, r]))
  const incomingIds = new Set(incoming.map((r) => r.id))

  const added: RecordChange<T>[] = []
  const updated: RecordChange<T>[] = []
  const unchanged: RecordChange<T>[] = []

  for (const r of incoming) {
    const prior = byId.get(r.id)
    if (!prior) {
      added.push({ id: r.id, label: label(r), kind: 'added', changes: [], record: r })
      continue
    }
    const changes = diffRecord(prior as object, r as object)
    if (changes.length === 0) {
      unchanged.push({ id: r.id, label: label(r), kind: 'unchanged', changes: [], record: r })
    } else {
      updated.push({ id: r.id, label: label(r), kind: 'updated', changes, record: r })
    }
  }

  const removed = existing
    .filter((r) => !incomingIds.has(r.id))
    .map((r) => ({ id: r.id, label: label(r), kind: 'removed' as const, changes: [], record: r }))

  return {
    added, updated, unchanged, removed,
    summary: {
      added: added.length, updated: updated.length,
      unchanged: unchanged.length, removed: removed.length,
    },
    // The property that makes a re-import safe: nothing added, nothing
    // changed. Removals do not count, since they are never applied.
    isNoOp: added.length === 0 && updated.length === 0,
  }
}

/** One-line summary for the preview header. */
export function describeDiff<T>(d: ImportDiff<T>, noun = 'record'): string {
  if (d.isNoOp) {
    const base = `No change — all ${d.summary.unchanged} ${noun}s already match this workbook.`
    // Removals still need saying even when nothing would be written: the
    // reviewer is being told the workbook is narrower than the book, which
    // is often the interesting part of a re-import.
    return d.summary.removed
      ? `${base} ${d.summary.removed} ${noun}(s) in the book are absent from this workbook and ` +
        `will be left in place — records are never deleted by an import.`
      : base
  }
  const parts: string[] = []
  if (d.summary.added) parts.push(`${d.summary.added} new`)
  if (d.summary.updated) parts.push(`${d.summary.updated} changed`)
  if (d.summary.unchanged) parts.push(`${d.summary.unchanged} unchanged`)
  let s = `${parts.join(', ')} ${noun}${d.summary.added + d.summary.updated === 1 ? '' : 's'}.`
  if (d.summary.removed) {
    s += ` ${d.summary.removed} ${noun}(s) in the book are absent from this workbook and will be ` +
      `left in place — records are never deleted by an import.`
  }
  return s
}
