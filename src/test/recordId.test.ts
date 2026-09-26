/**
 * Every id an importer writes has to be a UUID.
 *
 * The weld, torque and pressure test importers keyed their records on the
 * natural key as text — `<book>:weld:1140`, `<line>:7`, `<book>:pt:Test #1
 * B-Spec` — and every one of those columns is `uuid`. Postgres rejects
 * them, so none of those importers could write a row to the real
 * database. The seed provider is a map keyed on strings and accepted them,
 * so the whole suite passed against an implementation that could not be
 * deployed.
 *
 * Checked against the real database while this was written:
 *
 *     select pg_input_is_valid('…:weld:1','uuid')  ->  false
 *
 * These cases are the guard that was missing. They assert the shape the
 * column requires, on ids produced by the real record-id functions rather
 * than on hand-written examples, because a test that makes up its own
 * input proves nothing about what the importer emits.
 */
import { describe, expect, it } from 'vitest'
import { recordId, uuidV5 } from '@/lib/domain/recordId'
import { facilityWeldRecordId } from '@/lib/import/facilityWeldLog'
import { flowlineWeldRecordId } from '@/lib/import/flowlineWeldLog'
import { pressureTestRecordId } from '@/lib/import/pressureTestLog'

/** Postgres accepts exactly this, and `uuid` rejects everything else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const BOOK = 'b1f0c2d4-1111-2222-3333-444455556666'
const LINE = 'c2e1d3f5-2222-3333-4444-555566667777'

describe('the id an importer writes', () => {
  it('is a UUID for a facility weld', () => {
    expect(facilityWeldRecordId(BOOK, '1140')).toMatch(UUID)
  })

  it('is a UUID for a flowline weld', () => {
    expect(flowlineWeldRecordId(LINE, '7')).toMatch(UUID)
  })

  it('is a UUID for a pressure test, punctuation and spaces included', () => {
    // `Test #1 B-Spec` is how DP-318 numbers them.
    expect(pressureTestRecordId(BOOK, 'Test #1 B-Spec')).toMatch(UUID)
  })

  it('is a UUID however ugly the natural key is', () => {
    const ugly = ['2-PF-21024-DCL', 'weld "1140"', 'NP-2 / repair', '  spaced  ', 'ünïcode', '']
    for (const k of ugly) expect(recordId('weld', BOOK, k)).toMatch(UUID)
  })
})

describe('the same record keeps the same id', () => {
  it('so a re-import updates rather than duplicating', () => {
    expect(facilityWeldRecordId(BOOK, '1140')).toBe(facilityWeldRecordId(BOOK, '1140'))
  })

  it('ignoring case and surrounding space, as the old keys did', () => {
    expect(facilityWeldRecordId(BOOK, ' np-2 ')).toBe(facilityWeldRecordId(BOOK, 'NP-2'))
  })
})

describe('different records get different ids', () => {
  it('across weld numbers', () => {
    expect(facilityWeldRecordId(BOOK, '1')).not.toBe(facilityWeldRecordId(BOOK, '2'))
  })

  it('across books', () => {
    expect(facilityWeldRecordId(BOOK, '1')).not.toBe(facilityWeldRecordId(LINE, '1'))
  })

  it('across lines, which is the whole point on a flowline book', () => {
    // Weld 1 exists on every sheet and they are different welds.
    expect(flowlineWeldRecordId(LINE, '1')).not.toBe(flowlineWeldRecordId(BOOK, '1'))
  })

  it('across record kinds, so weld 1 and pressure test 1 never collide', () => {
    expect(recordId('weld', BOOK, '1')).not.toBe(recordId('pressure_test', BOOK, '1'))
  })
})

describe('the UUID itself', () => {
  it('sets the version and variant bits RFC 4122 requires', () => {
    // Without these a value can still look like a UUID and be rejected by
    // stricter parsers than Postgres's.
    const id = recordId('weld', BOOK, '1140')
    expect(id[14]).toBe('5')
    expect(['8', '9', 'a', 'b']).toContain(id[19])
  })

  it('matches the published RFC 4122 v5 vector', () => {
    // Namespace DNS, name "www.example.org". Hand-rolling the algorithm
    // is only safe if it agrees with somebody else's.
    expect(uuidV5('www.example.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'))
      .toBe('74738ff5-5367-5958-9aee-98fffdcd1876')
  })
})

// ---------------------------------------------------------------------

/**
 * The guard that was missing, on the rows that actually reach a write.
 *
 * Asserting on the id functions alone would not have caught this: the
 * live torque importer uses `facilityTorqueRecordId`, while a second,
 * unused `toTorqueRecords` sits beside it, and only one of them is on the
 * path to the database. So this walks the real record builders.
 */
describe('every record an importer hands to the database', () => {
  it('carries an id the uuid column will take', async () => {
    const { facilityTorqueRecordId } = await import('@/lib/import/facilityTorqueLog')
    const { toPressureTestRecords } = await import('@/lib/import/pressureTestLog')

    const ids = [
      facilityWeldRecordId(BOOK, '1140'),
      flowlineWeldRecordId(LINE, '7'),
      facilityTorqueRecordId(BOOK, '2-PF-21024-DCL', '2-PF-21024'),
      // The no-isometric branch, which is a different key entirely.
      facilityTorqueRecordId(BOOK, '2-PF-21024-DCL', null),
      ...toPressureTestRecords(
        [{ testIdentifier: 'Test #1 B-Spec' }] as never[], { jobBookId: BOOK },
      ).map((t) => t.id),
    ]

    expect(ids).toHaveLength(5)
    for (const id of ids) expect(id).toMatch(UUID)
  })

  it('keeps a flange with an isometric distinct from one without', () => {
    // Same flange, different key. They must not collapse onto one row.
    expect(recordId('torque_connection', BOOK, '2-PF-21024', 'F1'))
      .not.toBe(recordId('torque_connection', BOOK, 'F1'))
  })
})
