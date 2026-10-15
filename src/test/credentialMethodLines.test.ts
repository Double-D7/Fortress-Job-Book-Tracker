/**
 * One certificate, several credentials.
 *
 * Written from the certifications uploaded on 2026-10-15 rather than
 * from reasoning about what one might look like. The shapes here are
 * transcribed from real pages, because the assumption they broke — that
 * a person's NDT certification has one issue date and one expiry — had
 * survived review and a thousand passing tests, and only fell over when
 * somebody put the actual paper in front of it.
 */
import { describe, expect, it } from 'vitest'
import {
  credentialFilename, expandCredentialLines, printsNoIssueDate,
  validateCredential, validateCredentialLines,
  type CredentialInput, type CredentialMethodLine,
} from '@/lib/domain/credentials'
import { credentialsFromForm, methodLinesFrom } from '@/lib/http/credentialForm'
import { getDataProvider, type Viewer } from '@/lib/data/provider'
import { certValidOn, ndtMethodCoverage } from '@/lib/domain/certificates'

const tech: CredentialInput = {
  subjectType: 'ndt_technician',
  subjectId: null,
  fullName: 'E. Mercado',
  certType: 'ASNT Level II',
  issuingBody: 'PROtect LLC',
  issueDate: null,
  ndtMethods: [],
}

/** Edgar Mercado's certification, as PROtect printed it. Two expiry
 *  dates across four methods, one day apart. */
const MERCADO: CredentialMethodLine[] = [
  { methods: ['PT'], issueDate: '2025-10-14', expiryDate: '2028-10-08' },
  { methods: ['UT'], issueDate: '2025-10-14', expiryDate: '2028-10-08', limitation: 'Thickness Only' },
  { methods: ['MT'], issueDate: '2025-10-14', expiryDate: '2028-10-09' },
  { methods: ['RT'], issueDate: '2025-10-14', expiryDate: '2028-10-09' },
]

describe('a certification is a method table, not a row', () => {
  it('becomes one credential per line', () => {
    const out = expandCredentialLines(tech, MERCADO)
    expect(out).toHaveLength(4)
    expect(out.map((c) => c.ndtMethods)).toEqual([['PT'], ['UT'], ['MT'], ['RT']])
  })

  it('keeps each line on its own dates', () => {
    // The whole point. Collapsing these to one pair of dates would
    // either expire MT and RT a day early or certify PT and UT a day
    // late, and the second one passes work that was not covered.
    const out = expandCredentialLines(tech, MERCADO)
    expect(out.map((c) => c.expiryDate))
      .toEqual(['2028-10-08', '2028-10-08', '2028-10-09', '2028-10-09'])
  })

  it('carries the limitation into the certificate type', () => {
    // American Piping issues two RT Level II lines — conventional film
    // and computed radiography — on different dates with different
    // scores. A register that called both "ASNT Level II" could not say
    // which one covered a report.
    const out = expandCredentialLines(tech, MERCADO)
    expect(out[1]!.certType).toBe('ASNT Level II (Thickness Only)')
    expect(out[0]!.certType).toBe('ASNT Level II')
  })

  it('leaves a CWI card and a welder WPQ as one credential each', () => {
    const cwi: CredentialInput = { ...tech, subjectType: 'cwi', ndtMethods: null, issueDate: '2024-05-01' }
    expect(expandCredentialLines(cwi, MERCADO)).toHaveLength(1)
  })

  it('names each stored file for its method', () => {
    const out = expandCredentialLines(tech, MERCADO)
    const names = out.map((c) => credentialFilename(
      { certType: c.certType, issueDate: c.issueDate, ndtMethods: c.ndtMethods }, 'scan.pdf'))
    // Four files in one folder have to be told apart by somebody who
    // never opens this application.
    expect(new Set(names).size).toBe(4)
    expect(names[0]).toBe('ASNT_Level_II_PT_2025-10-14.pdf')
  })
})

