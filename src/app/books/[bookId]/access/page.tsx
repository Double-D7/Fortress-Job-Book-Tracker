import { notFound, redirect } from 'next/navigation'
import { BookAccess } from '@/components/BookAccess'
import { SectionHeading } from '@/components/ui/primitives'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { can } from '@/lib/domain/roles'

export const dynamic = 'force-dynamic'

export default async function AccessPage({
  params,
}: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')

  // Who else can read this book is internal knowledge. An inspector may
  // see their own grant — `inspector_grant_read` says so — but not the
  // register, and certainly not the controls.
  if (!can(viewer.role, 'view_internal')) redirect(`/books/${bookId}`)

  const provider = getDataProvider()
  const bundle = await provider.getBundle(viewer, bookId)
  if (!bundle) notFound()

  const [grants, users] = await Promise.all([
    provider.listInspectorGrants(viewer, bookId),
    provider.listUsers(viewer),
  ])

  return (
    <>
      <SectionHeading
        title="Access"
        subtitle={`Who outside Fortress can read ${bundle.book.jobNumber}`}
      />
      <BookAccess
        bookId={bookId}
        grants={grants}
        inspectors={users.filter(
          (u) => u.role === 'third_party_inspector' && u.isActive)}
        canManage={can(viewer.role, 'manage_inspector_grants')}
      />
    </>
  )
}
