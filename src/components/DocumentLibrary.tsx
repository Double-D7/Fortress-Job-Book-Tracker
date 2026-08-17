'use client'

/**
 * Document library — the full-book file browser, mirroring the section
 * numbering the operator expects.
 *
 * Both filenames are shown: the normalized one the package will ship under,
 * and the original as uploaded. Preserving the original is what makes the
 * normalization safe — nobody has to trust that `TQW-` and `TWQ-` were the
 * same equipment, they can see the name it arrived with.
 */
import { useMemo, useState } from 'react'
import { Archive, Copy, FileText, Search } from 'lucide-react'
import { Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, Table, Td, Th, Tr } from '@/components/ui/primitives'
import { bytes, num } from '@/lib/utils'

export interface DocRow {
  id: string
  sectionNumber: string
  sectionTitle: string
  originalFilename: string
  normalizedFilename: string
  byteSize: number
  mimeType: string
  approved: boolean
  superseded: boolean
  duplicate: boolean
  isArchive: boolean
  sha256: string
}

export function DocumentLibrary({ docs }: { docs: DocRow[] }) {
  const [query, setQuery] = useState('')
  const [section, setSection] = useState('')

  const sections = useMemo(() => {
    const map = new Map<string, { number: string; title: string; count: number; bytes: number }>()
    for (const d of docs) {
      const e = map.get(d.sectionNumber) ?? { number: d.sectionNumber, title: d.sectionTitle, count: 0, bytes: 0 }
      e.count++
      e.bytes += d.byteSize
      map.set(d.sectionNumber, e)
    }
    return [...map.values()]
  }, [docs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return docs.filter((d) => {
      if (section && d.sectionNumber !== section) return false
      if (!q) return true
      return (
        d.originalFilename.toLowerCase().includes(q) ||
        d.normalizedFilename.toLowerCase().includes(q) ||
        d.sectionTitle.toLowerCase().includes(q)
      )
    })
  }, [docs, query, section])

  const totalBytes = docs.reduce((s, d) => s + d.byteSize, 0)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto">
            Document library — {num(docs.length)} files, {bytes(totalBytes)}
          </CardTitle>
          <select
            value={section}
            onChange={(e) => setSection(e.target.value)}
            aria-label="Filter by section"
            className="rounded-md border border-hairline bg-surface-raised px-2 py-1 text-xs text-ink"
          >
            <option value="">All sections</option>
            {sections.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number} — {s.title} ({s.count})
              </option>
            ))}
          </select>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search filenames…"
              aria-label="Search documents"
              className="w-56 rounded-md border border-hairline bg-surface-raised py-1 pl-7 pr-2 text-xs text-ink placeholder:text-ink-muted"
            />
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-5"><EmptyState title="No documents match" /></div>
          ) : (
            <div className="max-h-[640px] overflow-y-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Section</Th><Th>File</Th><Th className="text-right">Size</Th>
                    <Th>SHA-256</Th><Th>State</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <Tr key={d.id}>
                      <Td className="tnum whitespace-nowrap font-mono text-ink-muted">{d.sectionNumber}</Td>
                      <Td>
                        <div className="flex items-start gap-2">
                          {d.isArchive
                            ? <Archive size={13} className="mt-0.5 shrink-0 text-status-progress" />
                            : <FileText size={13} className="mt-0.5 shrink-0 text-ink-muted" />}
                          <div className="min-w-0">
                            <div className="truncate text-ink">{d.originalFilename}</div>
                            <div className="truncate font-mono text-2xs text-ink-muted">
                              ships as {d.normalizedFilename}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td className="tnum whitespace-nowrap text-right font-mono text-ink-secondary">
                        {bytes(d.byteSize)}
                      </Td>
                      <Td className="font-mono text-2xs text-ink-muted">{d.sha256}…</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {d.approved ? <Chip tone="complete">Approved</Chip> : <Chip tone="progress">Unapproved</Chip>}
                          {d.superseded && <Chip tone="idle">Superseded</Chip>}
                          {d.duplicate && <Chip tone="progress" icon={<Copy size={10} />}>Duplicate content</Chip>}
                          {d.isArchive && <Chip tone="progress" icon={<Archive size={10} />}>Not indexed</Chip>}
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
