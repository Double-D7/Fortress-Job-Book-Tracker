/**
 * Reading text that is drawn as glyph numbers.
 *
 * Four of the five real NDE reports from Chevron's inspection vendor draw
 * every character as a glyph id against a font embedded in that one file.
 * Before this, the extractor returned zero pages for all four — the weld
 * numbers were sitting in the document and unreachable.
 */
import { describe, expect, it } from 'vitest'
import { decodeHexString, parseCMap } from '@/lib/import/pdfCmap'

/** The two forms these files actually use, as they appear in the stream. */
const BFCHAR = `
/CIDInit /ProcSet findresource begin
1 begincmap
2 beginbfchar
<002C> <0049>
<0034> <0051>
endbfchar
endcmap
`

const BFRANGE_LINEAR = `
1 beginbfrange
<0024> <0026> <0041>
endbfrange
`

const BFRANGE_LISTED = `
1 beginbfrange
<0010> <0012> [<0046> <0057> <0021>]
endbfrange
`

describe('bfchar: one code, one character', () => {
  it('maps each pair', () => {
    const m = parseCMap(BFCHAR)
    expect(m.get(0x002c)).toBe('I')
    expect(m.get(0x0034)).toBe('Q')
  })

  it('leaves an unlisted code unmapped rather than guessing', () => {
    // On a document whose point is a weld number, a decoder that invents
    // a digit is worse than one that admits it cannot read.
    expect(parseCMap(BFCHAR).get(0x0099)).toBeUndefined()
  })
})

describe('bfrange: consecutive codes', () => {
  it('advances the character across the range', () => {
    // The mistake worth pinning: mapping every code in the range to the
    // same character, which turns "ABC" into "AAA".
    const m = parseCMap(BFRANGE_LINEAR)
    expect(m.get(0x0024)).toBe('A')
    expect(m.get(0x0025)).toBe('B')
    expect(m.get(0x0026)).toBe('C')
  })

  it('takes a listed destination array in order', () => {
    const m = parseCMap(BFRANGE_LISTED)
    expect(m.get(0x0010)).toBe('F')
    expect(m.get(0x0011)).toBe('W')
    expect(m.get(0x0012)).toBe('!')
  })

  it('ignores a range too large to be a font', () => {
    // A malformed map should not hang the upload of a file somebody
    // chose; expanding 2^32 entries would.
    const m = parseCMap('beginbfrange\n<0000> <FFFFFF> <0041>\nendbfrange')
    expect(m.size).toBe(0)
  })

  it('ignores a backwards range', () => {
    expect(parseCMap('beginbfrange\n<0030> <0020> <0041>\nendbfrange').size).toBe(0)
  })
})

describe('multi-character destinations', () => {
  it('maps one glyph to the several characters it stands for', () => {
    // A ligature: one code, "ffi".
    const m = parseCMap('beginbfchar\n<0001> <00660066006900>\nendbfchar')
    expect(m.get(0x0001)?.startsWith('ff')).toBe(true)
  })
})

describe('decoding a hex string', () => {
  const wide = parseCMap(BFCHAR)

  it('reads two-byte codes for a Type0 font', () => {
    expect(decodeHexString('002C0034', wide)).toBe('IQ')
  })

  it('reads one-byte codes when the font is simple', () => {
    // Guessing the width the other way turns every character into a miss.
    const narrow = parseCMap('beginbfchar\n<41> <0058>\n<42> <0059>\nendbfchar')
    expect(decodeHexString('4142', narrow)).toBe('XY')
  })

  it('contributes nothing for a code the font does not map', () => {
    expect(decodeHexString('002C9999', wide)).toBe('I')
  })

  it('returns nothing at all without a map', () => {
    // The pre-existing behaviour for literal-string PDFs must not change:
    // no map means this was never hex-encoded text to begin with.
    expect(decodeHexString('002C', undefined)).toBe('')
    expect(decodeHexString('002C', new Map())).toBe('')
  })

  it('ignores a trailing half code rather than misreading it', () => {
    expect(decodeHexString('002C00', wide)).toBe('I')
  })
})

describe('a map that cannot be parsed', () => {
  it('yields nothing rather than throwing', () => {
    // A bad map in one font must not cost the literal-string text the
    // extractor could always read in the same file.
    for (const junk of ['', 'not a cmap', 'beginbfchar endbfchar']) {
      expect(parseCMap(junk).size, junk).toBe(0)
    }
  })
})
