/**
 * Heat numbers, tested against the real filenames.
 *
 * The five cases in REAL_FILES are the actual mill certificates this was
 * built from, names unchanged. They matter more than any invented case:
 * a suggestion that works on a made-up convention and fails on Fortress's
 * is worse than no suggestion, because somebody will accept it.
 */
import { describe, expect, it } from 'vitest'
import {
  collidingHeats, heatFromFilename, heatKey, looksLikeHeat, normalizeHeat,
  sameHeat,
} from '@/lib/domain/heats'

/** Real filenames, with the heat number a person reads off each. */
const REAL_FILES: [string, string][] = [
  ['.75-XXH-_D07821.pdf', 'D07821'],
  ['1-SCH-80-_A80683.pdf', 'A80683'],
  ['4_CL600_FLG_MF3.pdf', 'MF3'],
  ['4_CL900_FLG_3DM31.pdf', '3DM31'],
  ['4_ELBOW_45_STD_T43672.pdf', 'T43672'],
]

describe('reading the heat number off a filename', () => {
  it('gets all five real certificates right', () => {
    for (const [filename, expected] of REAL_FILES) {
      expect(heatFromFilename(filename), filename).toBe(expected)
    }
  })

  it('survives the upload prefix the browser adds', () => {
    // Files arrive as `ce3ff815-4_CL600_FLG_MF3.pdf` once stored.
    expect(heatFromFilename('ce3ff815-4_CL600_FLG_MF3.pdf')).toBe('MF3')
    expect(heatFromFilename('442f067d-.75-XXH-_D07821.pdf')).toBe('D07821')
  })

  it('does not mistake a pressure class for a heat number', () => {
    // CL600 and CL900 both contain digits and sit near the end. Position
    // alone would have taken them.
    expect(heatFromFilename('4_CL600_FLG_MF3.pdf')).not.toBe('CL600')
    expect(heatFromFilename('4_CL900_FLG_3DM31.pdf')).not.toBe('CL900')
  })

  it('does not mistake a size or a schedule for a heat number', () => {
    expect(heatFromFilename('1-SCH-80-_A80683.pdf')).not.toBe('80')
    expect(heatFromFilename('.75-XXH-_D07821.pdf')).not.toBe('.75')
  })

  it('says nothing rather than guessing when the name does not say', () => {
    // A wrong suggestion somebody accepts without reading is the whole
    // failure this module is arranged around. Blank is the safe answer.
    for (const name of ['scan0001.pdf', 'MTR.pdf', 'untitled.pdf', 'FLANGE_STD.pdf']) {
      expect(heatFromFilename(name), name).toBeNull()
    }
  })

  it('handles a name that is only a heat number', () => {
    expect(heatFromFilename('D07821.pdf')).toBe('D07821')
  })
})

describe('matching two ways of writing the same heat', () => {
  it('matches across punctuation, because two people wrote it down', () => {
    expect(sameHeat('D-07821', 'D07821')).toBe(true)
    expect(sameHeat('3DM31', '3dm31')).toBe(true)
    expect(sameHeat(' MF3 ', 'MF3')).toBe(true)
  })

  it('does not match genuinely different heats', () => {
    expect(sameHeat('D07821', 'A80683')).toBe(false)
    expect(sameHeat('MF3', 'MF30')).toBe(false)
  })

  it('never matches on nothing', () => {
    // An empty key must not make every blank heat equal to every other.
    expect(sameHeat('', '')).toBe(false)
    expect(sameHeat('---', '///')).toBe(false)
  })
})

describe('storing a heat number', () => {
  it('uppercases and trims without discarding punctuation', () => {
    // The stored form keeps what the mill wrote. A hyphen that turns out
    // to be significant cannot be recovered once dropped.
    expect(normalizeHeat('  d-07821 ')).toBe('D-07821')
    expect(normalizeHeat('heat 3dm31')).toBe('HEAT 3DM31')
  })

  it('keys on letters and digits only', () => {
    expect(heatKey('D-07821')).toBe('D07821')
    expect(heatKey('  mf/3 ')).toBe('MF3')
  })
})

describe('looksLikeHeat', () => {
  it('accepts the shapes real mills issue', () => {
    for (const h of ['D07821', 'A80683', 'MF3', '3DM31', 'T43672']) {
      expect(looksLikeHeat(h), h).toBe(true)
    }
  })

  it('rejects a token with no digit in it', () => {
    for (const t of ['FLANGE', 'ELBOW', 'STD', 'XXH']) {
      expect(looksLikeHeat(t), t).toBe(false)
    }
  })

  it('rejects something far too long to be a heat number', () => {
    expect(looksLikeHeat('A'.repeat(40))).toBe(false)
  })
})

describe('collisions', () => {
  it('surfaces two spellings of one heat rather than picking one', () => {
    // The cost of matching loosely. Better shown than resolved silently
    // to whichever row the query happened to return first.
    expect(collidingHeats(['D-07821', 'D07821', 'A80683']))
      .toEqual([['D-07821', 'D07821']])
  })

  it('reports nothing when every heat is distinct', () => {
    expect(collidingHeats(['D07821', 'A80683', 'MF3'])).toEqual([])
  })

  it('does not report the same spelling twice as a collision', () => {
    expect(collidingHeats(['D07821', 'd07821', 'D07821'])).toEqual([])
  })
})
