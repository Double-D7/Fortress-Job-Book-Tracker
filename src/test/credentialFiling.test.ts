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

  /** A seed book that actually has somebody signing NDE reports on it,
   *  found rather than assumed: the first book in the list has none,
   *  and a test that hard-codes an index breaks on the next seed. */
  async function bookWithASignedReport(): Promise<{ id: string; techId: string }> {
    const p = getDataProvider()
    for (const summary of await p.listJobBooks(admin)) {
      const b = await p.getBundle(admin, summary.id)
      const signed = b?.ndeReports.find((r) => r.technicianId)
      if (signed) return { id: summary.id, techId: signed.technicianId! }
    }
    throw new Error('no seed book has a signed NDE report')
  }

  it('adds the person and files the card to the library in one action', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    const before = (await p.getBundle(admin, id))!.ndtTechnicians.length

    const res = await p.fileCredential(admin, id, input({
      fullName: 'Dale Whitcomb', ndtMethods: ['RT', 'UT'],
    }), pdf('whitcomb'), 'whitcomb-asnt.pdf')
    expect(res.ok).toBe(true)

    const after = (await p.getBundle(admin, id))!
    expect(after.ndtTechnicians.length).toBe(before + 1)

    const card = (await p.listPersonnelLibrary(admin))
      .find((c) => c.personName === 'Dale Whitcomb')
    expect(card).toBeDefined()
    expect(card!.ndtMethods).toEqual(['RT', 'UT'])
  })

  it('does not put the card on a book the person has not worked', async () => {
    // The whole point of scoping it. A turnover package lists the people
    // who worked that job, not everybody Fortress has ever certified.
    const p = getDataProvider()
    const id = await firstBook()
    await p.fileCredential(admin, id, input({ fullName: 'Never Worked Here' }),
      pdf('never'), 'never.pdf')
    const b = (await p.getBundle(admin, id))!
    const person = b.ndtTechnicians.find((t) => t.fullName === 'Never Worked Here')!
    expect(b.certificates.some((c) => c.subjectId === person.id)).toBe(false)
  })

  it('pulls the card onto every book the person has signed a report on', async () => {
    // The half that makes the library worth having: file once, and the
    // books they already worked resolve by themselves.
    const p = getDataProvider()
    const { id, techId } = await bookWithASignedReport()

    const res = await p.fileCredential(admin, id, input({
      subjectId: techId, fullName: null,
      certType: 'ASNT Level II (library pull test)', ndtMethods: ['RT', 'PT', 'MT', 'UT'],
      issueDate: '2020-01-01', expiryDate: '2030-01-01',
    }), pdf('pull'), 'pull.pdf')
    expect(res.ok).toBe(true)

    const after = (await p.getBundle(admin, id))!
    const pulled = after.certificates.filter(
      (c) => c.subjectId === techId && c.credentialLibraryId && !c.deletedAt)
    expect(pulled.length).toBe(1)
    expect(certValidOn(after.certificates, 'ndt_technician', techId, '2025-06-01',
      { method: 'UT' })).not.toBeNull()
  })

  it('withdrawing a card stops every book claiming it is on file', async () => {
    const p = getDataProvider()
    const { id, techId } = await bookWithASignedReport()

    await p.fileCredential(admin, id, input({
      subjectId: techId, fullName: null,
      certType: 'ASNT Level II (withdrawal test)', ndtMethods: ['RT'],
      issueDate: '2021-02-02', expiryDate: '2031-02-02',
    }), pdf('withdraw'), 'withdraw.pdf')

    const card = (await p.listPersonnelLibrary(admin))
      .find((c) => c.certType === 'ASNT Level II (withdrawal test)')!
    expect(card.referencedByBooks).toBeGreaterThan(0)

    const res = await p.withdrawPersonnelCredential(admin, card.id, 'Superseded')
    expect(res.ok).toBe(true)

    const after = (await p.getBundle(admin, id))!
    expect(after.certificates.some(
      (c) => c.credentialLibraryId === card.id && !c.deletedAt)).toBe(false)
    expect((await p.listPersonnelLibrary(admin)).some((c) => c.id === card.id)).toBe(false)
  })

  it('refuses to withdraw without a reason', async () => {
    const p = getDataProvider()
    const id = await firstBook()
    await p.fileCredential(admin, id, input({
      fullName: 'Reasonless Withdrawal', certType: 'ASNT Level II (reason test)',
    }), pdf('reason'), 'reason.pdf')
    const card = (await p.listPersonnelLibrary(admin))
      .find((c) => c.certType === 'ASNT Level II (reason test)')!
    expect((await p.withdrawPersonnelCredential(admin, card.id, '   ')).ok).toBe(false)
  })

  it('files the card itself, not just the dates', async () => {
    // A credential with no page is a claim. The page is the evidence,
    // and it hangs off the library card rather than off any one book's
    // section, because the card is the same card on every job.
    const p = getDataProvider()
    const bytes = pdf('sandoval')
    await p.fileCredential(admin, null, input({ fullName: 'Ingrid Sandoval' }),
      bytes, 'sandoval-asnt.pdf')
    const card = (await p.listPersonnelLibrary(admin))
      .find((c) => c.personName === 'Ingrid Sandoval')!
    expect(card.storagePath).toContain('personnel-library/')
    expect(card.sha256).toHaveLength(64)
    expect(card.byteSize).toBe(bytes.byteLength)
    expect(card.originalFilename).toBe('sandoval-asnt.pdf')
    // Renamed for the SharePoint copy, which has to be legible to
    // somebody who never opens this application.
    expect(card.normalizedFilename).toMatch(/^ASNT_Level_II_2025-01-15\.pdf$/)
  })

  it('files from the library with no job book at all', async () => {
    // The case that made this reachable. A credential exists before
    // anybody knows which job wants it, and a project with no books yet
    // could not file one.
    const p = getDataProvider()
    const res = await p.fileCredential(admin, null, input({
      fullName: 'Booklessly Filed', ndtMethods: ['MT'],
    }), pdf('bookless'), 'bookless.pdf')
    expect(res.ok).toBe(true)
    const card = (await p.listPersonnelLibrary(admin))
      .find((c) => c.personName === 'Booklessly Filed')
    expect(card).toBeDefined()
    expect(card!.ndtMethods).toEqual(['MT'])
    expect(card!.referencedByBooks).toBe(0)
  })

  it('puts a person added from the library on the roster the form reads', async () => {
    // The filing form reads the rosters, not a book. Somebody added
    // while filing has to appear there or the next card for them would
    // create a duplicate person.
    const p = getDataProvider()
    await p.fileCredential(admin, null, input({ fullName: 'Rosalind Teague' }),
      pdf('teague'), 'teague.pdf')
    const { technicians } = await p.listCredentialRosters(admin)
    expect(technicians.some((t) => t.label === 'Rosalind Teague')).toBe(true)
  })

  it('carries the recorded methods through to the book it is pulled onto', async () => {
    const p = getDataProvider()
    const { id, techId } = await bookWithASignedReport()

    await p.fileCredential(admin, id, input({
      subjectId: techId, fullName: null,
      certType: 'ASNT Level II (method test)', ndtMethods: ['PT'],
      issueDate: '2019-03-03', expiryDate: '2029-03-03',
    }), pdf('mercer'), 'mercer-asnt.pdf')

    const b = (await p.getBundle(admin, id))!
    const pulled = b.certificates.filter(
      (c) => c.certType === 'ASNT Level II (method test)')
    expect(pulled).toHaveLength(1)
    expect(pulled[0]!.ndtMethods).toEqual(['PT'])
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
    const once = (await p.listPersonnelLibrary(admin, 'Desmond Clary')).length
    await p.fileCredential(admin, id, card, pdf('clary'), 'clary.pdf')
    expect((await p.listPersonnelLibrary(admin, 'Desmond Clary')).length).toBe(once)
  })

  it('files a renewal alongside the old card rather than over it', async () => {
    // The history is the record. An expired card is what shows a report
    // written last year was covered at the time.
    const p = getDataProvider()
    const id = await firstBook()
    await p.fileCredential(admin, id, input({
      fullName: 'Lorna Pike', issueDate: '2022-01-10', expiryDate: '2025-01-10',
    }), pdf('pike-old'), 'pike-2022.pdf')
    const once = (await p.listPersonnelLibrary(admin, 'Lorna Pike')).length
    await p.fileCredential(admin, id, input({
      fullName: 'Lorna Pike', issueDate: '2025-01-11', expiryDate: '2028-01-11',
    }), pdf('pike-new'), 'pike-2025.pdf')
    expect((await p.listPersonnelLibrary(admin, 'Lorna Pike')).length).toBe(once + 1)
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
    const beforeCards = (await p.listPersonnelLibrary(admin)).length
    const res = await p.fileCredential(admin, id, input({
      fullName: 'Unwritten Person', ndtMethods: [],
    }), pdf('invalid'), 'x.pdf')
    expect(res.ok).toBe(false)
    const after = (await p.getBundle(admin, id))!
    expect(after.certificates.length).toBe(before.certificates.length)
    expect(after.documents.length).toBe(before.documents.length)
    expect(after.ndtTechnicians.length).toBe(before.ndtTechnicians.length)
    expect((await p.listPersonnelLibrary(admin)).length).toBe(beforeCards)
  })
})
