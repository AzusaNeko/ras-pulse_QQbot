import { describe, expect, it, vi } from 'vitest'
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
  details = new Map<string, MercariItem>()
  includeSoldRequests: boolean[] = []
  detailRequests = 0
  async search(subscription: Subscription, options?: { includeSold?: boolean }): Promise<MercariItem[]> {
    this.includeSoldRequests.push(Boolean(options?.includeSold))
    return structuredClone(this.items).map((value) => ({ ...value, subscriptionId: subscription.id }))
  }
  async isImageAccessible(item: MercariItem): Promise<boolean> { return !this.inaccessible.has(item.id) }
  async getItem(item: MercariItem): Promise<MercariItem> { this.detailRequests += 1; return structuredClone(this.details.get(item.id) ?? item) }
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
  it.each([1, 2, 3, 4, 5])('preserves Mercari ranking for the %i initial listings', async (initialDisplayCount) => {
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
      ['m2', 'm5', 'm1', 'm6', 'm3'].slice(0, initialDisplayCount)
    )
    expect(source.includeSoldRequests).toContain(true)
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

  it('never shows sold listings when creating a baseline', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    source.items = [
      { ...item('sold-newest'), createdAt: 5, status: 'ITEM_STATUS_SOLD_OUT' },
      { ...item('sold-next'), createdAt: 4, status: 'ITEM_STATUS_SOLD_OUT' },
      { ...item('active-one'), createdAt: 3 },
      { ...item('active-two'), createdAt: 2 }
    ]
    await engine.start()
    const snapshot = await engine.add({ keyword: '相机', initialDisplayCount: 3 })
    await engine.checkNow(snapshot.subscriptions[0].id)

    expect(engine.snapshot().recentItems.map((value) => value.id)).toEqual(['active-one', 'active-two'])
    engine.stop()
  })

  it('remembers delayed old search results without announcing them as new', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    const notified: MercariItem[] = []
    source.items = [{ ...item('baseline'), createdAt: Math.floor(Date.now() / 1_000) }]
    await engine.start()
    engine.on('newItem', (value) => notified.push(value))
    const snapshot = await engine.add({ keyword: '相机', initialDisplayCount: 1 })
    await engine.checkNow(snapshot.subscriptions[0].id)

    source.items = [
      { ...item('old-delayed'), createdAt: Math.floor((Date.now() - 24 * 60 * 60_000) / 1_000) },
      { ...item('fresh'), createdAt: Math.floor(Date.now() / 1_000) },
      ...source.items
    ]
    await engine.checkNow(snapshot.subscriptions[0].id)
    await engine.checkNow(snapshot.subscriptions[0].id)

    expect(notified.map((value) => value.id)).toEqual(['fresh'])
    expect(engine.snapshot().recentItems.some((value) => value.id === 'old-delayed')).toBe(false)
    engine.stop()
  })

  it('adds a visible old-listing update when update monitoring is enabled', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    const notified: MercariItem[] = []
    source.items = [{ ...item('old-item'), createdAt: 1, updatedAt: 100 }]
    await engine.start()
    engine.on('newItem', (value) => notified.push(value))
    const snapshot = await engine.add({ keyword: '相机', initialDisplayCount: 1, monitorUpdates: true })
    await engine.checkNow(snapshot.subscriptions[0].id)

    source.items = [{ ...item('old-item'), createdAt: 1, updatedAt: 200, price: 200 }]
    await engine.checkNow(snapshot.subscriptions[0].id)

    expect(engine.snapshot().recentItems[0]).toMatchObject({ id: 'old-item', discoveryType: 'updated', updatedAt: 200, updateSummary: '价格 ¥1,000 → ¥200' })
    expect(notified[0]).toMatchObject({ id: 'old-item', discoveryType: 'updated', updateSummary: '价格 ¥1,000 → ¥200' })
    engine.stop()
  })

  it('marks a favorite as sold and emits a status update when its detail becomes sold out', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    const updates: Array<{ sold: boolean }> = []
    source.details.set('m1', { ...item('m1'), status: 'ITEM_STATUS_SOLD_OUT' })
    await engine.start()
    engine.on('favoriteUpdate', (update) => updates.push({ sold: update.sold }))

    await engine.addFavorite(item('m1'))

    await vi.waitFor(() => expect(engine.snapshot().favorites[0].status).toBe('ITEM_STATUS_SOLD_OUT'))
    expect(updates).toEqual([{ sold: true }])
    engine.stop()
  })

  it('stops polling a favorite after it has been marked sold', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    source.details.set('m1', { ...item('m1'), status: 'ITEM_STATUS_SOLD_OUT' })
    await engine.start()
    await engine.addFavorite(item('m1'))
    await vi.waitFor(() => expect(engine.snapshot().favorites[0].status).toBe('ITEM_STATUS_SOLD_OUT'))
    const requestsAfterSale = source.detailRequests
    await (engine as unknown as { checkFavorites(): Promise<void> }).checkFavorites()
    expect(source.detailRequests).toBe(requestsAfterSale)
    engine.stop()
  })

  it('treats Mercari trading status as sold for a favorite', async () => {
    const source = new FakeSource()
    const engine = new MonitorEngine(source, new MemoryStore())
    const updates: Array<{ sold: boolean }> = []
    source.details.set('m1', { ...item('m1'), status: 'trading' })
    await engine.start()
    engine.on('favoriteUpdate', (update) => updates.push({ sold: update.sold }))

    await engine.addFavorite(item('m1'))

    await vi.waitFor(() => expect(engine.snapshot().favorites[0].status).toBe('trading'))
    expect(updates).toEqual([{ sold: true }])
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

  it('can run 100 one-second keyword checks concurrently without losing a task', async () => {
    const source = new FakeSource()
    source.items = [item('baseline')]
    const engine = new MonitorEngine(source, new MemoryStore())
    await engine.start()
    const ids: string[] = []
    for (let index = 0; index < 100; index += 1) {
      const snapshot = await engine.add({ keyword: `负载测试-${index}`, intervalMs: 1_000, initialDisplayCount: 1 })
      ids.push(snapshot.subscriptions[0].id)
    }
    // The test invokes every check explicitly so its result does not depend
    // on wall-clock timer precision in CI.
    engine.stop()
    await Promise.all(ids.map((id) => engine.checkNow(id)))

    const snapshot = engine.snapshot()
    expect(snapshot.subscriptions).toHaveLength(100)
    expect(snapshot.subscriptions.every((subscription) => subscription.lastSuccessAt && !subscription.error)).toBe(true)
    expect(snapshot.recentItems).toHaveLength(100)
    engine.stop()
  })
})
