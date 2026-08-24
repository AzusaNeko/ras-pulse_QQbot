import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AppSnapshot, AppSettings, MercariItem, NewSubscription, Subscription } from '../shared/types'
import type { ItemImageValidator, ItemSource } from './mercari-client'
import type { PersistedState, StateStore } from './store'

const MIN_INTERVAL_MS = 1_000
const MAX_RECENT_ITEMS = 200
const MAX_SEEN_IDS = 500

function clampInitialDisplayCount(value?: number): number {
  return Math.min(5, Math.max(1, Math.trunc(value ?? 2)))
}

export interface EngineEvents {
  snapshot: [AppSnapshot]
  newItem: [MercariItem]
}

export class MonitorEngine extends EventEmitter<EngineEvents> {
  private state!: PersistedState
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Set<string>()
  private startedAt = Date.now()

  constructor(
    private readonly source: ItemSource,
    private readonly store: StateStore
  ) { super() }

  async start(): Promise<void> {
    this.state = await this.store.load()
    this.startedAt = Date.now()
    for (const subscription of this.state.subscriptions) this.schedule(subscription.id, 120)
    this.emitSnapshot()
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  snapshot(): AppSnapshot {
    return {
      subscriptions: structuredClone(this.state.subscriptions),
      recentItems: structuredClone(this.state.recentItems),
      settings: structuredClone(this.state.settings),
      startedAt: this.startedAt
    }
  }

  async add(input: NewSubscription): Promise<AppSnapshot> {
    const keyword = input.keyword.trim()
    if (!keyword) throw new Error('关键词不能为空')
    if (this.state.subscriptions.some((item) => item.keyword.toLowerCase() === keyword.toLowerCase())) {
      throw new Error('该关键词已在监控中')
    }
    const subscription: Subscription = {
      id: randomUUID(),
      keyword,
      excludeKeyword: input.excludeKeyword?.trim() ?? '',
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
      initialDisplayCount: clampInitialDisplayCount(input.initialDisplayCount),
      enabled: true,
      intervalMs: Math.max(MIN_INTERVAL_MS, input.intervalMs ?? this.state.settings.defaultIntervalMs),
      createdAt: Date.now(),
      status: 'watching',
      consecutiveErrors: 0
    }
    this.state.subscriptions.unshift(subscription)
    await this.persistAndEmit()
    this.schedule(subscription.id, 20)
    return this.snapshot()
  }

  async update(id: string, patch: Partial<Subscription>): Promise<AppSnapshot> {
    const subscription = this.requireSubscription(id)
    Object.assign(subscription, patch, {
      id,
      intervalMs: Math.max(MIN_INTERVAL_MS, patch.intervalMs ?? subscription.intervalMs)
    })
    await this.persistAndEmit()
    this.schedule(id, 20)
    return this.snapshot()
  }

  async remove(id: string, removeRelatedItems = false): Promise<AppSnapshot> {
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.id !== id)
    if (removeRelatedItems) {
      this.state.recentItems = this.state.recentItems.filter((item) => item.subscriptionId !== id)
    }
    delete this.state.seenBySubscription[id]
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    await this.persistAndEmit()
    return this.snapshot()
  }

  async dismissRecentItem(subscriptionId: string, itemId: string): Promise<AppSnapshot> {
    this.state.recentItems = this.state.recentItems.filter(
      (item) => !(item.subscriptionId === subscriptionId && item.id === itemId)
    )
    await this.persistAndEmit()
    return this.snapshot()
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSnapshot> {
    this.state.settings = { ...this.state.settings, ...patch }
    await this.persistAndEmit()
    return this.snapshot()
  }

  async checkNow(id: string): Promise<void> {
    await this.check(id, true)
  }

  private schedule(id: string, delay?: number): void {
    const oldTimer = this.timers.get(id)
    if (oldTimer) clearTimeout(oldTimer)
    const subscription = this.state.subscriptions.find((item) => item.id === id)
    if (!subscription?.enabled) return
    const backoff = Math.min(60_000, subscription.intervalMs * 2 ** subscription.consecutiveErrors)
    const timer = setTimeout(() => void this.check(id), delay ?? backoff)
    timer.unref()
    this.timers.set(id, timer)
  }

  private async check(id: string, manual = false): Promise<void> {
    const subscription = this.state.subscriptions.find((item) => item.id === id)
    if (!subscription || (!subscription.enabled && !manual) || this.running.has(id)) return
    this.running.add(id)
    subscription.status = 'checking'
    subscription.lastCheckedAt = Date.now()
    this.emitSnapshot()
    try {
      const items = await this.source.search(subscription)
      const prior = this.state.seenBySubscription[id]
      const seen = new Set(prior ?? [])
      this.state.seenBySubscription[id] = [...new Set([...items.map((item) => item.id), ...seen])].slice(0, MAX_SEEN_IDS)
      subscription.status = subscription.enabled ? 'watching' : 'paused'
      subscription.lastSuccessAt = Date.now()
      subscription.consecutiveErrors = 0
      subscription.error = undefined

      if (prior) {
        const newItems = await this.withAccessibleImages(items.filter((candidate) => !seen.has(candidate.id)))
        for (const item of newItems.reverse()) {
          item.discoveryType = 'new'
          this.state.recentItems = [item, ...this.state.recentItems.filter((old) => old.id !== item.id)]
            .slice(0, MAX_RECENT_ITEMS)
          this.emit('newItem', item)
        }
      } else {
        const baselineItems = (await this.withAccessibleImages(items
          .slice(0, clampInitialDisplayCount(subscription.initialDisplayCount))))
          .map((item) => ({ ...item, discoveryType: 'baseline' as const }))
        const baselineIds = new Set(baselineItems.map((item) => item.id))
        this.state.recentItems = [
          ...baselineItems,
          ...this.state.recentItems.filter((old) => !baselineIds.has(old.id))
        ].slice(0, MAX_RECENT_ITEMS)
      }
    } catch (error) {
      subscription.consecutiveErrors += 1
      subscription.status = subscription.consecutiveErrors >= 5 ? 'error' : 'backoff'
      subscription.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.running.delete(id)
      await this.persistAndEmit()
      this.schedule(id)
    }
  }

  private async withAccessibleImages(items: MercariItem[]): Promise<MercariItem[]> {
    const validator = this.source as ItemSource & Partial<ItemImageValidator>
    if (!validator.isImageAccessible) return items
    const outcomes = await Promise.all(items.map(async (item) => ({ item, accessible: await validator.isImageAccessible!(item) })))
    return outcomes.flatMap((outcome) => outcome.accessible ? [outcome.item] : [])
  }

  private requireSubscription(id: string): Subscription {
    const subscription = this.state.subscriptions.find((item) => item.id === id)
    if (!subscription) throw new Error('找不到该监控任务')
    return subscription
  }

  private async persistAndEmit(): Promise<void> {
    await this.store.save(this.state)
    this.emitSnapshot()
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.snapshot())
  }
}
