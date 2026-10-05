/**
 * The ids a job book is built from.
 *
 * Creating a book never worked against the real database. The wizard
 * invented both of the identifiers it sent:
 *
 *   projectId:      `proj-dp-137`
 *   bookTemplateId: `tpl-facility-v1`
 *
 * Both columns are uuids pointing at rows that have to exist, so every
 * attempt died on "invalid input syntax for type uuid". Nothing caught
 * it because the seed provider accepts any string as an id, so the one
 * implementation exercised by the tests was the one that did not care.
 *
 * That is the fourth time a difference between the two providers has
 * reached production on this project. These tests are about the shape of
 * the contract rather than either implementation: whatever a provider
 * does with an id, a value the browser made up is not one.
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateSections } from '@/lib/domain/checklist'

/** 8-4-4-4-12 hex, which is what Postgres will accept for a uuid column. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('what the wizard is allowed to decide', () => {
  it('does not mint an id for a row it has never read', () => {
    // The literals that broke it, kept here so a future edit that
    // reintroduces either shape has to delete a test that says why.
    expect(UUID.test('tpl-facility-v1')).toBe(false)
    expect(UUID.test('proj-dp-137')).toBe(false)
  })

  it('no longer carries either literal in the wizard source', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/components/NewJobBookWizard.tsx', 'utf8')
    expect(source).not.toMatch(/`tpl-\$\{/)
    expect(source).not.toMatch(/`proj-\$\{/)
  })
})

describe('the scaffolded section ids', () => {
  const TEMPLATE = 'ca550371-cbb7-4036-b7c0-7c920dc8f869'

  it('are the template id followed by the section number', () => {
    // The Supabase provider strips the template id to recover the
    // number and swap in the real definition row. If this format
    // changes, that remap silently stops matching and every section
    // lands on the wrong definition.
    const defs = buildTemplateSections('facility', TEMPLATE)
    for (const d of defs) {
      expect(d.id).toBe(`${TEMPLATE}:${d.sectionNumber}`)
      expect(d.id.slice(TEMPLATE.length + 1)).toBe(d.sectionNumber)
    }
  })

  it('covers exactly the sections the live templates hold', () => {
    // Checked against the numbers read out of the project's own
    // book_template rows. A checklist that drifts from the database
    // fails the whole create rather than writing a short book.
    expect(buildTemplateSections('facility', TEMPLATE).map((d) => d.sectionNumber))
      .toEqual([
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
        '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', 'S1',
      ])
    expect(buildTemplateSections('flowline', TEMPLATE).map((d) => d.sectionNumber))
      .toEqual([
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
        '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '19-22', '23', 'S1',
      ])
  })

  it('keeps a section number that is not a plain number', () => {
    // `19-22` is the flowline combined map and `S1` is supplemental.
    // A remap that assumed integers would drop both.
    const numbers = buildTemplateSections('flowline', TEMPLATE).map((d) => d.sectionNumber)
    expect(numbers).toContain('19-22')
    expect(numbers).toContain('S1')
    expect(`${TEMPLATE}:19-22`.slice(TEMPLATE.length + 1)).toBe('19-22')
  })
})
