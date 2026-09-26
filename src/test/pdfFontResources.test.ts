/**
 * Finding the font that decodes a page.
 *
 * A subset-embedded font draws glyph codes, not characters: the byte 4 is
 * whatever the font's fourth glyph happens to be, and only the font's
 * ToUnicode map says it is an `A`. Miss the map and a page of perfectly
 * good text comes out as control characters — and reads, to anyone
 * looking, like a scan with no text layer at all.
 *
 * Two ways that happened, both found on real welder qualification
 * certificates that this reader called unreadable:
 *
 *   · the page declared its fonts by reference — `/Font 24 0 R` — and
 *     only the inline form `/Font << … >>` was being read, so the fonts
 *     drawing the entire form were never found;
 *
 *   · the literal string operator `(…) Tj` never had the font map
 *     applied. Only hex strings did. These pages draw their text as
 *     literals holding raw glyph codes.
 *
 * The PDFs here are built rather than checked in. The real certificates
 * carry names and partial social security numbers and have no business in
 * a repository; what needs testing is the mechanism, and a constructed
 * file exercises it exactly.
 */
import { describe, expect, it } from 'vitest'
import { extractPdfText } from '@/lib/import/pdfText'
import { toUnicodeMaps } from '@/lib/import/pdfCmap'

/** A ToUnicode CMap mapping glyph codes 1.. onto the given text. */
function cmapFor(text: string): string {
  const pairs = [...text].map((ch, i) =>
    `<${(i + 1).toString(16).padStart(2, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`)
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n` +
    `${pairs.length} beginbfchar\n${pairs.join('\n')}\nendbfchar\n` +
    `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
}

/** The glyph codes that draw `text` through the map `cmapFor` builds. */
const codesFor = (text: string) =>
  [...text].map((_, i) => String.fromCharCode(i + 1)).join('')

/**
 * A one-page PDF whose font is declared the way `declare` says.
 *
 * `inline`   /Font << /R16 16 0 R >>
 * `indirect` /Font 24 0 R, with object 24 holding the dictionary
 */
function pdfWithFont(text: string, declare: 'inline' | 'indirect'): Uint8Array {
  const cmap = cmapFor(text)
  const drawn = codesFor(text).replace(/([()\\])/g, '\\$1')
  const content = `BT /R16 12 Tf 1 0 0 1 60 700 Tm (${drawn}) Tj ET`
  const fontRes = declare === 'inline'
    ? '/Font << /R16 16 0 R >>'
    : '/Font 24 0 R'

  let pdf = '%PDF-1.4\n'
  pdf += `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n`
  pdf += `2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n`
  pdf += `3 0 obj<< /Type /Page /Parent 2 0 R /Resources << ${fontRes} >> ` +
    `/Contents 4 0 R >>endobj\n`
  pdf += `4 0 obj<< /Length ${content.length} >>stream\n${content}\nendstream endobj\n`
  pdf += `16 0 obj<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Arial ` +
    `/ToUnicode 17 0 R >>endobj\n`
  pdf += `17 0 obj<< /Length ${cmap.length} >>stream\n${cmap}\nendstream endobj\n`
  if (declare === 'indirect') pdf += `24 0 obj<< /R16 16 0 R >>endobj\n`
  pdf += `trailer<< /Root 1 0 R >>\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

const TEXT = 'Stamp Number MH'

describe('a font declared inline', () => {
  it('is found, as it always was', () => {
    expect([...toUnicodeMaps(pdfWithFont(TEXT, 'inline')).keys()]).toContain('R16')
  })
})

describe('a font declared by reference', () => {
  it('is found through the object the reference points at', () => {
    // `/Font 24 0 R` rather than `/Font << … >>`. The welder
    // qualification certificates declare their first page this way, and
    // the first page is where every field worth reading sits.
    expect([...toUnicodeMaps(pdfWithFont(TEXT, 'indirect')).keys()]).toContain('R16')
  })

  it('decodes the page instead of yielding control characters', () => {
    const x = extractPdfText(pdfWithFont(TEXT, 'indirect'))
    expect(x.pages[0]!.lines[0]!.text).toBe(TEXT)
  })

  it('reads the same as the inline form, which is the point', () => {
    const inline = extractPdfText(pdfWithFont(TEXT, 'inline'))
    const indirect = extractPdfText(pdfWithFont(TEXT, 'indirect'))
    expect(indirect.pages[0]!.lines[0]!.text).toBe(inline.pages[0]!.lines[0]!.text)
  })
})

describe('the literal string operator', () => {
  it('goes through the font map like a hex string does', () => {
    // `(\u0001\u0002) Tj` holds glyph codes, not characters. Without the
    // map these are bytes 1 and 2 — a page of them looks like a scan.
    const x = extractPdfText(pdfWithFont('ABC', 'inline'))
    expect(x.pages[0]!.lines[0]!.text).toBe('ABC')
  })

  it('keeps a character the map does not cover rather than dropping it', () => {
    // A font map that covers part of a page must not silently delete the
    // rest of it. Losing text is worse than showing it unconverted.
    const pdf = Buffer.from(pdfWithFont('AB', 'inline')).toString('latin1')
      .replace('(\u0001\u0002) Tj', '(\u0001\u0002Z) Tj')
    const x = extractPdfText(new Uint8Array(Buffer.from(pdf, 'latin1')))
    expect(x.pages[0]!.lines[0]!.text).toBe('ABZ')
  })
})

describe('one name used for two different fonts', () => {
  it('merges them rather than letting the later one win', () => {
    // Assumed rare, and it is not: a real requalification certificate
    // declares /F1 as object 62 on one page and object 86 on another.
    // Overwriting loses every code the first font uniquely defines.
    const a = cmapFor('AB')
    let pdf = '%PDF-1.4\n'
    pdf += `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n`
    pdf += `2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n`
    pdf += `3 0 obj<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 16 0 R >> >> >>endobj\n`
    pdf += `16 0 obj<< /Type /Font /ToUnicode 17 0 R >>endobj\n`
    pdf += `17 0 obj<< /Length ${a.length} >>stream\n${a}\nendstream endobj\n`
    // A second page naming /F1 for a different font, whose map covers a
    // code the first does not.
    const second = `/CIDInit begincmap\n1 beginbfchar\n<03> <0043>\nendbfchar\nendcmap`
    pdf += `5 0 obj<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 18 0 R >> >> >>endobj\n`
    pdf += `18 0 obj<< /Type /Font /ToUnicode 19 0 R >>endobj\n`
    pdf += `19 0 obj<< /Length ${second.length} >>stream\n${second}\nendstream endobj\n`
    pdf += `trailer<< /Root 1 0 R >>\n%%EOF\n`

    const map = toUnicodeMaps(new Uint8Array(Buffer.from(pdf, 'latin1'))).get('F1')!
    expect(map.get(1)).toBe('A')   // from the first font
    expect(map.get(2)).toBe('B')   // from the first font
    expect(map.get(3)).toBe('C')   // recovered from the second
  })
})
