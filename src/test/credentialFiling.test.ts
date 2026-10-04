/**
 * Filing a credential into sections 7 and 8.
 *
 * These were the only two sections with no way to get a record in. The
 * certificates existed on paper, the application could not see them,
 * and both sections scored on a register nothing wrote. Everything
 * here is about the gap between "we have the card" and "the book can
 * show we have the card".
 */
import { describe, expect, it } from 'vitest'
import {
  credentialSection, credentialToCertificate, defaultCertType, validateCredential,
  type CredentialInput,
} from '@/lib/domain/credentials'
import { SOURCE_SECTION } from '@/lib/domain/sourceFiling'
import { getDataProvider, type Viewer } from '@/lib/data/provider'
import { certValidOn, ndtMethodCoverage } from '@/lib/domain/certificates'

function input(over: Partial<CredentialInput> = {}): CredentialInput {
  return {
    subjectType: 'ndt_technician',
    subjectId: null,
    fullName: 'Dale Whitcomb',
    certType: 'ASNT Level II',
    issueDate: '2025-01-15',
    expiryDate: '2028-01-15',
    ndtMethods: ['RT'],
    ...over,
  }
}

function fieldsOf(problems: { field: string }[]): string[] {
  return problems.map((p) => p.field)
}

describe('what a credential must say before it can be filed', () => {
  it('accepts a complete NDT card', () => {
    expect(validateCredential(input())).toEqual([])
  })

  it('accepts a CWI card with no methods', () => {
    expect(validateCredential(input({
      subjectType: 'cwi', certType: 'AWS CWI', ndtMethods: [],
    }))).toEqual([])
  })

  it('refuses an NDT card with no methods ticked', () => {
    // The whole reason this column exists. A card certifying nothing is
    // not a card somebody meant to file.
    expect(fieldsOf(validateCredential(input({ ndtMethods: [] })))).toContain('ndtMethods')
    expect(fieldsOf(validateCredential(input({ ndtMethods: null })))).toContain('ndtMethods')
  })

  it('refuses methods on a CWI card', () => {
    expect(fieldsOf(validateCredential(input({
      subjectType: 'cwi', ndtMethods: ['RT'],
    })))).toContain('ndtMethods')
  })

  it('refuses a method it does not model', () => {
    expect(fieldsOf(validateCredential(input({
      ndtMethods: ['VT' as 'RT'],
    })))).toContain('ndtMethods')
  })

  it('requires an issue date, because an unread card certifies nothing', () => {
    expect(fieldsOf(validateCredential(input({ issueDate: '' })))).toContain('issueDate')
    expect(fieldsOf(validateCredential(input({ issueDate: '15/01/2025' })))).toContain('issueDate')
  })

  it('allows a blank expiry, because some cards print none', () => {
    expect(validateCredential(input({ expiryDate: null }))).toEqual([])
    expect(validateCredential(input({ expiryDate: '' }))).toEqual([])
  })

  it('refuses an expiry before the issue date', () => {
    expect(fieldsOf(validateCredential(input({
      issueDate: '2025-01-15', expiryDate: '2024-01-15',
    })))).toContain('expiryDate')
  })

  it('requires a name only when adding somebody new', () => {
    expect(fieldsOf(validateCredential(input({ fullName: '' })))).toContain('fullName')
    expect(validateCredential(input({ subjectId: 't1', fullName: '' }))).toEqual([])
  })

  it('reports every problem at once, not the first', () => {
    const problems = validateCredential(input({
      fullName: '', certType: '', issueDate: '', ndtMethods: [],
    }))
    expect(new Set(fieldsOf(problems)))
      .toEqual(new Set(['fullName', 'certType', 'issueDate', 'ndtMethods']))
  })
})

describe('what gets stored', () => {
  it('drops methods for a CWI rather than carrying them', () => {
    const row = credentialToCertificate(
      input({ subjectType: 'cwi', certType: 'AWS CWI', ndtMethods: [] }), 'c1')
    expect(row.ndtMethods).toBeNull()
  })

  it('stores an empty method list as null, not as an empty array', () => {
    // The database would then hold two different values both meaning
    // "not recorded", and only one of them reads that way.
    const row = credentialToCertificate(
      input({ subjectType: 'cwi', ndtMethods: [] }), 'c1')
    expect(row.ndtMethods).toBeNull()
  })

  it('de-duplicates and sorts the methods', () => {
    const row = credentialToCertificate(input({ ndtMethods: ['UT', 'RT', 'RT'] }), 't1')
    expect(row.ndtMethods).toEqual(['RT', 'UT'])
  })

  it('trims text and turns blanks into null', () => {
    const row = credentialToCertificate(
      input({ certType: '  ASNT Level II  ', issuingBody: '   ' }), 't1')
    expect(row.certType).toBe('ASNT Level II')
    expect(row.issuingBody).toBeNull()
  })
})

describe('where a credential files', () => {
  it('puts a CWI card in 7 and an NDT card in 8', () => {
    expect(credentialSection('cwi')).toBe('7')
    expect(credentialSection('ndt_technician')).toBe('8')
  })

  it('agrees with the source filing table, which is what actually files it', () => {
    // Two places decide this and they must not drift.
    expect(SOURCE_SECTION.cwi_certificate).toBe(credentialSection('cwi'))
    expect(SOURCE_SECTION.ndt_certificate).toBe(credentialSection('ndt_technician'))
  })

  it('offers the certificate type each card actually prints', () => {
    expect(defaultCertType('cwi')).toBe('AWS CWI')
    expect(defaultCertType('ndt_technician')).toBe('ASNT Level II')
  })
})

