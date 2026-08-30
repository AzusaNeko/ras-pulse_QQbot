import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { MercariItem, Subscription } from '../shared/types'
import { toMercariExcludeKeyword } from './exclude-keywords'
import { buildMercariItemUrl, isMercariShopsItem, isSupportedMercariImageUrl } from './mercari-item-url'

const SEARCH_URL = 'https://api.mercari.jp/v2/entities:search'
const REQUEST_TIMEOUT_MS = 8_000

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface ApiItem {
  id?: string
  name?: string
  price?: number | string
  thumbnails?: string[]
  status?: string
  created?: number | string
  updated?: number | string
  auction?: unknown
  isAuction?: boolean
  auction_info?: unknown
  auctionInfo?: unknown
  itemType?: string
}

interface SearchResponse {
  items?: ApiItem[]
}

interface JsonLdProduct {
  '@type'?: string | string[]
  name?: string
  image?: string | string[]
  offers?: { price?: number | string } | Array<{ price?: number | string }>
}

function findProductJsonLd(page: string): JsonLdProduct | undefined {
  const candidates: unknown[] = []
  for (const match of page.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { candidates.push(JSON.parse(match[1])) } catch { /* Ignore unrelated malformed JSON-LD. */ }
  }
  const visit = (value: unknown): JsonLdProduct | undefined => {
    if (Array.isArray(value)) {
      for (const entry of value) { const product = visit(entry); if (product) return product }
      return undefined
    }
    if (!value || typeof value !== 'object') return undefined
    const candidate = value as JsonLdProduct & { '@graph'?: unknown[] }
    const types = Array.isArray(candidate['@type']) ? candidate['@type'] : [candidate['@type']]
    if (types.some((type) => type?.toLowerCase() === 'product') && candidate.name) return candidate
    return candidate['@graph'] ? visit(candidate['@graph']) : undefined
  }
  for (const candidate of candidates) { const product = visit(candidate); if (product) return product }
  return undefined
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
      updatedAt: item.updated == null ? undefined : Number(item.updated),
      detectedAt,
      subscriptionId: subscription.id,
      keyword: subscription.keyword
    }]
  })
}

export class MercariClient implements ItemSource {
  constructor(
    private readonly fetcher: FetchLike = globalThis.fetch,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS
  ) {}

  async search(subscription: Subscription, options: ItemSearchOptions = {}): Promise<MercariItem[]> {
    const statusGroups = options.includeSold
      ? [['STATUS_ON_SALE'], ['STATUS_SOLD_OUT']]
      : [['STATUS_ON_SALE']]
    const batches = await Promise.all(statusGroups.map((statuses) => this.searchByStatus(subscription, statuses)))
    const unique = new Map<string, MercariItem>()
    for (const item of batches.flat()) unique.set(item.id, item)
    // The endpoint's order is the same ranking shown by Mercari's “newest”
    // web search. `created` can be the original listing time for a subsequently
    // edited/re-indexed item, so sorting it again would incorrectly bury it.
    return [...unique.values()]
  }

  private async searchByStatus(subscription: Subscription, statuses: string[]): Promise<MercariItem[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const searchCondition: Record<string, unknown> = {
      keyword: subscription.keyword,
      sort: 'SORT_CREATED_TIME',
      order: 'ORDER_DESC',
      status: statuses,
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
      excludeKeyword: toMercariExcludeKeyword(subscription.excludeKeyword)
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
      const response = await this.fetcher(SEARCH_URL, {
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
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('Mercari 请求超时，请检查网络或系统代理')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async isImageAccessible(item: MercariItem): Promise<boolean> {
    if (!isSupportedMercariImageUrl(item.thumbnail)) return false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_500)
    try {
      const response = await this.fetcher(item.thumbnail, {
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
    if (isMercariShopsItem(item)) return this.getShopsItem(item)
    const url = `https://api.mercari.jp/items/get?id=${encodeURIComponent(item.id)}&include_auction=true`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(url, {
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

  /** Shops listings do not support the ordinary item-detail endpoint. */
  private async getShopsItem(item: MercariItem): Promise<MercariItem | undefined> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(item.url, {
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'python-mercari' }
      })
      if (response.status === 404) return { ...item, status: 'ITEM_STATUS_SOLD_OUT', detectedAt: Date.now() }
      if (!response.ok) throw new Error(`Mercari Shops page ${response.status}`)
      const page = await response.text()
      // Mercari Shops exposes Product JSON-LD availability on the item page.
      // Only change state when the listing's own availability is explicit; a
      // missing or changed page marker must not incorrectly mark it as sold.
      const normalizedPage = page.replaceAll('\\/', '/').replaceAll('\\"', '"')
      const availability = normalizedPage.match(/"availability"\s*:\s*"https?:\/\/schema\.org\/([^"\\]+)/i)?.[1]
      const status = availability?.toLowerCase() === 'outofstock'
        ? 'ITEM_STATUS_SOLD_OUT'
        : availability?.toLowerCase() === 'instock'
          ? 'ITEM_STATUS_ON_SALE'
          : item.status
      const product = findProductJsonLd(normalizedPage)
      const offer = Array.isArray(product?.offers) ? product.offers[0] : product?.offers
      const parsedPrice = Number(offer?.price)
      const image = Array.isArray(product?.image) ? product.image[0] : product?.image
      if (!item.name && (!product?.name || !Number.isFinite(parsedPrice))) return undefined
      return {
        ...item,
        name: product?.name ?? item.name,
        price: Number.isFinite(parsedPrice) ? parsedPrice : item.price,
        thumbnail: image ?? item.thumbnail,
        status,
        detectedAt: Date.now()
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
