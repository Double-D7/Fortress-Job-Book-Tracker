/**
 * Telling the two halves of Sites.Selected apart.
 *
 * The permission needs an admin consent on the app registration AND a
 * grant on the individual site, and Graph denies a request missing either
 * one with the same bare `accessDenied`. Setting this up stalled exactly
 * there: the site grant was verified correct — right site, right
 * application, `write` role — and the call still failed, because the
 * consent behind it had never been given.
 *
 * The token distinguishes them, and a JWT payload is signed rather than
 * encrypted, so reading the roles claim needs no secret.
 */
import { describe, expect, it } from 'vitest'
import {
  describeTokenRoles, rolesFromAccessToken,
} from '../../supabase/functions/_shared/tokenRoles'

/** A token is three base64url segments; only the middle one is read. */
function tokenWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `header.${payload}.signature`
}

describe('reading the roles out of a token', () => {
  it('finds the roles an app-only token carries', () => {
    expect(rolesFromAccessToken(tokenWith({ roles: ['Sites.Selected'] })))
      .toEqual(['Sites.Selected'])
  })

  it('reports an empty list when the app was granted nothing', () => {
    // Distinct from null: this is a fact about the app, not a failure to
    // read it.
    expect(rolesFromAccessToken(tokenWith({ aud: 'graph' }))).toEqual([])
  })

  it('returns null for something that is not a token', () => {
    expect(rolesFromAccessToken('not-a-token')).toBeNull()
    expect(rolesFromAccessToken('')).toBeNull()
    expect(rolesFromAccessToken('a.!!!not-base64!!!.c')).toBeNull()
  })
})

describe('what it tells somebody looking at a 403', () => {
  it('says the consent never happened when there are no roles', () => {
    const said = describeTokenRoles(tokenWith({ roles: [] }))
    expect(said).toContain('never consented')
    expect(said).toContain('Grant admin consent')
  })

  it('warns that adding a permission is not consenting to it', () => {
    // The specific trap: an unconsented permission sits in the API
    // permissions list looking much like a granted one.
    expect(describeTokenRoles(tokenWith({})))
      .toContain('not the same as consenting')
  })

  it('names the roles it did find when the right one is absent', () => {
    const said = describeTokenRoles(tokenWith({ roles: ['Files.Read.All'] }))
    expect(said).toContain('Files.Read.All')
    expect(said).toContain('nothing to attach to')
  })

  it('says nothing when the token holds the role it needs', () => {
    // Then the site grant really is the problem, and the caller's own
    // message covers it. Commenting regardless would bury the real cause.
    expect(describeTokenRoles(tokenWith({ roles: ['Sites.Selected'] }))).toBeNull()
  })

  it('says nothing when the token could not be read', () => {
    expect(describeTokenRoles('not-a-token')).toBeNull()
  })
})

describe('what it must never do', () => {
  it('does not return any part of the token', () => {
    const token = tokenWith({ roles: [], sub: 'super-secret-subject-claim' })
    const said = describeTokenRoles(token) ?? ''
    for (const segment of token.split('.')) {
      expect(said).not.toContain(segment)
    }
    expect(said).not.toContain('super-secret-subject-claim')
  })
})
