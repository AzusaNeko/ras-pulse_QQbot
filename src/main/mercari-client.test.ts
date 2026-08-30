import { createPublicKey, verify } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MercariItem, Subscription } from '../shared/types'
import { createDpop, MercariClient, parseSearchResponse } from './mercari-client'

const shopsItem: MercariItem = {
  id: '2JLVrjYGogvEbks8Xvz8wM',
  name: 'ブルガリ ビーゼロワン',
  price: 217_840,
  thumbnail: 'https://assets.mercari-shops-static.com/example.webp',
  url: 'https://jp.mercari.com/shops/product/2JLVrjYGogvEbks8Xvz8wM',
  status: 'ITEM_STATUS_ON_SALE',
  itemType: 'ITEM_TYPE_BEYOND',
  detectedAt: 1,
  subscriptionId: 'watch-1',
  keyword: 'バンドリ'
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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
      { id: 'm123', name: '相机', price: '18000', thumbnails: ['https://example.com/a.jpg'], status: 'ITEM_STATUS_ON_SALE', auction: { id: 'auction-1' } },
      { id: 'broken', name: '无价格' }
    ] }, { id: 'watch-1', keyword: '相机' }, 1234)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'm123',
      price: 18000,
      url: 'https://jp.mercari.com/item/m123',
      isAuction: true,
      detectedAt: 1234,
      subscriptionId: 'watch-1'
    })
  })

  it('preserves the ranking order returned by Mercari search', () => {
    const result = parseSearchResponse({ items: [
      { id: 'older', name: '较早商品', price: 1_000, created: 100 },
      { id: 'newer', name: '较新商品', price: 1_000, created: 200 }
    ] }, { id: 'watch-1', keyword: '相机' }, 1234)

    expect(result.map((item) => item.id)).toEqual(['older', 'newer'])
  })

  it('keeps Mercari item update timestamps from search results', () => {
    const result = parseSearchResponse({ items: [
      { id: 'm123', name: '相机', price: 1_000, created: 100, updated: 200 }
    ] }, { id: 'watch-1', keyword: '相机' }, 1234)

    expect(result[0]).toMatchObject({ createdAt: 100, updatedAt: 200 })
  })

  it('requests on-sale and sold-out listings separately for an initial baseline', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const subscription = { id: 'watch-1', keyword: '相机' } as Subscription

    await new MercariClient().search(subscription, { includeSold: true })

    const statuses = fetchMock.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).searchCondition.status)
    expect(statuses).toEqual([['STATUS_ON_SALE'], ['STATUS_SOLD_OUT']])
  })

  it('uses an injected fetch implementation for Mercari requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('global fetch must not be used') }))
    const injectedFetch = vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: 'm-proxy', name: '代理商品', price: 2_400, thumbnails: [] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const subscription = { id: 'watch-1', keyword: '相机' } as Subscription

    const result = await new MercariClient(injectedFetch).search(subscription)

    expect(injectedFetch).toHaveBeenCalledOnce()
    expect(injectedFetch).toHaveBeenCalledWith('https://api.mercari.jp/v2/entities:search', expect.objectContaining({
      method: 'POST',
      signal: expect.any(AbortSignal)
    }))
    expect(result).toMatchObject([{ id: 'm-proxy', name: '代理商品', subscriptionId: 'watch-1' }])
  })

  it('sends multiple exclusion terms using Mercari-compatible spaces', async () => {
    const injectedFetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const subscription = {
      id: 'watch-1',
      keyword: 'バンドリ',
      excludeKeyword: 'バンドリーノ、スピーディバンドリエール30、バンドリエール'
    } as Subscription

    await new MercariClient(injectedFetch).search(subscription)

    const request = injectedFetch.mock.calls[0][1]
    expect(JSON.parse(String(request?.body)).searchCondition.excludeKeyword)
      .toBe('バンドリーノ スピーディバンドリエール30 バンドリエール')
  })

  it('reports an actionable error when the search request times out', async () => {
    vi.useFakeTimers()
    const abortingFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
    }))
    const subscription = { id: 'watch-1', keyword: '相机' } as Subscription

    const request = new MercariClient(abortingFetch, 5).search(subscription)
    const result = request.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5)

    expect(await result).toMatchObject({ message: 'Mercari 请求超时，请检查网络或系统代理' })
  })

  it('maps Mercari Shops results to the Shops product route', () => {
    const result = parseSearchResponse({ items: [{
      id: shopsItem.id,
      name: shopsItem.name,
      price: shopsItem.price,
      thumbnails: [shopsItem.thumbnail],
      status: shopsItem.status,
      itemType: 'ITEM_TYPE_BEYOND'
    }] }, { id: 'watch-1', keyword: 'バンドリ' }, 1234)

    expect(result[0]).toMatchObject({
      itemType: 'ITEM_TYPE_BEYOND',
      url: 'https://jp.mercari.com/shops/product/2JLVrjYGogvEbks8Xvz8wM'
    })
  })

  it('accepts Mercari Shops thumbnails as product images', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/webp' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await new MercariClient().isImageAccessible(shopsItem)).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reads Shops product availability from its product page', async () => {
    const fetchMock = vi.fn(async () => new Response('<script type="application/ld+json">{"offers":{"availability":"https://schema.org/OutOfStock"}}</script>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new MercariClient().getItem(shopsItem)

    expect(result).toMatchObject({ id: shopsItem.id, status: 'ITEM_STATUS_SOLD_OUT' })
    expect(fetchMock).toHaveBeenCalledWith(shopsItem.url, expect.objectContaining({ headers: expect.any(Object) }))
  })

  it('reads enough Shops JSON-LD detail to add a product directly by URL', async () => {
    const fetchMock = vi.fn(async () => new Response('<script type="application/ld+json">{"@type":"Product","name":"店铺商品","image":"https://assets.mercari-shops-static.com/product.webp","offers":{"price":"2800","availability":"https://schema.org/InStock"}}</script>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new MercariClient().getItem({ ...shopsItem, name: '', price: 0, thumbnail: '' })

    expect(result).toMatchObject({ name: '店铺商品', price: 2800, thumbnail: 'https://assets.mercari-shops-static.com/product.webp', status: 'ITEM_STATUS_ON_SALE' })
  })
})
