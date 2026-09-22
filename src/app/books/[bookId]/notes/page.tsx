import { notFound, redirect } from 'next/navigation'
import { BookNotes } from '@/components/BookNotes'
import { SectionHeading } from '@/components/ui/primitives'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { can, canComment } from '@/lib/domain/roles'

export const dynamic = 'force-dynamic'

export default async function NotesPage({
  params,
}: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')

  const provider = getDataProvider()
  const bundle = await provider.getBundle(viewer, bookId)
  if (!bundle) notFound()

  const notes = await provider.listNotes(viewer, bookId)

  // An inspector's right to write depends on their grant on THIS book,
  // not on their role, so the grant has to be in hand before the form
  // can be rendered honestly. Fortress staff pass a null grant and
  // canComment answers on the role alone.
  const grant = viewer.role === 'third_party_inspector'
    ? (await provider.listInspectorGrants(viewer, bookId))
        .find((g) => g.userId === viewer.id) ?? null
    : null
  const mayAdd = canComment(viewer.role, grant)

  return (
    <>
      <SectionHeading
        title="Notes"
        subtitle={`Observations recorded against ${bundle.book.jobNumber}`}
      />
      <BookNotes
        bookId={bookId}
        notes={notes}
        canAdd={mayAdd}
        canChooseVisibility={can(viewer.role, 'view_internal')}
        sections={bundle.sectionDefinitions.map((d) => ({
          sectionNumber: d.sectionNumber,
          title: d.title,
        }))}
        reason={
          mayAdd ? undefined
            : viewer.role === 'third_party_inspector'
              ? 'Your access to this book is read-only. A QA/QC Manager can enable notes ' +
                'on your grant without changing anything else about it.'
              : 'Your role is read-only. Notes are written by Fortress staff and by Client ' +
                'Inspectors whose grant carries the right.'
        }
      />
    </>
  )
}
