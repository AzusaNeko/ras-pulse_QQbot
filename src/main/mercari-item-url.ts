const MERCARI_ORIGIN = 'https://jp.mercari.com'
const MERCARI_IMAGE_HOST = 'static.mercdn.net'
const MERCARI_SHOPS_IMAGE_HOST = 'assets.mercari-shops-static.com'

export const MERCARI_SHOPS_ITEM_TYPE = 'ITEM_TYPE_BEYOND'

interface MercariItemSource {
  id: string
  itemType?: string
  thumbnail?: string
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

export function isSupportedMercariImageUrl(value?: string): value is string {
  const host = hostname(value)
  return host === MERCARI_IMAGE_HOST || host === MERCARI_SHOPS_IMAGE_HOST
}
