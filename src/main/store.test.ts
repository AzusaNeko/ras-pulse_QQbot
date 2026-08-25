import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore } from './store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('JsonStore', () => {
  it('repairs legacy Mercari Shops URLs in activity and favorites', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mercari-pulse-store-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'state.json')
    const legacyItem = {
      id: '2JLVrjYGogvEbks8Xvz8wM',
      name: 'ブルガリ ビーゼロワン',
      price: 217_840,
      thumbnail: 'https://assets.mercari-shops-static.com/example.webp',
      url: 'https://jp.mercari.com/item/2JLVrjYGogvEbks8Xvz8wM',
      status: 'ITEM_STATUS_ON_SALE',
      detectedAt: 1,
      subscriptionId: 'watch-1',
      keyword: 'バンドリ'
    }
    await writeFile(filePath, JSON.stringify({
      recentItems: [legacyItem],
      favorites: [{ ...legacyItem, addedAt: 1 }]
    }), 'utf8')

    const state = await new JsonStore(filePath).load()

    expect(state.recentItems[0]).toMatchObject({
      itemType: 'ITEM_TYPE_BEYOND',
      url: 'https://jp.mercari.com/shops/product/2JLVrjYGogvEbks8Xvz8wM'
    })
    expect(state.favorites[0]).toMatchObject({
      itemType: 'ITEM_TYPE_BEYOND',
      url: 'https://jp.mercari.com/shops/product/2JLVrjYGogvEbks8Xvz8wM'
    })
  })
})
