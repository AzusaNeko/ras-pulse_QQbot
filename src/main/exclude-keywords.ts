const EXCLUDE_KEYWORD_SEPARATOR = /[，,、\r\n]+/

function normalizeForComparison(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

export function parseExcludeKeywords(value = ''): string[] {
  const seen = new Set<string>()
  return value
    .split(EXCLUDE_KEYWORD_SEPARATOR)
    .map((term) => term.trim())
    .filter((term) => {
      if (!term) return false
      const normalized = normalizeForComparison(term)
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
}

export function toMercariExcludeKeyword(value = ''): string {
  return parseExcludeKeywords(value).join(' ')
}

export function matchesExcludeKeyword(title: string, value = ''): boolean {
  const normalizedTitle = normalizeForComparison(title)
  return parseExcludeKeywords(value)
    .some((term) => normalizedTitle.includes(normalizeForComparison(term)))
}
