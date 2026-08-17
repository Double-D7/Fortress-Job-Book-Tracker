import { notFound } from 'next/navigation'
import { DEMO_VIEWER, getDataProvider } from '@/lib/data/provider'
import { collateSectionNumber } from '@/lib/domain/scoring'
import { DocumentLibrary } from '@/components/DocumentLibrary'

export const dynamic = 'force-dynamic'

export default async function DocumentsPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params
  const b = await getDataProvider().getBundle(DEMO_VIEWER, bookId)
  if (!b) notFound()

  const defById = new Map(b.sectionDefinitions.map((d) => [d.id, d]))
  const sectionById = new Map(b.sections.map((s) => [s.id, s]))

  // Content hashes seen more than once, so the library can mark duplicates
  // where they sit rather than only in the flag queue.
  const hashCounts = new Map<string, number>()
  for (const d of b.documents) hashCounts.set(d.sha256, (hashCounts.get(d.sha256) ?? 0) + 1)

  const docs = b.documents.map((d) => {
    const section = d.sectionId ? sectionById.get(d.sectionId) : null
    const def = section ? defById.get(section.sectionDefinitionId) : null
    return {
      id: d.id,
      sectionNumber: def?.sectionNumber ?? '—',
      sectionTitle: def?.title ?? 'Unfiled',
      originalFilename: d.originalFilename,
      normalizedFilename: d.normalizedFilename,
      byteSize: d.byteSize ?? 0,
      mimeType: d.mimeType ?? '',
      approved: !!d.approvedAt,
      superseded: d.isSuperseded,
      duplicate: (hashCounts.get(d.sha256) ?? 0) > 1,
      isArchive: /\.(zip|7z|rar|tar|gz)$/i.test(d.originalFilename),
      sha256: d.sha256.slice(0, 12),
    }
  }).sort((a, c) =>
    collateSectionNumber(a.sectionNumber) - collateSectionNumber(c.sectionNumber) ||
    a.originalFilename.localeCompare(c.originalFilename),
  )

  return <DocumentLibrary docs={docs} />
}
