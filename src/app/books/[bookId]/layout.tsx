import { notFound } from 'next/navigation'
import { DEMO_VIEWER, getDataProvider } from '@/lib/data/provider'
import { BookNav } from '@/components/BookNav'
import { Chip } from '@/components/ui/primitives'

export default async function BookLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ bookId: string }> }) {
  const { bookId } = await params
  const bundle = await getDataProvider().getBundle(DEMO_VIEWER, bookId)
  if (!bundle) notFound()

  const { book, clientOrg } = bundle
  return (
    <div>
      <div className="mb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{book.jobNumber}</h1>
          <span className="text-sm text-ink-secondary">{book.facilityName}</span>
          <Chip tone="brand">{clientOrg.name}</Chip>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          Pads {book.wellNames.join(' · ')} — {book.constructionCompany} — construction{' '}
          {book.constructionStart} to {book.constructionEnd}
        </p>
      </div>
      <BookNav bookId={bookId} />
      <div className="mt-5">{children}</div>
    </div>
  )
}
