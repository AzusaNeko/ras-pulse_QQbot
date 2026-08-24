import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { MercariItem, Subscription } from '../shared/types'

const SEARCH_URL = 'https://api.mercari.jp/v2/entities:search'

interface ApiItem {
  id?: string
  name?: string
  price?: number | string
  thumbnails?: string[]
  status?: string
  created?: number | string
}

interface SearchResponse {
  items?: ApiItem[]
}

export interface ItemSource {
  search(subscription: Subscription): Promise<MercariItem[]>
}

/** Optional capability for sources that can verify a listing thumbnail before it is surfaced. */
export interface ItemImageValidator {
  isImageAccessible(item: MercariItem): Promise<boolean>
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function createDpop(method: string, url: string, requestId: string = randomUUID()): string {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const header = base64urlJson({
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  })
  const payload = base64urlJson({
    iat: Math.floor(Date.now() / 1000),
    jti: requestId,
    htu: url,
    htm: method.toUpperCase()
  })
  const data = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(data), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url')
  return `${data}.${signature}`
}

export function parseSearchResponse(
  response: SearchResponse,
  subscription: Pick<Subscription, 'id' | 'keyword'>,
  detectedAt = Date.now()
): MercariItem[] {
  if (!Array.isArray(response.items)) return []
  return response.items.flatMap((item) => {
    const numericPrice = Number(item.price)
    if (!item.id || !item.name || !Number.isFinite(numericPrice)) return []
    return [{
      id: item.id,
      name: item.name,
      price: numericPrice,
      thumbnail: item.thumbnails?.[0] ?? '',
      url: `https://jp.mercari.com/item/${encodeURIComponent(item.id)}`,
      status: item.status ?? 'ITEM_STATUS_UNSPECIFIED',
      createdAt: item.created == null ? undefined : Number(item.created),
      detectedAt,
      subscriptionId: subscription.id,
      keyword: subscription.keyword
    }]
  })
}

export class MercariClient implements ItemSource {
  async search(subscription: Subscription): Promise<MercariItem[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    const searchCondition: Record<string, unknown> = {
      keyword: subscription.keyword,
      sort: 'SORT_CREATED_TIME',
      order: 'ORDER_DESC',
      status: ['STATUS_ON_SALE'],
      sizeId: [],
      categoryId: [],
      brandId: [],
      sellerId: [],
      priceMin: subscription.minPrice ?? 0,
      priceMax: subscription.maxPrice ?? 0,
      itemConditionId: [],
      shippingPayerId: [],
      shippingFromArea: [],
      shippingMethod: [],
      colorId: [],
      hasCoupon: false,
      attributes: [],
      itemTypes: [],
      skuIds: [],
      excludeKeyword: subscription.excludeKeyword
    }

    const body = {
      userId: '',
      pageSize: 120,
      pageToken: '',
      searchSessionId: randomUUID().replaceAll('-', ''),
      indexRouting: 'INDEX_ROUTING_UNSPECIFIED',
      thumbnailTypes: [],
      searchCondition,
      defaultDatasets: [],
      serviceFrom: 'suruga'
    }

    try {
      const response = await fetch(SEARCH_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          accept: '*/*',
          'content-type': 'application/json; charset=utf-8',
          dpop: createDpop('POST', SEARCH_URL),
          'x-platform': 'web',
          'user-agent': 'python-mercari'
        },
        body: JSON.stringify(body)
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 160)
        throw new Error(`Mercari API ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const payload = (await response.json()) as SearchResponse
      if (process.env.MERCARI_PULSE_DEBUG_RESPONSE === '1') {
        console.error(JSON.stringify(payload).slice(0, 2_000))
      }
      return parseSearchResponse(payload, subscription)
    } finally {
      clearTimeout(timeout)
    }
  }

  async isImageAccessible(item: MercariItem): Promise<boolean> {
    if (!item.thumbnail.startsWith('https://static.mercdn.net/')) return false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_500)
    try {
      const response = await fetch(item.thumbnail, {
        signal: controller.signal,
        headers: { range: 'bytes=0-0' }
      })
      const type = response.headers.get('content-type') ?? ''
      return response.ok && (!type || type.startsWith('image/'))
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }
}
