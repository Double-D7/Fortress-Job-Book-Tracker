/**
 * Where each file lands in the backup folder.
 *
 * The target is the shape the job books arrived in: one folder per book,
 * numbered section folders inside it, the documents in the section they
 * belong to. Somebody opening the backup in Explorer should recognise it
 * as the same thing they have always had, because the whole point of a
 * backup nobody has tested is that it is the first thing you look at on
 * the worst day.
 *
 * Spelling is the app's, not the original folder's. The OneDrive tree
 * carries "Certifed", "Non- Destructive" and "Facilty"; reproducing typos
 * to match would be a strange thing to build deliberately, and the
 * section numbers are what anyone navigates by.
 *
 * ## Why this is a module and not string concatenation at the call site
 *
 * OneDrive rejects a name containing any of `" * : < > ? / \ |`, and one
 * of this application's own section titles — "Facility / Flow Line
 * Overview" — contains a slash. Built naively, section 2 of every
 * facility book would silently become two nested folders, or the upload
 * would fail with a message about an invalid path and nobody would look
 * for a whole missing section. That is worth a test rather than a
 * careful moment.
 */

/**
 * Characters OneDrive and SharePoint refuse outright.
 *
 * `/` and `\` are the dangerous ones here — they do not fail, they
 * silently change the shape of the tree.
 */
const ILLEGAL = /["*:<>?/\\|]/g

/** Windows device names, which cannot be a file or folder name at all. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * One path segment, made safe without becoming unrecognisable.
 *
 * Illegal characters become a hyphen rather than vanishing: "Facility /
 * Flow Line Overview" reads correctly as "Facility - Flow Line Overview",
 * where deleting the slash would give "Facility  Flow Line Overview" and
 * look like a typo somebody should fix.
 */
export function safeSegment(raw: string): string {
  let s = raw.replace(ILLEGAL, '-')

  // OneDrive refuses a leading "~$", and a name that is only dots.
  s = s.replace(/^~\$+/, '')

  // Collapse the runs a substitution can produce, then trim. A trailing
  // space or period makes a name Windows cannot create.
  s = s.replace(/\s+/g, ' ').replace(/-{2,}/g, '-').trim().replace(/[. ]+$/, '')

  if (RESERVED.test(s)) s = `${s}_`
  // Something must be left, or the file lands one level up and joins a
  // folder it does not belong to.
  return s.length > 0 ? s : 'Untitled'
}

/** A book's own folder: the code first, because that is what people say. */
export function bookFolder(book: { code: string; name: string }): string {
  const code = safeSegment(book.code)
  const name = safeSegment(book.name)
  return name && name !== code ? `${code} ${name}` : code
}

/**
 * A section folder, numbered the way the original tree numbered them.
 *
 * Plain "1." rather than "01." because that is what the books use and
 * Windows sorts numeric names correctly regardless.
 */
export function sectionFolder(
  section: { sectionNumber: string; title: string },
): string {
  return `${safeSegment(section.sectionNumber)}. ${safeSegment(section.title)}`
}

/** Documents that belong to no section still have to go somewhere a
 *  person will find them, rather than being skipped. */
export const UNFILED = '0. Unfiled'

/** Generated exports of the structured data — weld logs, torque logs,
 *  heats. Underscored so it sorts above the numbered sections. */
export const DATA_FOLDER = '_data'

/** Replaced documents. Never deleted: §15 retention outlives the
 *  correction that superseded them. */
export const SUPERSEDED_FOLDER = '_superseded'

/** The shared MTR library, which belongs to no single book. */
export const LIBRARY_FOLDER = '_library'

export type PlannedFile = {
  /** Folder segments below the backup root, outermost first. */
  folders: string[]
  filename: string
}

/** The full path, as OneDrive wants it. */
export function joinPath(plan: PlannedFile): string {
  return [...plan.folders, plan.filename].join('/')
}

/**
 * Where one of a book's documents belongs.
 *
 * `sectionNumber` null means the document is attached to a record rather
 * than a section — those still get filed rather than dropped.
 */
export function documentPath(
  book: { code: string; name: string },
  section: { sectionNumber: string; title: string } | null,
  filename: string,
): PlannedFile {
  return {
    folders: [bookFolder(book), section ? sectionFolder(section) : UNFILED],
    filename: safeSegment(filename),
  }
}

/**
 * Where a document goes once it has been replaced.
 *
 * Dated, so a document replaced twice does not overwrite its own earlier
 * version — which would make the retention folder quietly lossy, the one
 * thing it exists to prevent.
 */
export function supersededPath(
  book: { code: string; name: string },
  filename: string,
  supersededOn: string,
): PlannedFile {
  return {
    folders: [bookFolder(book), SUPERSEDED_FOLDER, safeSegment(supersededOn.slice(0, 10))],
    filename: safeSegment(filename),
  }
}

/** Where a generated data export goes. */
export function dataPath(
  book: { code: string; name: string }, filename: string,
): PlannedFile {
  return { folders: [bookFolder(book), DATA_FOLDER], filename: safeSegment(filename) }
}

/** Where a shared mill certificate goes: outside any one book, because
 *  the certificate for a heat is the same certificate wherever it was
 *  used. */
export function libraryPath(filename: string): PlannedFile {
  return {
    folders: [LIBRARY_FOLDER, 'Material Test Reports'],
    filename: safeSegment(filename),
  }
}

/**
 * SharePoint refuses a path beyond roughly 400 characters, and a
 * refusal is how a document goes missing without anybody noticing.
 *
 * Reported rather than truncated: a caller that silently shortened a
 * name would produce two documents fighting over one filename.
 */
export const MAX_PATH = 400

export function pathTooLong(plan: PlannedFile): boolean {
  return joinPath(plan).length > MAX_PATH
}
