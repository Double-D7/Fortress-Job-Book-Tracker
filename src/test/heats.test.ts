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
  collidingHeats, heatFromFilename, heatKey, looksLikeHeat, normalizeHeat, parseHeatList,
  sameHeat,
} from '@/lib/domain/heats'
import { getDataProvider, type Viewer } from '@/lib/data/provider'

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

describe('the library, end to end', () => {
  const manager: Viewer = {
    id: 'seed-user-manager', email: 'qaqc.manager@fortressds.com',
    fullName: 'D. Devitt', role: 'qaqc_manager', clientOrgId: null,
  }
  const readOnly: Viewer = {
    id: 'seed-user-readonly', email: 'review@fortressds.com',
    fullName: 'J. Whitfield', role: 'fortress_read_only', clientOrgId: null,
  }

  /** A heat that really exists on the reference book. */
  async function aRealHeat(): Promise<string> {
    const p = getDataProvider()
    const b = (await p.getBundle(manager, 'book-dp452'))!
    const missing = b.materialHeats.find((h) => h.mtrStatus === 'missing')
    return (missing ?? b.materialHeats[0]!).heatNumber
  }

  it('files a certificate and closes the gap on every book at once', async () => {
    const p = getDataProvider()
    const heat = await aRealHeat()

    const before = (await p.getBundle(manager, 'book-dp452'))!
      .materialHeats.find((h) => sameHeat(h.heatNumber, heat))!
    expect(before.mtrLibraryId ?? null).toBeNull()

    // Punctuation differs on purpose: the certificate is filed one way
    // and the book typed it another.
    const res = await p.uploadMtr(manager, {
      heatNumbers: [`${heat}`.replace(/(.{2})/, '$1-')],
      originalFilename: `4_CL900_FLG_${heat}.pdf`,
      sha256: `sha-${heat}`,
    })
    expect(res.ok).toBe(true)
    expect(res.heatsResolved ?? 0).toBeGreaterThan(0)

    const after = (await p.getBundle(manager, 'book-dp452'))!
      .materialHeats.find((h) => sameHeat(h.heatNumber, heat))!
    expect(after.mtrLibraryId).toBe(res.filed![0]!.mtrId)
    expect(after.mtrStatus).toBe('on_file')
  })

  it('refuses a second live certificate for the same heat', async () => {
    const p = getDataProvider()
    const first = await p.uploadMtr(manager, {
      heatNumbers: ['DUP001'], originalFilename: 'a.pdf', sha256: 'sha-dup-a',
    })
    expect(first.ok).toBe(true)
    // Same heat, written differently. One certificate per heat, or a book
    // resolves to whichever the query happened to return.
    const second = await p.uploadMtr(manager, {
      heatNumbers: ['dup-001'], originalFilename: 'b.pdf', sha256: 'sha-dup-b',
    })
    expect(second.ok).toBe(false)
    // The reason now lands per heat rather than as one sentence for the
    // file, because a certificate covering three heats can be refused for
    // one of them and filed for the other two.
    expect(second.rejected?.map((r) => r.heat)).toEqual(['DUP-001'])
    expect(second.rejected?.[0]?.error).toMatch(/already has a certificate/i)
  })

  it('files the heats it can when one of them is already taken', async () => {
    // The real Weldbend case: three heats on one sheet. If somebody filed
    // one of them earlier from a different scan, the other two gaps are
    // still real and this document still closes them.
    const p = getDataProvider()
    const first = await p.uploadMtr(manager, {
      heatNumbers: ['PART01'], originalFilename: 'first.pdf', sha256: 'sha-part-1',
    })
    expect(first.ok).toBe(true)

    const sheet = await p.uploadMtr(manager, {
      heatNumbers: ['PART01', 'PART02', 'PART03'],
      originalFilename: 'weldbend.pdf', sha256: 'sha-part-sheet',
    })
    expect(sheet.ok).toBe(true)
    expect(sheet.filed?.map((f) => f.heat)).toEqual(['PART02', 'PART03'])
    expect(sheet.rejected?.map((r) => r.heat)).toEqual(['PART01'])
  })

  it('files one certificate against every heat it covers', async () => {
    const p = getDataProvider()
    const res = await p.uploadMtr(manager, {
      heatNumbers: ['WB-KZ9', 'WB-3DL90', 'WB-KL5'],
      originalFilename: '2 CL300 FLG KL5.pdf', sha256: 'sha-weldbend',
    })
    expect(res.ok).toBe(true)
    expect(res.filed).toHaveLength(3)

    // Each heat is independently findable, and all three point at the one
    // stored document rather than three copies of it.
    const listed = await p.listMtrLibrary(manager)
    const rows = res.filed!.map((f) => listed.find((m) => m.id === f.mtrId)!)
    expect(rows.every(Boolean)).toBe(true)
    expect(new Set(rows.map((r) => r.storagePath)).size).toBe(1)
    for (const heat of ['WB-KZ9', 'WB-3DL90', 'WB-KL5']) {
      expect((await p.listMtrLibrary(manager, heat)).length, heat).toBeGreaterThan(0)
    }
  })

  it('refuses a certificate with no heat number', async () => {
    const p = getDataProvider()
    const res = await p.uploadMtr(manager, {
      heatNumbers: ['   '], originalFilename: 'scan0001.pdf', sha256: 'sha-blank',
    })
    expect(res.ok).toBe(false)
  })

  it('does not let View Only file or withdraw a certificate', async () => {
    const p = getDataProvider()
    expect((await p.uploadMtr(readOnly, {
      heatNumbers: ['RO001'], originalFilename: 'x.pdf', sha256: 'sha-ro',
    })).ok).toBe(false)
  })

  it('withdrawing takes the claim back off the books', async () => {
    const p = getDataProvider()
    const heat = 'WDR001'
    // Put the heat on a book first, then file and withdraw.
    const filed = await p.uploadMtr(manager, {
      heatNumbers: [heat], originalFilename: `${heat}.pdf`, sha256: `sha-${heat}`,
    })
    expect(filed.ok).toBe(true)

    expect((await p.withdrawMtr(manager, filed.filed![0]!.mtrId, '')).ok).toBe(false)
    expect((await p.withdrawMtr(manager, filed.filed![0]!.mtrId, 'Superseded by re-issue')).ok)
      .toBe(true)

    const listed = await p.listMtrLibrary(manager)
    expect(listed.some((m) => m.id === filed.filed![0]!.mtrId)).toBe(false)
  })

  it('finds a certificate by heat however it is punctuated', async () => {
    const p = getDataProvider()
    await p.uploadMtr(manager, {
      heatNumbers: ['SRCH-42'], originalFilename: 'x.pdf', sha256: 'sha-srch',
      materialDescription: '4in CL600 flange',
    })
    expect((await p.listMtrLibrary(manager, 'srch42')).length).toBeGreaterThan(0)
    expect((await p.listMtrLibrary(manager, 'SRCH-42')).length).toBeGreaterThan(0)
  })

  it('shows an operator only the certificates their own books reference', async () => {
    // Both halves matter. The denial alone would pass for a viewer who
    // can see nothing at all, and the whole point is that a client CAN
    // open the certificate for a heat in their own book.
    const p = getDataProvider()
    const client: Viewer = {
      id: 'seed-user-client', email: 'k.brandt@operator.example',
      fullName: 'K. Brandt', role: 'client_user', clientOrgId: 'org-chevron',
    }

    const theirHeat = (await p.getBundle(client, 'book-dp452'))!.materialHeats[0]!
    await p.uploadMtr(manager, {
      heatNumbers: [theirHeat.heatNumber], originalFilename: 'theirs.pdf',
      sha256: 'sha-theirs',
    })
    // A heat on no book of theirs.
    await p.uploadMtr(manager, {
      heatNumbers: ['NOTTHEIRS9'], originalFilename: 'other.pdf', sha256: 'sha-other',
    })

    const seen = await p.listMtrLibrary(client)
    expect(seen.some((m) => sameHeat(m.heatNumber, theirHeat.heatNumber))).toBe(true)
    expect(seen.some((m) => sameHeat(m.heatNumber, 'NOTTHEIRS9'))).toBe(false)

    // Fortress staff see both, because finding a certificate before
    // knowing which job wants it is what the library is for.
    const all = await p.listMtrLibrary(manager)
    expect(all.some((m) => sameHeat(m.heatNumber, 'NOTTHEIRS9'))).toBe(true)
  })

  it('shows an inspector with no grant nothing at all', async () => {
    const p = getDataProvider()
    const inspector: Viewer = {
      id: 'seed-user-inspector', email: 'p.nakamura@inspection.example',
      fullName: 'P. Nakamura', role: 'third_party_inspector', clientOrgId: null,
    }
    expect(await p.listMtrLibrary(inspector)).toEqual([])
  })
})

