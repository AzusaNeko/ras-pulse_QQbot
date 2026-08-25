import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { MercariItem, Subscription } from '../shared/types'
import { buildMercariItemUrl, isMercariShopsItem, isSupportedMercariImageUrl } from './mercari-item-url'

const SEARCH_URL = 'https://api.mercari.jp/v2/entities:search'

interface ApiItem {
  id?: string
  name?: string
  price?: number | string
  thumbnails?: string[]
  status?: string
  created?: number | string
  auction?: unknown
  isAuction?: boolean
  auction_info?: unknown
  auctionInfo?: unknown
  itemType?: string
}

interface SearchResponse {
  items?: ApiItem[]
}

export interface ItemSource {
  search(subscription: Subscription, options?: ItemSearchOptions): Promise<MercariItem[]>
}

export interface ItemSearchOptions {
  /** Include sold listings when creating a keyword's initial baseline. */
  includeSold?: boolean
}

/** Optional capability for sources that can verify a listing thumbnail before it is surfaced. */
export interface ItemImageValidator {
  isImageAccessible(item: MercariItem): Promise<boolean>
}

export interface ItemDetailSource {
  getItem(item: MercariItem): Promise<MercariItem | undefined>
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
      url: buildMercariItemUrl({ id: item.id, itemType: item.itemType, thumbnail: item.thumbnails?.[0] }),
      status: item.status ?? 'ITEM_STATUS_UNSPECIFIED',
      itemType: item.itemType,
      isAuction: item.auction ? true : undefined,
      createdAt: item.created == null ? undefined : Number(item.created),
      detectedAt,
      subscriptionId: subscription.id,
      keyword: subscription.keyword
    }]
  }).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
}

export class MercariClient implements ItemSource {
  async search(subscription: Subscription, options: ItemSearchOptions = {}): Promise<MercariItem[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    const searchCondition: Record<string, unknown> = {
      keyword: subscription.keyword,
      sort: 'SORT_CREATED_TIME',
      order: 'ORDER_DESC',
      // Only the initial baseline includes sold listings. Later polling keeps
      // to on-sale results so historic sold items cannot become false alerts.
      status: options.includeSold ? ['STATUS_ON_SALE', 'STATUS_SOLD_OUT'] : ['STATUS_ON_SALE'],
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
    if (!isSupportedMercariImageUrl(item.thumbnail)) return false
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

  async getItem(item: MercariItem): Promise<MercariItem | undefined> {
    if (isMercariShopsItem(item)) return item
    const url = `https://api.mercari.jp/items/get?id=${encodeURIComponent(item.id)}&include_auction=true`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: '*/*', dpop: createDpop('GET', url), 'x-platform': 'web', 'user-agent': 'python-mercari' }
      })
      if (response.status === 404) return { ...item, status: 'ITEM_STATUS_SOLD_OUT', detectedAt: Date.now() }
      if (!response.ok) throw new Error(`Mercari item API ${response.status}`)
      const payload = await response.json() as { item?: ApiItem, data?: { item?: ApiItem } | ApiItem }
      const detail = (payload.item ?? (payload.data && 'item' in payload.data ? payload.data.item : payload.data)) as ApiItem | undefined
      if (!detail || typeof detail !== 'object' || !detail.id || !detail.name || !Number.isFinite(Number(detail.price))) return undefined
      return {
        ...item,
        name: detail.name,
        price: Number(detail.price),
        thumbnail: detail.thumbnails?.[0] ?? item.thumbnail,
        status: detail.status ?? item.status,
        isAuction: Boolean(detail.auction_info ?? detail.auctionInfo ?? detail.auction ?? detail.isAuction),
        detectedAt: Date.now()
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
