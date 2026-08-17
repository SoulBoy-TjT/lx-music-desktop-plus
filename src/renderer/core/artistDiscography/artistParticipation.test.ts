import { describe, expect, it } from 'vitest'
import { isArtistParticipation } from './artistParticipation'

describe('isArtistParticipation', () => {
  it.each([
    ['蔡徐坤', true],
    ['周杰伦、蔡徐坤', true],
    ['蔡徐坤 feat. Other Singer', true],
    ['Other Singer ft 蔡徐坤', true],
    ['Other Singer / 蔡徐坤', true],
    ['Other Singer，蔡徐坤', true],
    ['Other Singer；蔡徐坤', true],
    ['Other Singer | 蔡徐坤', true],
    ['Other Singer & 蔡徐坤', true],
    ['Other Singer+蔡徐坤', true],
    ['Other Singer x 蔡徐坤', true],
    ['KUN蔡徐坤', true],
    ['蔡-徐坤', true],
    ['蔡徐坤工作室', false],
    ['小蔡徐坤', false],
    ['Other Singer', false],
    ['', false],
  ])('matches a complete artist item for %j', (candidate, expected) => {
    expect(isArtistParticipation('蔡徐坤', candidate)).toBe(expected)
  })

  it('normalizes width and case without treating English substrings as identities', () => {
    expect(isArtistParticipation('Adele', 'ＡＤＥＬＥ & Guest')).toBe(true)
    expect(isArtistParticipation('Adele', 'The Adele Band')).toBe(false)
  })

  it('rejects empty confirmed artists', () => {
    expect(isArtistParticipation('', '蔡徐坤')).toBe(false)
  })
})
