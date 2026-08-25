import { describe, expect, it } from 'vitest'
import type { MercariItem, Subscription } from '../shared/types'
import type { ItemSource } from './mercari-client'
import { MonitorEngine } from './monitor-engine'
import { defaultState, type PersistedState, type StateStore } from './store'

class MemoryStore implements StateStore {
  state: PersistedState = structuredClone(defaultState)
  async load(): Promise<PersistedState> { return structuredClone(this.state) }
  async save(state: PersistedState): Promise<void> { this.state = structuredClone(state) }
}

class FakeSource implements ItemSource {
  items: MercariItem[] = []
  inaccessible = new Set<string>()
  async search(subscription: Subscription): Promise<MercariItem[]> {
    return structuredClone(this.items).map((value) => ({ ...value, subscriptionId: subscription.id }))
  }
  async isImageAccessible(item: MercariItem): Promise<boolean> { return !this.inaccessible.has(item.id) }
}

function item(id: string): MercariItem {
  return {
    id,
    name: `商品 ${id}`,
    price: 1_000,
    thumbnail: '',
    url: `https://jp.mercari.com/item/${id}`,
    status: 'ITEM_STATUS_ON_SALE',
    isAuction: false,
    detectedAt: Date.now(),
    subscriptionId: 'source-value',
    keyword: '相机'
  }
}

describe('MonitorEngine baseline', () => {
  it.each([1, 2, 3, 4, 5])('shows the newest %i initial listings when the source response is out of order', async (initialDisplayCount) => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    source.items = [
      { ...item('m2'), createdAt: 2 },
      { ...item('m5'), createdAt: 5 },
      { ...item('m1'), createdAt: 1 },
      { ...item('m6'), createdAt: 6 },
      { ...item('m3'), createdAt: 3 },
      { ...item('m4'), createdAt: 4 }
    ]
    await engine.start()

    const snapshot = await engine.add({ keyword: `关键词-${initialDisplayCount}`, initialDisplayCount })
    await engine.checkNow(snapshot.subscriptions[0].id)

    expect(engine.snapshot().recentItems.map((value) => value.id)).toEqual(
      ['m6', 'm5', 'm4', 'm3', 'm2'].slice(0, initialDisplayCount)
    )
    engine.stop()
  })

  it('shows five initial products without emitting notifications, then emits new products', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    const notified: MercariItem[] = []
    source.items = Array.from({ length: 7 }, (_, index) => item(`m${index + 1}`))
    await engine.start()
    engine.on('newItem', (value) => notified.push(value))

    const snapshot = await engine.add({ keyword: '相机', initialDisplayCount: 3 })
    const subscriptionId = snapshot.subscriptions[0].id
    await engine.checkNow(subscriptionId)

    expect(engine.snapshot().recentItems).toHaveLength(3)
    expect(engine.snapshot().recentItems.every((value) => value.discoveryType === 'baseline')).toBe(true)
    expect(notified).toHaveLength(0)

    source.items = [item('m-new'), ...source.items]
    await engine.checkNow(subscriptionId)
    expect(engine.snapshot().recentItems[0]).toMatchObject({ id: 'm-new', discoveryType: 'new' })
    expect(notified.map((value) => value.id)).toEqual(['m-new'])

    await engine.dismissRecentItem(subscriptionId, 'm-new')
    expect(engine.snapshot().recentItems.some((value) => value.id === 'm-new')).toBe(false)
    await engine.remove(subscriptionId, false)
    expect(engine.snapshot().recentItems).toHaveLength(3)
    engine.stop()
  })

  it('can remove a subscription together with its related activity', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    source.items = [item('m1'), item('m2')]
    await engine.start()
    const snapshot = await engine.add({ keyword: '相机', initialDisplayCount: 2 })
    const subscriptionId = snapshot.subscriptions[0].id
    await engine.checkNow(subscriptionId)
    expect(engine.snapshot().recentItems).toHaveLength(2)
    await engine.remove(subscriptionId, true)
    expect(engine.snapshot().recentItems).toHaveLength(0)
    engine.stop()
  })

  it('ignores new items whose product image cannot be accessed', async () => {
    const source = new FakeSource()
    source.items = [item('m1')]
    const engine = new MonitorEngine(source, new MemoryStore())
    await engine.start()
    const snapshot = await engine.add({ keyword: '相机', initialDisplayCount: 2 })
    await engine.checkNow(snapshot.subscriptions[0].id)
    source.items = [item('m-broken'), ...source.items]
    source.inaccessible.add('m-broken')
    await engine.checkNow(snapshot.subscriptions[0].id)
    expect(engine.snapshot().recentItems.some((value) => value.id === 'm-broken')).toBe(false)
    engine.stop()
  })

  it('allows only one fast polling subscription', async () => {
    const engine = new MonitorEngine(new FakeSource(), new MemoryStore())
    await engine.start()
    await engine.add({ keyword: '关键词一', intervalMs: 500 })
    await expect(engine.add({ keyword: '关键词二', intervalMs: 500 })).rejects.toThrow('极速模式只允许一个关键词使用')
    await expect(engine.add({ keyword: '关键词二', intervalMs: 1_000 })).resolves.toBeDefined()
    engine.stop()
  })

  it('retries a new item after a temporary image validation failure', async () => {
    const source = new FakeSource()
    source.items = [item('m1')]
    const engine = new MonitorEngine(source, new MemoryStore())
    const notified: MercariItem[] = []
    await engine.start()
    engine.on('newItem', (value) => notified.push(value))
    const snapshot = await engine.add({ keyword: '相机', initialDisplayCount: 1 })
    await engine.checkNow(snapshot.subscriptions[0].id)

    source.items = [item('m2'), item('m1')]
    source.inaccessible.add('m2')
    await engine.checkNow(snapshot.subscriptions[0].id)
    expect(notified).toHaveLength(0)

    source.inaccessible.delete('m2')
    await engine.checkNow(snapshot.subscriptions[0].id)
    expect(notified.map((value) => value.id)).toEqual(['m2'])
    engine.stop()
  })

  it('retains up to 200 records per keyword and preserves a keyword\'s final record during global cleanup', async () => {
    const store = new MemoryStore()
    const records = (subscriptionId: string, count: number): MercariItem[] => Array.from({ length: count }, (_, index) => ({
      ...item(`${subscriptionId}-${index}`), subscriptionId, keyword: subscriptionId
    }))
    store.state.recentItems = [...records('keyword-a', 200), ...records('keyword-b', 100), ...records('keyword-c', 1)]
    const engine = new MonitorEngine(new FakeSource(), store)
    await engine.start()

    const recent = engine.snapshot().recentItems
    expect(recent).toHaveLength(300)
    expect(recent.filter((value) => value.subscriptionId === 'keyword-a')).toHaveLength(200)
    expect(recent.filter((value) => value.subscriptionId === 'keyword-b')).toHaveLength(99)
    expect(recent.filter((value) => value.subscriptionId === 'keyword-c')).toHaveLength(1)
    engine.stop()
  })
})
