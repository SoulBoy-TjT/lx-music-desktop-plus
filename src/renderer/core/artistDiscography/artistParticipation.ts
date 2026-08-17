const COMPARE_PUNCTUATION_RE = /[\s\-_.·・、，,。；;：:"“”‘’'!?！？()[\]（）【】《》<>/\\|]+/gu
const ARTIST_SEPARATOR_RE = /\s*(?:\/|、|,|，|;|；|\||&|＆|\+| feat\.? | ft\.? | with | x )\s*/iu
const LATIN_ALIAS_RE = /[a-z0-9]+/gu
const CJK_RE = /[\u3400-\u9fff]/u

const normalizeCompareText = (value: string): string => value
  .normalize('NFKC')
  .toLowerCase()
  .replace(COMPARE_PUNCTUATION_RE, '')

const splitArtistNames = (value: string): string[] => {
  const text = value.trim()
  return text ? text.split(ARTIST_SEPARATOR_RE).map(name => name.trim()).filter(Boolean) : []
}

const stripLatinAlias = (value: string): string => value.replace(LATIN_ALIAS_RE, '')

export const isArtistParticipation = (
  confirmedArtist: string,
  candidateSinger: string,
): boolean => {
  const target = normalizeCompareText(confirmedArtist)
  if (!target) return false
  const targetWithoutLatinAlias = stripLatinAlias(target)

  return splitArtistNames(candidateSinger).some(name => {
    const candidate = normalizeCompareText(name)
    if (candidate == target) return true
    const candidateWithoutLatinAlias = stripLatinAlias(candidate)
    return CJK_RE.test(targetWithoutLatinAlias) &&
      candidateWithoutLatinAlias == targetWithoutLatinAlias
  })
}
