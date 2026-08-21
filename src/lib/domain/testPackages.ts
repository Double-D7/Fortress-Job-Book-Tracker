/**
 * Pressure test and hydro test packages.
 *
 * Two modelling decisions carry all the weight here, and both are about
 * *referencing* rather than copying:
 *
 *   · One recorder certificate is physically duplicated into fourteen test
 *     folders, and one gauge certificate into eight. Imported as copies
 *     they become 22 unrelated documents, the section's bulk triples, and
 *     an expiry date has to be tracked in fourteen places. Imported as one
 *     certificate referenced many times, expiry is a single fact.
 *
 *   · The hydro test packages each carry an `MTRS` folder duplicating
 *     section 15. Owned as copies, MTR coverage is computed against an
 *     inflated denominator and reports better than the truth. Referenced,
 *     the heat register stays the single register it is.
 */
import type { IsoDate } from './types'

export type TestSpecClass = 'A' | 'B' | 'D'

export interface PressureTestPackage {
  id: string
  jobBookId: string
  /** As numbered on the folder, e.g. `1`, `27`. Text: the sequence has gaps. */
  testNumber: string
  specClass: TestSpecClass | null
  /** Hold data from `Testing Times and Pressures.xlsx`, where it exists. */
  testDate: IsoDate | null
  ambientTempF: number | null
  holdStart: string | null
  holdEnd: string | null
  holdDurationMin: number | null
  startPsi: number | null
  endPsi: number | null
  /**
   * A zero-filled block is a test that has not been run, never a test held
   * at 0 psi. The difference matters: one is outstanding work, the other
   * is a catastrophic failure.
   */
  notRun: boolean
  /** Certificates referenced by this package, never owned by it. */
  gaugeCertificateId: string | null
  recorderCertificateId: string | null
  psvCertificateId: string | null
  /** The result document, where the package has one. */
  resultDocumentId: string | null
  /** The package exists only as an unextracted archive. */
  zipOnly: boolean
}

export interface HydroTestPackage {
  id: string
  jobBookId: string
  testNumber: string
  /** Isometrics covered, from the package's ISO documents. */
  isometricNumbers: string[]
  weldLogDocumentId: string | null
  /**
   * Heat numbers the package's MTRS folder covers — as references into the
   * one heat register, not as copies of it.
   */
  referencedHeatNumbers: string[]
  /** Folder named `MTR` rather than `MTRS`, as Test 11's is. */
  mtrFolderNameVariant: string | null
  fileCount: number
}

/**
 * Did the hold pass?
 *
 * A pressure *gain* over the hold is thermal expansion, not a fault: seven
 * of DP-318's thirteen recorded holds gained, one of them 23 psi at 73 °F.
 * Flagging a gain as a failure would put a critical finding on more than
 * half the tests in the book for behaving exactly as physics requires.
 *
 * A loss is not automatically a failure either — the acceptance criterion
 * lives in the test procedure, and section 16 is empty on this job. So
 * this reports the direction and leaves the verdict to the result
 * document, rather than inventing a threshold.
 */
export type HoldOutcome = 'gain' | 'held' | 'loss' | 'unknown'

export function holdOutcome(p: Pick<PressureTestPackage, 'startPsi' | 'endPsi' | 'notRun'>): HoldOutcome {
  if (p.notRun || p.startPsi == null || p.endPsi == null) return 'unknown'
  if (p.endPsi > p.startPsi) return 'gain'
  if (p.endPsi === p.startPsi) return 'held'
  return 'loss'
}

export function holdDelta(p: Pick<PressureTestPackage, 'startPsi' | 'endPsi'>): number | null {
  if (p.startPsi == null || p.endPsi == null) return null
  return p.endPsi - p.startPsi
}

/**
 * A test is evidenced when a result document exists. Certificates alone
 * prove the instruments were calibrated, not that the test happened or
 * that it passed.
 */
export function hasResult(p: PressureTestPackage): boolean {
  return !!p.resultDocumentId
}

export interface PressureTestCoverage {
  /** Tests the weld log references. */
  referenced: string[]
  /** Packages found in the folder tree. */
  onDisk: string[]
  withResult: string[]
  certsOnlyNoResult: string[]
  zipOnly: string[]
  /** Referenced by welds but absent from the tree, and vice versa. */
  referencedNotOnDisk: string[]
  onDiskNotReferenced: string[]
  coveragePct: number
}

export function pressureTestCoverage(
  referencedByWelds: string[],
  packages: PressureTestPackage[],
): PressureTestCoverage {
  const norm = (s: string) => s.trim()
  const referenced = [...new Set(referencedByWelds.map(norm).filter(Boolean))]
  const onDisk = packages.map((p) => p.testNumber)
  const onDiskSet = new Set(onDisk)
  const referencedSet = new Set(referenced)
  const withResult = packages.filter(hasResult).map((p) => p.testNumber)
  return {
    referenced,
    onDisk,
    withResult,
    certsOnlyNoResult: packages
      .filter((p) => !hasResult(p) && !p.zipOnly &&
        (p.gaugeCertificateId || p.recorderCertificateId || p.psvCertificateId))
      .map((p) => p.testNumber),
    zipOnly: packages.filter((p) => p.zipOnly).map((p) => p.testNumber),
    referencedNotOnDisk: referenced.filter((t) => !onDiskSet.has(t)),
    onDiskNotReferenced: onDisk.filter((t) => !referencedSet.has(t)),
    // Scored against what the welds reference: a package nobody's pipe
    // points at does not evidence any of the work in this book.
    coveragePct: referenced.length
      ? (referenced.filter((t) => withResult.includes(t)).length / referenced.length) * 100
      : 0,
  }
}

/** Gaps in the numbering, distinct from tests that are merely missing. */
export function sequenceGaps(testNumbers: string[]): number[] {
  const nums = testNumbers.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (nums.length < 2) return []
  const present = new Set(nums)
  const out: number[] = []
  for (let n = nums[0]!; n < nums[nums.length - 1]!; n++) if (!present.has(n)) out.push(n)
  return out
}