describe('what a method table must say', () => {
  it('accepts Mercado as printed', () => {
    expect(validateCredentialLines(tech, MERCADO)).toEqual([])
  })

  it('refuses a line with no method ticked, and says which line', () => {
    const problems = validateCredentialLines(tech, [
      MERCADO[0]!, { methods: [], issueDate: '2025-10-14' },
    ])
    expect(problems.some((p) => p.field === 'ndtMethods' && p.line === 1)).toBe(true)
  })

  it('refuses a line with no certification date', () => {
    // A technician's card always prints one. Missing means unread.
    const problems = validateCredentialLines(tech, [
      { methods: ['RT'], issueDate: null, expiryDate: '2028-10-09' },
    ])
    expect(problems.some((p) => p.field === 'issueDate')).toBe(true)
  })

  it('refuses the same method and date typed twice', () => {
    // They would collide in the library and silently become one row,
    // which is the bug migration 0047 exists to prevent.
    const problems = validateCredentialLines(tech, [MERCADO[0]!, MERCADO[0]!])
    expect(problems.some((p) => p.line === 1 && /same method and date/.test(p.message)))
      .toBe(true)
  })

  it('allows the same method on a later date, which is a renewal', () => {
    expect(validateCredentialLines(tech, [
      { methods: ['RT'], issueDate: '2022-03-01', expiryDate: '2025-03-01' },
      { methods: ['RT'], issueDate: '2025-02-01', expiryDate: '2028-02-01' },
    ])).toEqual([])
  })
})

describe('a card that prints no issue date', () => {
  const cwi = (over: Partial<CredentialInput> = {}): CredentialInput => ({
    subjectType: 'cwi', subjectId: null, fullName: 'Joshua G. Cole',
    certType: 'AWS CWI', issuingBody: 'American Welding Society',
    issueDate: null, expiryDate: '2028-03-01', ...over,
  })

  it('is a CWI card and nothing else', () => {
    expect(printsNoIssueDate('cwi')).toBe(true)
    expect(printsNoIssueDate('ndt_technician')).toBe(false)
    expect(printsNoIssueDate('welder')).toBe(false)
  })

  it('accepts the four AWS certificates on file', () => {
    // Emig, Kidd, Cole and Hayman all carry a certificate number and an
    // expiry and no issue date. AWS does not print one, so a form that
    // demanded it was refusing what the paper says.
    for (const expiry of ['2027-05-01', '2027-12-01', '2028-03-01', '2027-05-01']) {
      expect(validateCredential(cwi({ expiryDate: expiry }))).toEqual([])
    }
  })

  it('still refuses a card with no date at all', () => {
    const problems = validateCredential(cwi({ expiryDate: null }))
    expect(problems.some((p) => /nothing to check a work date against/.test(p.message)))
      .toBe(true)
  })

  it('certifies no work date, rather than every work date', () => {
    // The dangerous reading. An unknown start is not "valid since the
    // beginning of time"; it is unknown, and the register says so by
    // refusing to match.
    const undated = [{
      id: 'c1', subjectType: 'cwi' as const, subjectId: 'cwi-1',
      certType: 'AWS CWI', issueDate: null, expiryDate: '2028-03-01',
    }]
    expect(certValidOn(undated, 'cwi', 'cwi-1', '2026-01-01')).toBeNull()
  })

  it('names the stored file for the expiry it does print', () => {
    expect(credentialFilename(
      { certType: 'AWS CWI', issueDate: null, expiryDate: '2028-03-01' }, 'cole.pdf'))
      .toBe('AWS_CWI_exp_2028-03-01.pdf')
  })
})

