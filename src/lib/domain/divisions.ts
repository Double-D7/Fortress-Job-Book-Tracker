/**
 * Divisions — how the portfolio is grouped on screen.
 *
 * WHY THIS IS NOT JUST `bookType`. It is today, and the mapping below is
 * the identity. But the two answer different questions and will come
 * apart the first time somebody asks them to.
 *
 * `bookType` decides WHICH CHECKLIST a book is scored against — which
 * sections apply, what each is weighted, what "complete" means. It is
 * keyed to `book_template`, and a book's score only means anything
 * relative to it.
 *
 * A division is WHO RUNS THE JOB. It decides what a manager sees when
 * they open the portfolio and how work is counted for the business.
 *
 * Keeping them separate costs one small file and buys the thing that is
 * otherwise painful: a maintenance job that is scored against the
 * facility checklist because that is genuinely the right checklist for
 * it, while still appearing under Maintenance where it belongs. Fusing
 * them would mean a new checklist has to be invented before a division
 * can exist, which is backwards — the division is an organisational
 * fact, and the checklist is a compliance one.
 */
import type { BookType } from './types'

export type Division = 'flowline' | 'facility' | 'maintenance'

export const DIVISIONS: readonly Division[] = ['flowline', 'facility', 'maintenance']

export const DIVISION_LABELS: Record<Division, string> = {
  flowline: 'Flowline',
  facility: 'Facility',
  maintenance: 'Maintenance',
}

/**
 * One line under each heading, so a group with no books says why rather
 * than sitting there empty and looking broken.
 */
export const DIVISION_BLURBS: Record<Division, string> = {
  flowline: 'Pipeline construction turnover packages.',
  facility: 'Facility and pad construction turnover packages.',
  maintenance: 'Maintenance and integrity work.',
}

/**
 * A book's division.
 *
 * Reads an explicit `division` where the book carries one and falls back
 * to the checklist it is scored against. The fallback is what makes this
 * safe to ship before any book has a division recorded: every existing
 * book keeps appearing exactly where it does now.
 */
export function divisionOf(
  book: { division?: Division | null; bookType: BookType },
): Division {
  return book.division ?? book.bookType
}

export interface Grouped<T> {
  division: Division
  label: string
  blurb: string
  books: T[]
}

/**
 * Group a portfolio by division, in a fixed order.
 *
 * Always returns all three groups, including empty ones — a manager
 * looking for the maintenance work needs to see that the category exists
 * and holds nothing, which is different from the category being absent
 * because somebody forgot it. The caller decides whether to render an
 * empty group; `nonEmpty` below is there for the views that should not.
 */
export function groupByDivision<T extends { division?: Division | null; bookType: BookType }>(
  books: T[],
): Grouped<T>[] {
  return DIVISIONS.map((division) => ({
    division,
    label: DIVISION_LABELS[division],
    blurb: DIVISION_BLURBS[division],
    books: books.filter((b) => divisionOf(b) === division),
  }))
}

/** The groups that actually hold something. */
export function nonEmpty<T>(groups: Grouped<T>[]): Grouped<T>[] {
  return groups.filter((g) => g.books.length > 0)
}
