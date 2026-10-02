/**
 * What a book tab shows while its data is on the way.
 *
 * Every page under a book is `force-dynamic` and assembles the whole book
 * before it can render anything. Without a loading boundary, Next.js
 * holds the old screen in place for the entire round trip, so a click
 * produces nothing at all for a second or more and the application reads
 * as broken rather than busy. The work does not get faster by adding
 * this; the person stops wondering whether their click registered.
 *
 * Deliberately a shape rather than a spinner. The blocks sit where the
 * real cards land, so the page does not jump when the data arrives, and
 * the tab bar above is part of the layout and stays put — which is what
 * makes a tab switch feel like a tab switch.
 */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading this section of the job book…</span>

      {/* Metric row: four tiles is the commonest shape across these tabs. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="animate-pulse rounded-card border border-hairline bg-surface px-5 py-4"
          >
            <div className="h-2.5 w-24 rounded bg-surface-raised" />
            <div className="mt-3 h-6 w-16 rounded bg-surface-raised" />
            <div className="mt-2.5 h-2 w-28 rounded bg-surface-raised" />
          </div>
        ))}
      </div>

      {/* Table card: the other commonest shape. */}
      <div className="animate-pulse rounded-card border border-hairline bg-surface">
        <div className="border-b border-hairline px-5 py-3.5">
          <div className="h-3 w-40 rounded bg-surface-raised" />
        </div>
        <div className="divide-y divide-hairline">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-3">
              <div className="h-2.5 w-20 rounded bg-surface-raised" />
              <div className="h-2.5 flex-1 rounded bg-surface-raised" />
              <div className="h-2.5 w-16 rounded bg-surface-raised" />
              <div className="h-2.5 w-12 rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