/**
 * The seed provider is a module-level singleton holding its state
 * across tests, so every person filed below carries a name of their
 * own. Sharing one would make each test depend on which ran first.
 */
describe('filing one, end to end', () => {
  const admin: Viewer = {
    id: 'seed-user-admin', email: 'admin@fortressds.com',
    fullName: 'A. Reyes', role: 'fortress_admin', clientOrgId: null,
  }
  const inspector: Viewer = {
    id: 'seed-user-inspector', email: 'p.nakamura@inspection.example',
    fullName: 'P. Nakamura', role: 'third_party_inspector', clientOrgId: null,
  }

  // Enough bytes to be a distinct file. Content-addressed filing means
  // two credentials sharing bytes share one document, so each test that
  // counts documents sends its own.
  const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4 ${tag}`)

  async function firstBook(): Promise<string> {
    const books = await getDataProvider().listJobBooks(admin)
    return books[0]!.id
  }

  it('adds the person and files the card in one action', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    const before = (await p.getBundle(admin, id))!.ndtTechnicians.length

    const res = await p.fileCredential(admin, id, input({
      fullName: 'Dale Whitcomb', ndtMethods: ['RT', 'UT'],
    }), pdf('whitcomb'), 'whitcomb-asnt.pdf')
    expect(res.ok).toBe(true)

    const after = (await p.getBundle(admin, id))!
    expect(after.ndtTechnicians.length).toBe(before + 1)
    const dale = after.ndtTechnicians.find((t) => t.fullName === 'Dale Whitcomb')
    expect(dale).toBeDefined()
    expect(certValidOn(after.certificates, 'ndt_technician', dale!.id, '2026-01-01',
      { method: 'RT' })).not.toBeNull()
  })

  it('files the card itself, not just the dates', async () => {
    // A credential with no page is a claim. The document is the
    // evidence, and section 8 is where an auditor looks for it.
    const p = getDataProvider()
    const id = await firstBook()
    const before = (await p.getBundle(admin, id))!.documents.length
    await p.fileCredential(admin, id, input({ fullName: 'Ingrid Sandoval' }),
      pdf('sandoval'), 'sandoval-asnt.pdf')
    expect((await p.getBundle(admin, id))!.documents.length).toBe(before + 1)
  })

  it('makes the method it recorded the method that counts', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    await p.fileCredential(admin, id, input({
      fullName: 'Pat Mercer', ndtMethods: ['PT'],
    }), pdf('mercer'), 'mercer-asnt.pdf')
    const b = (await p.getBundle(admin, id))!
    const pat = b.ndtTechnicians.find((t) => t.fullName === 'Pat Mercer')!
    expect(ndtMethodCoverage(b.certificates, pat.id, '2026-01-01', 'PT').state).toBe('covered')
    expect(ndtMethodCoverage(b.certificates, pat.id, '2026-01-01', 'RT').state)
      .toBe('method_not_covered')
  })

  it('files a CWI card into the roster it belongs to', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    const before = (await p.getBundle(admin, id))!
    await p.fileCredential(admin, id, input({
      subjectType: 'cwi', fullName: 'Harriet Boone', certType: 'AWS CWI', ndtMethods: [],
    }), pdf('boone'), 'boone-cwi.pdf')
    const after = (await p.getBundle(admin, id))!
    expect(after.cwis.length).toBe(before.cwis.length + 1)
    expect(after.ndtTechnicians.length).toBe(before.ndtTechnicians.length)
  })

  it('replaces rather than stacks when the same card is filed twice', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    const card = input({ fullName: 'Desmond Clary' })
    await p.fileCredential(admin, id, card, pdf('clary'), 'clary.pdf')
    const once = (await p.getBundle(admin, id))!.certificates.length
    await p.fileCredential(admin, id, card, pdf('clary'), 'clary.pdf')
    expect((await p.getBundle(admin, id))!.certificates.length).toBe(once)
  })

  it('files a renewal alongside the old card rather than over it', async () => {
    // The history is the record. An expired card is what shows a report
    // written last year was covered at the time.
    const p = getDataProvider()
    const id = await firstBook()
    await p.fileCredential(admin, id, input({
      fullName: 'Lorna Pike', issueDate: '2022-01-10', expiryDate: '2025-01-10',
    }), pdf('pike-old'), 'pike-2022.pdf')
    const once = (await p.getBundle(admin, id))!.certificates.length
    await p.fileCredential(admin, id, input({
      fullName: 'Lorna Pike', issueDate: '2025-01-11', expiryDate: '2028-01-11',
    }), pdf('pike-new'), 'pike-2025.pdf')
    expect((await p.getBundle(admin, id))!.certificates.length).toBe(once + 1)
  })

  it('refuses a third party inspector', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    const res = await p.fileCredential(inspector, id, input({ fullName: 'Nobody At All' }),
      pdf('nope'), 'x.pdf')
    expect(res.ok).toBe(false)
  })

  it('refuses an invalid credential without writing anything', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    const before = (await p.getBundle(admin, id))!
    const res = await p.fileCredential(admin, id, input({
      fullName: 'Unwritten Person', ndtMethods: [],
    }), pdf('invalid'), 'x.pdf')
    expect(res.ok).toBe(false)
    const after = (await p.getBundle(admin, id))!
    expect(after.certificates.length).toBe(before.certificates.length)
    expect(after.documents.length).toBe(before.documents.length)
    expect(after.ndtTechnicians.length).toBe(before.ndtTechnicians.length)
  })
})
