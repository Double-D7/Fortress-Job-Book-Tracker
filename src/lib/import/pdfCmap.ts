/**
 * Decoding text that is drawn as glyph numbers.
 *
 * `pdfText` reads literal strings — `(Fortress) Tj` — and that covers the
 * PDFs this project met first. The NDE reports from Chevron's inspection
 * vendor are not written that way. They draw every character as a glyph
 * id against an embedded subset font:
 *
 *     /F2 10.859400 Tf
 *     [<002C>-0.832031<0034>-0.832031<0038>-0.167969] TJ
 *
 * `<002C>` is not a character. It is the 44th glyph of a font that exists
 * only inside this one file, and in the next report the same weld number
 * will be a different number. Four of the five real reports are written
 * this way, so without this the NDE section can only ever be typed by
 * hand — which is what it has been.
 *
 * The recovery is `/ToUnicode`: a CMap the writer embeds precisely so the
 * text can be read back. Every one of those reports carries one per font.
 * This module finds them and turns them into lookup tables.
 *
 * ## What it deliberately does not do
 *
 * It does not guess. A code with no entry in its font's map yields
 * nothing rather than a plausible-looking character — on a document whose
 * point is a weld number, a decoder that invents a digit is worse than
 * one that admits it cannot read. `pdfText` surfaces that as missing text
 * rather than as confident nonsense.
 */
import { inflateSync } from 'node:zlib'

/** Font resource name (`F1`, `F2`, …) → glyph code → the text it means. */
export type FontMaps = Map<string, Map<number, string>>

/** One indirect object's body, by object number. */
function indirectObjects(buf: Buffer): Map<number, { body: string; start: number; end: number }> {
  const s = buf.toString('latin1')
  const out = new Map<number, { body: string; start: number; end: number }>()
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const num = Number(m[1])
    const start = m.index! + m[0].length
    const end = s.indexOf('endobj', start)
    if (end < 0) continue
    // A later definition of the same object wins: that is what an
    // incremental update means, and these files are revised in place.
    out.set(num, { body: s.slice(start, end), start, end })
  }
  return out
}

/** The bytes of a stream inside an object body, inflated when it will. */
function streamOf(buf: Buffer, obj: { start: number; end: number }): string | null {
  const s = buf.toString('latin1')
  const i = s.indexOf('stream', obj.start)
  if (i < 0 || i > obj.end) return null
  let p = i + 'stream'.length
  if (s.charCodeAt(p) === 0x0d) p += 1
  if (s.charCodeAt(p) === 0x0a) p += 1
  const e = s.indexOf('endstream', p)
  if (e < 0) return null
  const chunk = Buffer.from(s.slice(p, e), 'latin1')
  try {
    return inflateSync(chunk).toString('latin1')
  } catch {
    return chunk.toString('latin1')
  }
}

/** `<0041>` → 0x41. Hex of any width, as CMaps use 2 and 4 digit codes. */
function hexToInt(hex: string): number {
  return parseInt(hex, 16)
}

/**
 * `<00410042>` → "AB".
 *
 * Destinations are UTF-16BE, and may hold several code units for one
 * glyph — a ligature maps one code to "ffi". Surrogate pairs are left to
 * `String.fromCharCode`, which composes them correctly.
 */
function hexToText(hex: string): string {
  let out = ''
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = hex.slice(i, i + 4)
    if (unit.length < 4) break
    out += String.fromCharCode(parseInt(unit, 16))
  }
  return out
}

/**
 * Parse one ToUnicode CMap.
 *
 * Two forms carry everything these files use:
 *   `beginbfchar  <src> <dst>  endbfchar`
 *   `beginbfrange <lo> <hi> <dst>` — consecutive codes, consecutive text
 *   `beginbfrange <lo> <hi> [<d0> <d1> …]` — consecutive codes, listed text
 */
export function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>()

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(hexToInt(pair[1]!), hexToText(pair[2]!))
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!
    // The listed form first: its brackets would otherwise be read as a
    // destination by the simpler pattern.
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = hexToInt(r[1]!)
      let i = 0
      for (const d of r[3]!.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        map.set(lo + i, hexToText(d[1]!))
        i += 1
      }
    }
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = hexToInt(r[1]!)
      const hi = hexToInt(r[2]!)
      const dst = r[3]!
      // A range of more than a few thousand is a malformed map, not a
      // font; expanding it would hang on a file somebody uploaded.
      if (hi < lo || hi - lo > 65535) continue
      const base = hexToText(dst)
      const tail = base.charCodeAt(base.length - 1)
      for (let c = lo; c <= hi; c++) {
        // Only the last unit advances, which is what the spec says and
        // what makes "A".."Z" come out as letters rather than as one
        // repeated character.
        map.set(c, base.slice(0, -1) + String.fromCharCode(tail + (c - lo)))
      }
    }
  }

  return map
}

/**
 * Every font resource name in the document, mapped to its decoder.
 *
 * Names are collected per resource dictionary and merged. A document that
 * used `/F1` for different fonts on different pages would be ambiguous
 * here — that is rare in generated reports, and the alternative is
 * resolving page resource trees, which is a great deal of machinery for a
 * case these files do not present. Where it happens, later definitions
 * win and the damage is confined to that name.
 */
export function toUnicodeMaps(input: Buffer | Uint8Array): FontMaps {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const objects = indirectObjects(buf)
  const maps: FontMaps = new Map()

  // font object number → its parsed CMap
  const byFontObj = new Map<number, Map<number, string>>()
  for (const [num, obj] of objects) {
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.body)
    if (!ref) continue
    const target = objects.get(Number(ref[1]))
    if (!target) continue
    const cmap = streamOf(buf, target)
    if (!cmap) continue
    const parsed = parseCMap(cmap)
    if (parsed.size > 0) byFontObj.set(num, parsed)
  }

  // resource dictionaries: /Font << /F1 12 0 R /F2 13 0 R >>
  const s = buf.toString('latin1')
  for (const res of s.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
    for (const entry of res[1]!.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const parsed = byFontObj.get(Number(entry[2]))
      if (parsed) maps.set(entry[1]!, parsed)
    }
  }

  return maps
}

/**
 * Decode one hex string through a font's map.
 *
 * Codes are two bytes for the Type0 fonts these reports use. A map whose
 * keys are all single-byte says the font is simple, and the string is
 * read a byte at a time instead — guessing the width the other way turns
 * every character into a miss.
 */
export function decodeHexString(hex: string, map: Map<number, string> | undefined): string {
  if (!map || map.size === 0) return ''
  const wide = [...map.keys()].some((k) => k > 0xff)
  const step = wide ? 4 : 2
  let out = ''
  for (let i = 0; i + step <= hex.length; i += step) {
    const code = parseInt(hex.slice(i, i + step), 16)
    // Missing codes contribute nothing rather than a guess.
    out += map.get(code) ?? ''
  }
  return out
}
