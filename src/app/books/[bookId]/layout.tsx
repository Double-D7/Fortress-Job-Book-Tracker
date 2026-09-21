import { notFound, redirect} from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { BookNav } from '@/components/BookNav'
import { Chip } from '@/components/ui/primitives'

export default async function BookLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ bookId: string }> }) {
  // No session means no data. Sending an unauthenticated request to the
  // sign-in page is the only correct ending; rendering a shell with empty
  // tables would look like a book with nothing in it.
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params
  const bundle = await getDataProvider().getBundle(viewer, bookId)
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
          {[
            book.wellNames.length ? `Pads ${book.wellNames.join(' · ')}` : null,
            book.constructionCompany,
            book.constructionStart && book.constructionEnd
              ? `construction ${book.constructionStart} to ${book.constructionEnd}`
              : null,
          ].filter(Boolean).join(' — ') || 'No pads, contractor or construction window recorded yet.'}
        </p>
      </div>
      <BookNav bookId={bookId} />
      <div className="mt-5">{children}</div>
    </div>
  )
}
