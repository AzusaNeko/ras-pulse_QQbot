import { describe, expect, it } from 'vitest'
import { MERCARI_SHOPS_ITEM_TYPE, parseMercariItemReference } from './mercari-item-url'

describe('Mercari item reference parsing', () => {
  it('accepts standard item IDs and Japanese Mercari product links', () => {
    expect(parseMercariItemReference('m12345678901')).toMatchObject({ id: 'm12345678901', url: 'https://jp.mercari.com/item/m12345678901' })
    expect(parseMercariItemReference('https://jp.mercari.com/item/m12345678901?utm_source=share')).toMatchObject({ id: 'm12345678901', url: 'https://jp.mercari.com/item/m12345678901' })
    expect(parseMercariItemReference('https://jp.mercari.com/shops/product/2JVr3sAQkr9DiWbLhYmymr')).toMatchObject({ id: '2JVr3sAQkr9DiWbLhYmymr', itemType: MERCARI_SHOPS_ITEM_TYPE })
  })

  it('rejects non-Mercari links and malformed values', () => {
    expect(() => parseMercariItemReference('https://example.com/item/m12345678901')).toThrow('仅支持日本 Mercari')
    expect(() => parseMercariItemReference('not-an-id')).toThrow('商品 ID 格式无效')
  })
})
