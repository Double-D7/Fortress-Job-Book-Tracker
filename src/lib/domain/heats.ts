/**
 * Heat numbers, and finding one in a filename.
 *
 * WHY THIS IS NOT A PDF PARSER. Every other register in this book gets
 * one — the weld log, the torque log, the pressure sheet all read the
 * real document. MTRs do not, and the reason is in the files themselves:
 * of the five real mill certificates this was built against, FOUR have
 * no text layer at all. They are scans — JPEG and CCITT image data, no
 * font objects, nothing to extract. The fifth has text behind a
 * custom-encoded subset font.
 *
 * So the heat number cannot be read out of the document reliably, and
 * OCR is the wrong answer here rather than the hard one. A misread heat
 * number does not fail loudly: it silently files the wrong mill
 * certificate against a weld, and §15 then reports the material as
 * traceable when it is traceable to the wrong steel. "No MTR on file" is
 * a problem somebody fixes. "The wrong MTR on file, and the system says
 * it is fine" is a problem nobody looks for.
 *
 * What this does instead is suggest, from the filename, and let a person
 * confirm. Fortress's own naming convention puts the heat number last —
 * `4_CL900_FLG_3DM31`, `.75-XXH-_D07821` — and that held on all five
 * samples. A suggestion a human accepts in one keystroke is worth more
 * than an extraction nobody checks.
 */

/**
 * The form a heat number is stored and displayed in.
 *
 * Conservative on purpose: uppercased and trimmed, internal whitespace
 * collapsed, and nothing else removed. A hyphen or a slash inside a heat
 * number may be part of it — mills are not consistent — and throwing
 * away a character that turns out to be significant is not recoverable
 * from the stored value.
 */
export function normalizeHeat(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ')
}

/**
 * The key two heat numbers are matched on.
 *
 * Looser than the stored form: letters and digits only. "D-07821" and
 * "D07821" are the same steel written down twice by different people,
 * and a library that failed to match them would send somebody hunting
 * for a certificate that is already filed.
 *
 * The cost is that two genuinely different heats differing ONLY by
 * punctuation would collide. `collidingHeats` below is what surfaces
 * that, rather than letting it resolve silently.
 */
export function heatKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function sameHeat(a: string, b: string): boolean {
  const ka = heatKey(a)
  return ka.length > 0 && ka === heatKey(b)
}

/**
 * Does this look like a heat number at all?
 *
 * Deliberately permissive — mills issue everything from `MF3` to
 * `3DM31` to `D07821` — but not so permissive that it accepts the
 * descriptive parts of a filename. The rules that matter: it has to
 * contain a digit, and it has to be short. `FLG`, `SCH`, `ELBOW` and
 * `STD` all fail the digit test; `CL600` and `CL900` pass it, which is
 * why position matters as well as shape.
 */
export function looksLikeHeat(token: string): boolean {
  const t = token.trim()
  if (t.length < 2 || t.length > 20) return false
  if (!/\d/.test(t)) return false
  return /^[A-Za-z0-9][A-Za-z0-9\-/.]*$/.test(t)
}

/** Descriptive tokens that are never a heat number, however they look. */
const NOT_A_HEAT = new Set([
  'SCH', 'STD', 'XS', 'XXS', 'XXH', 'FLG', 'FLANGE', 'ELBOW', 'ELL', 'TEE',
  'CAP', 'REDUCER', 'RED', 'NIPPLE', 'COUP', 'COUPLING', 'PIPE', 'WN', 'SW',
  'RF', 'RTJ', 'BW', 'THD', 'MTR', 'CERT', 'LR', 'SR', 'CS', 'SS',
])

/**
 * Names a scanner or a phone gave the file, which carry no heat number
 * however much they look like one.
 *
 * `scan0001` is letters followed by digits and is structurally
 * indistinguishable from `D07821`. The difference is that a folder of
 * `scan0001 … scan0500` would suggest five hundred confident heat
 * numbers, and a bulk upload where somebody accepts the suggestions is
 * exactly the silent-wrong-data failure this module exists to prevent.
 */
const SCANNER_DEFAULT = /^(scan|img|image|dsc|doc|document|page|pg|untitled|new|file|copy)[\s_-]*\d*$/i

/**
 * The heat number a filename is offering, if any.
 *
 * Fortress's convention puts it last: everything before it describes the
 * item. So this walks the tokens from the end and takes the first that
 * could be a heat number and is not obviously a size, a class or a
 * fitting type.
 *
 * Returns null rather than guessing when nothing qualifies. A wrong
 * suggestion that somebody accepts without reading is the failure this
 * whole module is arranged to avoid, so a blank field is the better
 * answer when the filename does not say.
 */
export function heatFromFilename(filename: string): string | null {
  // Drop the extension and any upload prefix like `ce3ff815-`.
  const base = filename.replace(/\.[A-Za-z0-9]+$/, '')
  const withoutPrefix = base.replace(/^[0-9a-f]{8}-(?=.)/i, '')

  const tokens = withoutPrefix
    .split(/[\s_\-]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!
    if (NOT_A_HEAT.has(t.toUpperCase())) continue
    if (SCANNER_DEFAULT.test(t)) continue
    // A bare size or class: 4, .75, 600. The heat numbers in real
    // certificates carry at least one letter, or are long enough not to
    // be a dimension.
    if (/^[\d.]+$/.test(t) && t.replace(/\D/g, '').length < 5) continue
    // `CL600`, `CL900` — a pressure class, not a heat.
    if (/^CL\d+$/i.test(t)) continue
    if (looksLikeHeat(t)) return normalizeHeat(t)
  }
  return null
}

/**
 * Heat numbers that would collide on the matching key.
 *
 * Called when the library is listed, so that two certificates filed
 * under `D-07821` and `D07821` are shown as the one problem they are
 * rather than resolving to whichever the query returned first.
 */
export function collidingHeats(heats: string[]): string[][] {
  const byKey = new Map<string, Set<string>>()
  for (const h of heats) {
    const k = heatKey(h)
    if (!k) continue
    const set = byKey.get(k) ?? new Set<string>()
    set.add(normalizeHeat(h))
    byKey.set(k, set)
  }
  return [...byKey.values()]
    .filter((s) => s.size > 1)
    .map((s) => [...s].sort())
}
