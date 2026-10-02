/**
 * What the portfolio shows while the book list is on the way.
 *
 * Opening a book replaces this whole subtree, so this boundary covers the
 * jump from the job book list into a book — the slowest navigation in the
 * application, because the destination assembles the entire book before
 * it renders.
 */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading job books…</span>
      <div className="animate-pulse rounded-card border border-hairline bg-surface">
        <div className="border-b border-hairline px-5 py-3.5">
          <div className="h-3 w-32 rounded bg-surface-raised" />
        </div>
        <div className="divide-y divide-hairline">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <div className="h-3 w-24 rounded bg-surface-raised" />
              <div className="h-2.5 flex-1 rounded bg-surface-raised" />
              <div className="h-2.5 w-20 rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
