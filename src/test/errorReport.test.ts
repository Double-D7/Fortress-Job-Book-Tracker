/**
 * Grouping failures so a broken page reports once, not once per visit.
 *
 * The rule that matters is the middle one. Group too hard and a second
 * bug hides inside the first and never gets looked at. Group too softly
 * and a page broken for the whole crew sends a hundred identical
 * reports, which is the same as sending none because nobody reads them.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  digest12, fingerprintError, normalizeMessage, referenceCode, shouldNotify, topAppFrame,
} from '@/lib/domain/errorReport'

describe('the same fault reached from different data', () => {
  it('is one group, not one per record', () => {
    // The real shape of this: the NDE page threw for every book, and the
    // id in the message was the only thing that differed.
    const a = fingerprintError({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'lines') for report 9f1c0a93-55d2-4e8b-9a01-3cbb21d6e447",
      route: '/books/[bookId]/nde',
    })
    const b = fingerprintError({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'lines') for report 2b8e455f-a4d3-4097-a9a8-d12083879e40",
      route: '/books/[bookId]/nde',
    })
    expect(a).toBe(b)
  })

  it('groups across weld numbers, heats and dates', () => {
    const one = normalizeMessage('weld 4471 on heat A104932 failed on 2025-06-05')
    const two = normalizeMessage('weld 5120 on heat B103425 failed on 2026-02-14')
    expect(one).toBe(two)
  })

  it('groups across quoted filenames', () => {
    expect(normalizeMessage("could not read 'RT REPORT TEAM 2025.02.24.pdf'"))
      .toBe(normalizeMessage("could not read 'UNEX 5155.pdf'"))
  })
})

describe('genuinely different faults', () => {
  it('stay apart when the message differs', () => {
    const a = fingerprintError({ name: 'TypeError', message: 'x is not iterable', route: '/a' })
    const b = fingerprintError({ name: 'TypeError', message: 'y is not a function', route: '/a' })
    expect(a).not.toBe(b)
  })

  it('stay apart when the same message comes from a different page', () => {
    // Same symptom on two screens is two problems to fix, and merging
    // them would close one and silently leave the other.
    const a = fingerprintError({ name: 'Error', message: 'not found', route: '/books/[bookId]/nde' })
    const b = fingerprintError({ name: 'Error', message: 'not found', route: '/books/[bookId]/torque' })
    expect(a).not.toBe(b)
  })

  it('stay apart when the error class differs', () => {
    expect(fingerprintError({ name: 'TypeError', message: 'bad', route: '/a' }))
      .not.toBe(fingerprintError({ name: 'RangeError', message: 'bad', route: '/a' }))
  })
})

describe('the stack frame used for grouping', () => {
  it('skips framework frames and takes the application one', () => {
    const stack = [
      'TypeError: r.lines is not iterable',
      '    at /var/task/node_modules/next/dist/server/render.js:120:9',
      '    at ndeCoverage (/var/task/src/lib/domain/ndeCoverage.ts:91:14)',
      '    at NdePage (/var/task/src/app/books/[bookId]/nde/page.tsx:28:15)',
    ].join('\n')
    expect(topAppFrame(stack)).toContain('ndeCoverage')
    expect(topAppFrame(stack)).not.toContain('node_modules')
  })

  it('does not let the deploy path split a group', () => {
    // The same frame has a different absolute prefix on each build, and
    // a fingerprint that moved every deploy would group nothing.
    const one = topAppFrame('E\n    at f (/var/task/src/lib/a.ts:1:1)')
    const two = topAppFrame('E\n    at f (/vercel/path0/src/lib/a.ts:1:1)')
    expect(one).toBe(two)
  })

  it('returns null when the stack is all framework', () => {
    expect(topAppFrame('E\n    at x (/var/task/node_modules/next/dist/a.js:1:1)')).toBeNull()
    expect(topAppFrame(undefined)).toBeNull()
  })
})

describe('the reference code a person reads out', () => {
  it('is the same every time for the same fault', () => {
    const fp = fingerprintError({ name: 'Error', message: 'boom', route: '/a' })
    expect(referenceCode(fp)).toBe(referenceCode(fp))
  })

  it('avoids the characters that get misheard', () => {
    // Quoted down a radio or written on a glove, so no I/O/0/1/U.
    for (const seed of ['000000000000', 'ffffffffffff', '0a1b2c3d4e5f', '9876543210ab']) {
      expect(referenceCode(seed)).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTVWXYZ]{6}$/)
    }
  })

  it('is short enough to say out loud', () => {
    expect(referenceCode('0a1b2c3d4e5f')).toHaveLength(6)
  })
})

describe('deciding whether to send an email', () => {
  const now = new Date('2026-10-04T18:00:00Z')

  it('always reports a fault nobody has seen before', () => {
    expect(shouldNotify({ lastNotifiedAt: null, now })).toBe(true)
  })

  it('stays quiet while the same fault keeps firing', () => {
    // A page broken for the whole crew throws on every view. One email
    // is a report; two hundred is noise that buries the next real one.
    expect(shouldNotify({ lastNotifiedAt: '2026-10-04T17:30:00Z', now })).toBe(false)
  })

  it('speaks up again once the window has passed', () => {
    expect(shouldNotify({ lastNotifiedAt: '2026-10-04T16:30:00Z', now })).toBe(true)
  })

  it('reports rather than swallowing when the timestamp is unreadable', () => {
    // Failing closed here would mean a real fault going unreported
    // because of a bad value in a column.
    expect(shouldNotify({ lastNotifiedAt: 'not a date', now })).toBe(true)
  })

  it('honours a window set for the caller', () => {
    expect(shouldNotify({ lastNotifiedAt: '2026-10-04T17:50:00Z', now, windowMinutes: 5 }))
      .toBe(true)
    expect(shouldNotify({ lastNotifiedAt: '2026-10-04T17:58:00Z', now, windowMinutes: 5 }))
      .toBe(false)
  })
})

/**
 * `instrumentation.ts` is compiled for the edge runtime as well as for
 * Node, and webpack resolves whatever it imports regardless of the
 * runtime guard inside it. A `node:crypto` import in this module was
 * enough to fail `next build` outright while the typechecker and all
 * 1100 tests passed, so the break reached a push.
 *
 * This is the cheap guard that catches it next time.
 */
