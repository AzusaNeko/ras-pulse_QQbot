import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDpop, parseSearchResponse } from './mercari-client'

describe('Mercari client', () => {
  it('creates a valid ES256 DPoP proof', () => {
    const token = createDpop('POST', 'https://api.mercari.jp/v2/entities:search', 'test-request')
    const [encodedHeader, encodedPayload, signature] = token.split('.')
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString())
    const key = createPublicKey({ key: header.jwk, format: 'jwk' })

    expect(payload.htm).toBe('POST')
    expect(payload.jti).toBe('test-request')
    expect(verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), {
      key,
      dsaEncoding: 'ieee-p1363'
    }, Buffer.from(signature, 'base64url'))).toBe(true)
  })

  it('drops malformed items and maps valid results', () => {
    const result = parseSearchResponse({ items: [
      { id: 'm123', name: '相机', price: '18000', thumbnails: ['https://example.com/a.jpg'], status: 'ITEM_STATUS_ON_SALE' },
      { id: 'broken', name: '无价格' }
    ] }, { id: 'watch-1', keyword: '相机' }, 1234)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'm123', price: 18000, detectedAt: 1234, subscriptionId: 'watch-1' })
  })
})
