/**
 * What sections 21 and 22 owe, and which drawings are actually on file.
 *
 * The logs name every line that was worked, so the drawings owed are not
 * a matter of opinion — and until now the number appeared nowhere. The
 * score read "drawings on file over isometrics referenced" without ever
 * checking they were the same isometrics, and the list of lines somebody
 * would go and collect did not exist on any screen.
 *
 * So the list is the point of this panel. A percentage tells a manager
 * how far off the section is; the line numbers are what a drafter works
 * from.
 */
import type { IsometricSectionCoverage } from '@/lib/domain/isometrics'
import { Card, CardBody, CardHeader, CardTitle, Chip, Metric } from '@/components/ui/primitives'
import { num, pct } from '@/lib/utils'

/** Enough to start on, with the rest counted rather than dropped. */
const SHOWN = 60

function List({ items, className = '' }: { items: string[]; className?: string }) {
  return (
    <p className={`text-2xs leading-relaxed ${className}`}>
      <span className="tnum font-mono">{items.slice(0, SHOWN).join(', ')}</span>
      {items.length > SHOWN && (
        <span className="text-ink-muted"> and {num(items.length - SHOWN)} more</span>
      )}
    </p>
  )
}

export function IsometricCoverage({
  sectionNumber, coverage, unread = false, unreadFileCount = null,
}: {
  sectionNumber: string
  coverage: IsometricSectionCoverage
  /**
   * Whether this section's own contents have been read yet.
   *
   * The owed list comes from the logs and is true either way — those
   * lines were worked. What is *not* true, while a folder of drawings
   * sits unread, is that they are missing: DP-318's section 21 holds 154
   * files nobody has imported, and reporting 196 lines as "left to
   * collect" would send a drafter to redraw work that is already in the
   * book. An unread folder is our gap, not the crew's.
   */
  unread?: boolean
  unreadFileCount?: number | null
}) {
  const c = coverage
  if (c.referenced.length === 0 && c.unattributable.length === 0) return null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Drawings this section owes</CardTitle>
          <span className="text-2xs text-ink-muted">
            Every isometric either log references needs one
          </span>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label="Isometrics worked"
              value={num(c.referenced.length)}
              sub={`${num(c.fromWeldLog.length)} in the weld log · ${num(c.fromTorqueLog.length)} in the torque log`}
            />
            <Metric
              label="Drawn"
              value={num(c.covered.length)}
              sub={`${pct(c.coveragePct)} of what is owed`}
              tone={c.missing.length === 0 ? 'complete' : 'progress'}
            />
            <Metric
              label={unread ? 'Not yet matched to a drawing' : 'No drawing on file'}
              value={num(c.missing.length)}
              tone={unread ? 'progress' : c.missing.length > 0 ? 'critical' : 'complete'}
              sub={unread ? 'this section has not been read yet' : 'what is left to collect'}
            />
            <Metric
              label="Naming no isometric"
              value={num(c.unattributable.length)}
              tone={c.unattributable.length > 0 ? 'progress' : 'complete'}
              sub="filed, counting toward nothing"
            />
          </div>

          {unread && (
            <p className="rounded-md border border-status-progress/30 bg-status-progress/[0.07] px-3.5 py-3 text-2xs leading-relaxed text-ink-secondary">
              <span className="font-medium text-status-progress">
                Section {sectionNumber} has not been read into the book
              </span>
              {unreadFileCount != null && ` — ${num(unreadFileCount)} file${unreadFileCount === 1 ? '' : 's'} sit in the source folder.`}
              {' '}The isometrics below are the lines the logs say were worked, which is true
              whatever this section holds. Until the folder is imported, they are lines not yet
              matched to a drawing rather than lines with no drawing — the difference between
              a gap in the book and a gap in our reading of it.
            </p>
          )}

          {c.missing.length > 0 && (
            <div>
              <div className="text-xs font-medium text-ink">
                {unread
                  ? `Worked, with no §${sectionNumber} drawing matched yet`
                  : `Worked with no §${sectionNumber} drawing`}
              </div>
              <List items={c.missing} className="mt-1 text-ink-secondary" />
            </div>
          )}
        </CardBody>
      </Card>

      {c.unattributable.length > 0 && (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="progress">Unattributed</Chip>
              <div className="text-xs font-medium text-ink">
                {num(c.unattributable.length)} drawing
                {c.unattributable.length === 1 ? ' on file names' : 's on file name'} no isometric
              </div>
            </div>
            <p className="mt-1.5 text-2xs leading-relaxed text-ink-secondary">
              These are filed and approved, and they ship with the turnover package. They
              count toward no isometric, because neither the filename nor an upload tag says
              which line they cover. Choose the isometric when uploading, or rename the file
              to its line number.
            </p>
            <List items={c.unattributable} className="mt-1.5 text-ink-muted" />
          </CardBody>
        </Card>
      )}

      {c.extraneous.length > 0 && (
        <Card>
          <CardBody>
            <div className="text-xs font-medium text-ink">
              {num(c.extraneous.length)} drawing
              {c.extraneous.length === 1 ? ' covers a line' : 's cover lines'} neither log references
            </div>
            <p className="mt-1.5 text-2xs leading-relaxed text-ink-secondary">
              Not a fault on its own — a line can be drawn before it is welded, and a
              revision can outlive its work. Worth a look when it is most of the section,
              which is what a book filed against the wrong job looks like.
            </p>
            <List items={c.extraneous} className="mt-1.5 text-ink-muted" />
          </CardBody>
        </Card>
      )}

      {c.awaitingMarkup.length > 0 && (
        <Card>
          <CardBody>
            <div className="text-xs font-medium text-ink">
              {num(c.awaitingMarkup.length)} drawn, not yet marked up
            </div>
            <p className="mt-1.5 text-2xs leading-relaxed text-ink-secondary">
              This book records markup sign-off in the filename —{' '}
              {sectionNumber === '21'
                ? 'one checkmark for the X-ray markup'
                : 'two checkmarks for the heat number and torque markup'}
              {' '}— and these drawings carry the file but not the mark. It does not change
              the percentage: the drawing is on file either way, and a book that does not
              use the convention is never marked down for it.
            </p>
            <List items={c.awaitingMarkup} className="mt-1.5 text-ink-muted" />
          </CardBody>
        </Card>
      )}
    </div>
  )
}