describe('what this module is allowed to depend on', () => {
  const source = readFileSync('src/lib/domain/errorReport.ts', 'utf8')

  it('imports no node builtin, because the edge runtime has none', () => {
    expect(source).not.toMatch(/from\s+['"]node:/)
    expect(source).not.toMatch(/require\(\s*['"]node:/)
  })

  it('imports nothing at all, which is what keeps it loadable anywhere', () => {
    expect(source).not.toMatch(/^\s*import\s/m)
  })
})

describe('the digest that replaced sha256', () => {
  it('is stable, and 12 hex characters', () => {
    expect(digest12('the same input')).toBe(digest12('the same input'))
    expect(digest12('x')).toMatch(/^[0-9a-f]{12}$/)
    expect(digest12('')).toMatch(/^[0-9a-f]{12}$/)
  })

  it('separates inputs that differ by one character', () => {
    expect(digest12('weld 4471 not found')).not.toBe(digest12('weld 4472 not found'))
    expect(digest12('a')).not.toBe(digest12('b'))
  })

  it('spreads a realistic run of inputs without collisions', () => {
    // The low bits are the ones kept, so a hash whose avalanche is poor
    // would show up here rather than in production six months on.
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i += 1) seen.add(digest12(`/books/[bookId]/nde|Error|row ${i}`))
    expect(seen.size).toBe(5000)
  })

  it('handles characters outside the ascii range', () => {
    expect(digest12('wall thickness 9.5 mm ±0.1')).toMatch(/^[0-9a-f]{12}$/)
  })
})
