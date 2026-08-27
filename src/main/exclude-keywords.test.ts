import { describe, expect, it } from 'vitest'
import { matchesExcludeKeyword, parseExcludeKeywords, toMercariExcludeKeyword } from './exclude-keywords'

describe('exclude keyword rules', () => {
  it('parses mixed separators and removes case-insensitive duplicates', () => {
    expect(parseExcludeKeywords(' バンドリーノ、Bandolino, bandolino\nバンドリエール '))
      .toEqual(['バンドリーノ', 'Bandolino', 'バンドリエール'])
  })

  it('uses spaces between terms for the Mercari API', () => {
    expect(toMercariExcludeKeyword('バンドリーノ、スピーディバンドリエール30、バンドリエール'))
      .toBe('バンドリーノ スピーディバンドリエール30 バンドリエール')
  })

  it('matches titles after Unicode and case normalization', () => {
    expect(matchesExcludeKeyword('ＢＡＮＤＯＬＩＮＯ レディースシューズ', 'bandolino')).toBe(true)
    expect(matchesExcludeKeyword('BanG Dream! グッズ', 'バンドリーノ、バンドリエール')).toBe(false)
  })
})