describe('reading a method table off the form', () => {
  function form(entries: Record<string, string>): FormData {
    const f = new FormData()
    for (const [k, v] of Object.entries(entries)) f.set(k, v)
    return f
  }
  const base = {
    subjectType: 'ndt_technician', fullName: 'E. Mercado',
    certType: 'ASNT Level II', issuingBody: 'PROtect LLC',
  }

  it('reads the lines and expands them', () => {
    const out = credentialsFromForm(form({
      ...base, methodLines: JSON.stringify(MERCADO),
    }))
    expect(out).toHaveLength(4)
    expect(out[3]!.expiryDate).toBe('2028-10-09')
  })

  it('drops a method it does not model without dropping the line', () => {
    const lines = methodLinesFrom(form({
      methodLines: JSON.stringify([{ methods: ['RT', 'VT'], issueDate: '2025-01-01' }]),
    }))
    expect(lines[0]!.methods).toEqual(['RT'])
  })

  it('survives a malformed payload without filing half a card', () => {
    // Falls back to the single-line shape, which validation then
    // refuses for having no methods — rather than quietly filing a
    // technician with nothing recorded.
    const out = credentialsFromForm(form({ ...base, methodLines: '{not json' }))
    expect(out).toHaveLength(1)
    expect(validateCredential(out[0]!).some((p) => p.field === 'ndtMethods')).toBe(true)
  })
})

describe('filing a real certification, end to end', () => {
  const admin: Viewer = {
    id: 'seed-user-admin', email: 'admin@fortressds.com',
    fullName: 'A. Reyes', role: 'fortress_admin', clientOrgId: null,
  }
  const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4 ${tag}`)

  async function anyBook(): Promise<string> {
    return (await getDataProvider().listJobBooks(admin))[0]!.id
  }

  it('files four methods as four cards, not one', async () => {
    // The bug this whole pass exists for: keyed only on person, type
    // and issue date, Mercado's four lines are one row written four
    // times, and three methods vanish.
    const p = getDataProvider()
    const id = await anyBook()
    const inputs = expandCredentialLines(
      { ...tech, fullName: 'Edgar Mercado Test' }, MERCADO)

    for (const input of inputs) {
      const res = await p.fileCredential(admin, id, input, pdf('mercado'), 'mercado.pdf')
      expect(res.ok).toBe(true)
    }

    const cards = (await p.listPersonnelLibrary(admin))
      .filter((c) => c.personName === 'Edgar Mercado Test')
    expect(cards).toHaveLength(4)
    expect(new Set(cards.map((c) => c.expiryDate)))
      .toEqual(new Set(['2028-10-08', '2028-10-09']))
  })

  it('covers each method to its own expiry and no further', () => {
    // Resolution is tested on the register rows directly rather than
    // through a book: a card is only pulled onto a book the person has
    // signed something on, and a technician invented for a test has
    // signed nothing. What matters here is that two methods off one
    // certificate expire on different days and the register can say so.
    const certs = expandCredentialLines(tech, MERCADO).map((c, i) => ({
      id: `cert-${i}`,
      subjectType: 'ndt_technician' as const,
      subjectId: 'tech-1',
      certType: c.certType,
      issueDate: c.issueDate,
      expiryDate: c.expiryDate,
      ndtMethods: c.ndtMethods,
    }))

    // The day MT and RT still cover and PT and UT no longer do. Before
    // this change that day could not be represented at all: one expiry
    // served all four methods.
    const gapDay = '2028-10-09'
    expect(ndtMethodCoverage(certs, 'tech-1', gapDay, 'MT').state).toBe('covered')
    expect(ndtMethodCoverage(certs, 'tech-1', gapDay, 'RT').state).toBe('covered')
    expect(ndtMethodCoverage(certs, 'tech-1', gapDay, 'PT').state).toBe('method_not_covered')
    expect(ndtMethodCoverage(certs, 'tech-1', gapDay, 'UT').state).toBe('method_not_covered')

    // And on a day inside every line, all four cover.
    for (const m of ['PT', 'UT', 'MT', 'RT'] as const) {
      expect(ndtMethodCoverage(certs, 'tech-1', '2026-06-01', m).state).toBe('covered')
    }
  })
})