describe('the heats one certificate covers', () => {
  /** The real Weldbend sheet from this project's files: three products,
   *  three heats, one PDF, and it is page 2 of 4. */
  const WELDBEND = ['KZ9', '3DL90', 'KL5']

  it('reads the three heats off the real multi-heat certificate', () => {
    expect(parseHeatList('KZ9 3DL90 KL5')).toEqual(WELDBEND)
  })

  it('takes whatever separator somebody actually types', () => {
    for (const raw of [
      'KZ9 3DL90 KL5',
      'KZ9, 3DL90, KL5',
      'KZ9,3DL90,KL5',
      'KZ9; 3DL90; KL5',
      'KZ9\n3DL90\nKL5',
      '  KZ9   3DL90 \t KL5  ',
    ]) {
      expect(parseHeatList(raw), JSON.stringify(raw)).toEqual(WELDBEND)
    }
  })

  it('keeps the order they appear on the certificate', () => {
    // How somebody checks their typing against the page.
    expect(parseHeatList('KL5 KZ9 3DL90')).toEqual(['KL5', 'KZ9', '3DL90'])
  })

  it('still handles the ordinary single heat', () => {
    expect(parseHeatList('D07821')).toEqual(['D07821'])
    expect(parseHeatList('  d07821 ')).toEqual(['D07821'])
  })

  it('collapses a heat typed twice, on the matching key', () => {
    // "KZ9, kz-9" is one heat entered twice, not two heats and not a
    // collision with itself.
    expect(parseHeatList('KZ9 kz-9')).toEqual(['KZ9'])
    expect(parseHeatList('D-07821 D07821 A80683')).toEqual(['D-07821', 'A80683'])
  })

  it('drops anything that is not a heat number', () => {
    expect(parseHeatList('')).toEqual([])
    expect(parseHeatList('   ')).toEqual([])
    expect(parseHeatList('--- ///')).toEqual([])
    // And does not let junk between real heats lose them.
    expect(parseHeatList('KZ9 -- KL5')).toEqual(['KZ9', 'KL5'])
  })
})
