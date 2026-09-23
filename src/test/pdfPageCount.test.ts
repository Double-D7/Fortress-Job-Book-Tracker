/**
 * Counting pages, including in the scans nothing else can read.
 *
 * The real certificates are the point: four of the five in this project
 * have no text layer at all, and this has to answer for them anyway.
 */
import { describe, expect, it } from 'vitest'

import { pdfPageCount } from '@/lib/import/pdfPageCount'

function pdf(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'latin1'))
}

describe('reading the page count out of the structure', () => {
  it('trusts the page tree when it states a count', () => {
    expect(pdfPageCount(pdf(
      '%PDF-1.4\n1 0 obj<</Type/Pages/Kids[2 0 R 3 0 R 4 0 R]/Count 3>>endobj\n',
    ))).toBe(3)
  })

  it('tolerates the spacing real writers produce', () => {
    for (const body of [
      '<</Type /Pages /Kids[2 0 R] /Count 7>>',
      '<</Type/Pages/Count 7/Kids[2 0 R]>>',
      '<< /Type  /Pages\n   /Count   7 >>',
    ]) {
      expect(pdfPageCount(pdf(`%PDF-1.4\n${body}`)), body).toBe(7)
    }
  })

  it('falls back to counting page objects', () => {
    // No /Pages node with a count — count the leaves instead.
    expect(pdfPageCount(pdf(
      '%PDF-1.4\n2 0 obj<</Type/Page/MediaBox[0 0 612 792]>>endobj\n' +
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]>>endobj\n',
    ))).toBe(2)
  })

  it('does not count the page tree as a page', () => {
    // `/Type /Page` inside `/Type /Pages` is the obvious way to get this
    // wrong, and it inflates every document by one.
    expect(pdfPageCount(pdf(
      '%PDF-1.4\n1 0 obj<</Type/Pages/Kids[2 0 R]>>endobj\n' +
      '2 0 obj<</Type/Page>>endobj\n',
    ))).toBe(1)
  })

  it('takes the largest count in a linearised file', () => {
    // Linearised PDFs repeat the page tree; a fragment states fewer.
    expect(pdfPageCount(pdf(
      '%PDF-1.5\n<</Type/Pages/Count 1>>\n<</Type/Pages/Count 4>>\n',
    ))).toBe(4)
  })

  it('says null rather than guessing', () => {
    // Every caller displays this. "Could not tell" must not read as "one".
    for (const junk of ['', 'not a pdf at all', '%PDF-1.4\nnothing useful\n']) {
      expect(pdfPageCount(pdf(junk)), JSON.stringify(junk)).toBeNull()
    }
  })

  it('refuses an implausible count rather than reporting it', () => {
    expect(pdfPageCount(pdf('%PDF-1.4\n<</Type/Pages/Count 99999999>>'))).toBeNull()
    expect(pdfPageCount(pdf('%PDF-1.4\n<</Type/Pages/Count 0>>'))).toBeNull()
  })
})

describe('what the real certificates showed', () => {
  /**
   * Measured against the five mill certificates this feature was built
   * from. Four answered; the fifth — an elbow certificate — stores its
   * page tree inside a compressed object stream, where neither pattern
   * can see it.
   *
   * That is recorded here rather than quietly worked around, because it
   * sets what the page count may be used for. It is a hint shown when it
   * is available, never a check anything depends on: a fifth of real
   * documents will not have one.
   */
  it('returns null when the page tree is inside an object stream', () => {
    // The shape of the file that defeated it: an xref stream and the page
    // objects compressed away, so the plain markers never appear.
    const compressed = pdf(
      '%PDF-1.5\n5 0 obj<</Type/ObjStm/N 4/First 20/Filter/FlateDecode>>' +
      'stream\n\x78\x9c\x01\x02\x03binary-not-readable\nendstream endobj\n' +
      'trailer<</Type/XRef/Root 1 0 R>>\n',
    )
    expect(pdfPageCount(compressed)).toBeNull()
  })

  it('never reports zero pages for a document that exists', () => {
    // Zero would read as a real answer on screen and is never true of a
    // file somebody just uploaded. Unknown has to say unknown.
    for (const sample of [
      '%PDF-1.5\n<</Type/ObjStm>>',
      '%PDF-1.4\n<</Type/Pages/Count 0>>',
      '%PDF-1.7\n',
    ]) {
      expect(pdfPageCount(pdf(sample)), sample).not.toBe(0)
    }
  })
})
