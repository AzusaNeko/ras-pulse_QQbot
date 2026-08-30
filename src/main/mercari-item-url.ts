const MERCARI_ORIGIN = 'https://jp.mercari.com'
const MERCARI_IMAGE_HOST = 'static.mercdn.net'
const MERCARI_SHOPS_IMAGE_HOST = 'assets.mercari-shops-static.com'

export const MERCARI_SHOPS_ITEM_TYPE = 'ITEM_TYPE_BEYOND'

interface MercariItemSource {
  id: string
  itemType?: string
  thumbnail?: string
}

export interface MercariItemReference {
  id: string
  itemType?: string
  url: string
}

function hostname(value?: string): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

export function isMercariShopsItem(item: MercariItemSource): boolean {
  return item.itemType === MERCARI_SHOPS_ITEM_TYPE
    || (item.itemType == null && hostname(item.thumbnail) === MERCARI_SHOPS_IMAGE_HOST)
}

export function buildMercariItemUrl(item: MercariItemSource): string {
  const encodedId = encodeURIComponent(item.id)
  return isMercariShopsItem(item)
    ? `${MERCARI_ORIGIN}/shops/product/${encodedId}`
    : `${MERCARI_ORIGIN}/item/${encodedId}`
}

/** Parses a Japanese Mercari item URL or a plain standard item ID. */
export function parseMercariItemReference(value: string): MercariItemReference {
  const input = value.trim()
  if (!input) throw new Error('请输入 Mercari 商品网址或商品 ID。')
  if (!input.includes('://')) {
    if (!/^m\d{6,}$/i.test(input)) throw new Error('商品 ID 格式无效。请粘贴以 m 开头的 Mercari 商品 ID，或完整商品链接。')
    return { id: input, url: buildMercariItemUrl({ id: input }) }
  }
  let parsed: URL
  try { parsed = new URL(input) } catch { throw new Error('商品网址格式无效。') }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'jp.mercari.com') {
    throw new Error('仅支持日本 Mercari 商品链接（jp.mercari.com）。')
  }
  const parts = parsed.pathname.split('/').filter(Boolean)
  const isStandard = parts.length === 2 && parts[0] === 'item'
  const isShops = parts.length === 3 && parts[0] === 'shops' && parts[1] === 'product'
  const id = isStandard ? parts[1] : isShops ? parts[2] : undefined
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('这不是有效的 Mercari 商品链接。')
  const itemType = isShops ? MERCARI_SHOPS_ITEM_TYPE : undefined
  return { id, itemType, url: buildMercariItemUrl({ id, itemType }) }
}

export function isSupportedMercariImageUrl(value?: string): value is string {
  const host = hostname(value)
  return host === MERCARI_IMAGE_HOST || host === MERCARI_SHOPS_IMAGE_HOST
}
