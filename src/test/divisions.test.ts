/**
 * Grouping the portfolio by division.
 *
 * The case worth protecting is the fallback: every book that exists
 * today carries no division, and must keep appearing exactly where it
 * appears now. A grouping change that quietly loses a book from the
 * portfolio is the worst possible outcome here — the whole point of the
 * screen is that somebody can see all their work at once.
 */
import { describe, expect, it } from 'vitest'
import {
  DIVISIONS, DIVISION_BLURBS, DIVISION_LABELS, divisionOf, groupByDivision,
  nonEmpty, type Division,
} from '@/lib/domain/divisions'
import type { BookType } from '@/lib/domain/types'
import { scaffoldJobBook, validateNewJobBook } from '@/lib/domain/scaffold'

const book = (
  id: string, bookType: BookType, division?: Division | null,
) => ({ id, bookType, division })

describe('which division a book belongs to', () => {
  it('falls back to the checklist when no division is recorded', () => {
    // Every book in the database today. None carry a division, and all
    // of them have to keep landing somewhere sensible.
    expect(divisionOf(book('a', 'flowline'))).toBe('flowline')
    expect(divisionOf(book('b', 'facility'))).toBe('facility')
  })

  it('treats an explicitly null division the same as an absent one', () => {
    // A nullable column reads back as null, not undefined.
    expect(divisionOf(book('a', 'facility', null))).toBe('facility')
  })

  it('prefers an explicit division over the checklist', () => {
    // The case this design exists for: a maintenance job scored against
    // the facility checklist, because that is the right checklist for
    // it, but belonging to Maintenance on the portfolio.
    expect(divisionOf(book('a', 'facility', 'maintenance'))).toBe('maintenance')
  })
})

describe('grouping', () => {
  const books = [
    book('f1', 'flowline'),
    book('f2', 'flowline'),
    book('c1', 'facility'),
    book('m1', 'facility', 'maintenance'),
  ]

  it('loses nothing — every book lands in exactly one group', () => {
    const groups = groupByDivision(books)
    const placed = groups.flatMap((g) => g.books.map((b) => b.id))
    expect(placed.sort()).toEqual(['c1', 'f1', 'f2', 'm1'])
    expect(new Set(placed).size).toBe(books.length)
  })

  it('returns all three divisions, including the empty ones', () => {
    const groups = groupByDivision([book('f1', 'flowline')])
    expect(groups.map((g) => g.division)).toEqual([...DIVISIONS])
    expect(groups.find((g) => g.division === 'maintenance')!.books).toEqual([])
  })

  it('keeps a fixed order rather than one that shifts with the data', () => {
    // A portfolio whose headings reorder as books are added is a
    // portfolio nobody learns the shape of.
    expect(groupByDivision([]).map((g) => g.division))
      .toEqual(['flowline', 'facility', 'maintenance'])
    expect(groupByDivision(books).map((g) => g.division))
      .toEqual(['flowline', 'facility', 'maintenance'])
  })

  it('puts the maintenance book under Maintenance, not Facility', () => {
    const groups = groupByDivision(books)
    const facility = groups.find((g) => g.division === 'facility')!
    const maintenance = groups.find((g) => g.division === 'maintenance')!
    expect(facility.books.map((b) => b.id)).toEqual(['c1'])
    expect(maintenance.books.map((b) => b.id)).toEqual(['m1'])
  })

  it('carries a label and a blurb for every division', () => {
    for (const g of groupByDivision([])) {
      expect(g.label).toBe(DIVISION_LABELS[g.division])
      expect(g.blurb).toBe(DIVISION_BLURBS[g.division])
      expect(g.label.length).toBeGreaterThan(3)
    }
  })

  it('handles an empty portfolio without inventing groups', () => {
    expect(groupByDivision([])).toHaveLength(3)
    expect(nonEmpty(groupByDivision([]))).toEqual([])
  })
})

describe('nonEmpty', () => {
  it('drops the divisions with nothing in them', () => {
    const groups = nonEmpty(groupByDivision([
      book('f1', 'flowline'), book('m1', 'flowline', 'maintenance'),
    ]))
    expect(groups.map((g) => g.division)).toEqual(['flowline', 'maintenance'])
  })

  it('keeps the fixed order among those that remain', () => {
    const groups = nonEmpty(groupByDivision([
      book('m1', 'facility', 'maintenance'), book('f1', 'flowline'),
    ]))
    expect(groups.map((g) => g.division)).toEqual(['flowline', 'maintenance'])
  })
})

describe('creating a maintenance book', () => {
  const base = {
    jobNumber: 'MNT-001',
    projectId: 'p1',
    clientOrgId: 'org1',
    bookTemplateId: 'tpl-facility-v1',
  }

  it('scores a maintenance job against the facility checklist', () => {
    // The decision this feature turns on: Maintenance is a division, not
    // a checklist. A book scored against a checklist nobody wrote would
    // report a percentage that means nothing.
    const { book, sections } = scaffoldJobBook(
      { ...base, bookType: 'facility', division: 'maintenance' },
      (kind, key) => `${kind}-${key}`)
    expect(book.division).toBe('maintenance')
    expect(book.bookType).toBe('facility')

    const facility = scaffoldJobBook(
      { ...base, bookType: 'facility' }, (kind, key) => `${kind}-${key}`)
    // Same sections, same applicability, same N/A reasons — the division
    // must not touch scoring in any way.
    expect(sections.map((s) => [s.sectionDefinitionId, s.status, s.naReason]))
      .toEqual(facility.sections.map((s) => [s.sectionDefinitionId, s.status, s.naReason]))
  })

  it('defaults the division to the book type when none is given', () => {
    // Every book created before this existed, and every one created by a
    // caller that does not know about divisions.
    for (const bookType of ['flowline', 'facility'] as const) {
      const { book } = scaffoldJobBook(
        { ...base, bookType }, (kind, key) => `${kind}-${key}`)
      expect(book.division).toBe(bookType)
    }
  })

  it('refuses a division that is not one of the three', () => {
    // The API route hands the request body through unchecked, so this is
    // the layer that turns a bad value into a sentence rather than a
    // Postgres enum violation.
    const { errors } = validateNewJobBook(
      { ...base, bookType: 'facility', division: 'demolition' as never })
    expect(errors.some((e) => e.field === 'division')).toBe(true)
  })

  it('accepts each of the three', () => {
    for (const division of DIVISIONS) {
      const { errors } = validateNewJobBook({ ...base, bookType: 'facility', division })
      expect(errors.some((e) => e.field === 'division'), division).toBe(false)
    }
  })
})
