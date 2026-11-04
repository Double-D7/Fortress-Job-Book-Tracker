/**
 * The bucket name, and nothing else.
 *
 * Its own module with no imports because both the server and the
 * browser need it: `storage.ts` reaches for `./server`, which reads
 * request headers, and importing that from a client component would
 * pull server-only code into the browser bundle.
 */
export const DOCUMENT_BUCKET = 'job-book-documents'
