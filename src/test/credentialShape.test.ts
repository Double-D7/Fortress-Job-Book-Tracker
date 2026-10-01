/**
 * Telling somebody which wrong value they pasted, without pasting it back.
 *
 * Every case here is a mistake that actually happened while connecting
 * this to Microsoft, and each one cost a round trip through the portal
 * because Entra answers all of them with the same sentence: "Invalid
 * client secret provided."
 *
 * The constraint that matters as much as the diagnosis: no branch may
 * return any part of the value. A message that identified the problem by
 * quoting the secret would be worse than the vague one it replaces —
 * that is precisely how a live credential ended up in `backup_run.error`
 * in the first place.
 */
import { describe, expect, it } from 'vitest'
import { describeCredentialShape } from '../../supabase/functions/_shared/credentialShape'

const CLIENT_ID = '2b8e455f-a4d3-4097-a9a8-d12083879e40'
const SECRET_ID = '7f1c0a93-55d2-4e8b-9a01-3cbb21d6e447'
const GOOD_SECRET = 'Kpr7Q~aa11bb22cc33dd44ee55ff66gg77hh88ii9'

describe('what is actually in the box', () => {
  it('names a Secret ID for what it is', () => {
    const said = describeCredentialShape(SECRET_ID, { clientId: CLIENT_ID })
    expect(said).toContain('Secret ID')
    expect(said).toContain('Value')
  })

  it('says the Value cannot be recovered and a new secret is needed', () => {
    // Without this, the natural next move is to go hunting for the old
    // Value on a page that will never show it again.
    expect(describeCredentialShape(SECRET_ID)).toContain('create a new')
  })

  it('spots the two boxes holding the same string', () => {
    expect(describeCredentialShape(CLIENT_ID, { clientId: CLIENT_ID }))
      .toContain('identical to GRAPH_CLIENT_ID')
  })

  it('spots a trailing newline from a paste', () => {
    expect(describeCredentialShape(`${GOOD_SECRET}\n`)).toContain('whitespace')
  })

  it('spots an empty value', () => {
    expect(describeCredentialShape('')).toContain('empty')
    expect(describeCredentialShape(undefined)).toContain('empty')
  })

  it('spots something far too short to be a secret', () => {
    expect(describeCredentialShape('hunter2')).toContain('shorter than')
  })
})

describe('when the shape is right', () => {
  it('adds nothing, so the real error is not buried', () => {
    // An expired secret has the right shape. Commenting on every failure
    // teaches people to stop reading the comment.
    expect(describeCredentialShape(GOOD_SECRET, { clientId: CLIENT_ID })).toBeNull()
  })

  it('does not mistake a secret containing hex for a GUID', () => {
    expect(describeCredentialShape('abc123def456abc123def456abc12345')).toBeNull()
  })
})

describe('what it must never do', () => {
  it('never quotes any part of the value back', () => {
    const cases = ['', 'hunter2', SECRET_ID, CLIENT_ID, `${GOOD_SECRET}\n`, GOOD_SECRET]
    for (const value of cases) {
      const said = describeCredentialShape(value, { clientId: CLIENT_ID })
      if (said === null) continue
      // Every run of 6+ characters from the value, checked against the
      // message. A diagnostic that leaks is not a diagnostic.
      for (let i = 0; i + 6 <= value.trim().length; i += 1) {
        expect(said).not.toContain(value.trim().slice(i, i + 6))
      }
    }
  })

  it('does not report the length of a plausible secret', () => {
    // Length alone narrows a brute force. It is only worth saying when it
    // is the finding itself, as with a value far too short to be a secret.
    expect(describeCredentialShape(GOOD_SECRET)).toBeNull()
  })
})
