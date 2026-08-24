import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AppSnapshot, AppSettings, FavoriteUpdate, MercariItem, NewSubscription, Subscription } from '../shared/types'
import type { ItemDetailSource, ItemImageValidator, ItemSource } from './mercari-client'
import type { PersistedState, StateStore } from './store'

const MIN_INTERVAL_MS = 500
const FAST_INTERVAL_MS = 500
const MAX_RECENT_ITEMS = 200
const MAX_SEEN_IDS = 500
const STALLED_CHECK_GRACE_MS = 15_000

function clampInitialDisplayCount(value?: number): number {
  return Math.min(5, Math.max(1, Math.trunc(value ?? 2)))
}

export interface EngineEvents {
  snapshot: [AppSnapshot]
  newItem: [MercariItem]
  favoriteUpdate: [FavoriteUpdate]
}

export class MonitorEngine extends EventEmitter<EngineEvents> {
  private state!: PersistedState
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Set<string>()
  private healthTimer: NodeJS.Timeout | undefined
  private favoriteTimer: NodeJS.Timeout | undefined
  private favoritesRunning = false
  private startedAt = Date.now()

  constructor(
    private readonly source: ItemSource,
    private readonly store: StateStore
  ) { super() }

  async start(): Promise<void> {
    this.state = await this.store.load()
    this.startedAt = Date.now()
    for (const subscription of this.state.subscriptions) this.schedule(subscription.id, 120)
    this.healthTimer = setInterval(() => this.recoverStalledSubscriptions(), 5_000)
    this.healthTimer.unref()
    this.favoriteTimer = setInterval(() => void this.checkFavorites(), 30_000)
    this.favoriteTimer.unref()
    this.emitSnapshot()
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = undefined
    if (this.favoriteTimer) clearInterval(this.favoriteTimer)
    this.favoriteTimer = undefined
  }

  snapshot(): AppSnapshot {
    return {
      subscriptions: structuredClone(this.state.subscriptions),
      recentItems: structuredClone(this.state.recentItems),
      favorites: structuredClone(this.state.favorites),
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
    const intervalMs = Math.max(MIN_INTERVAL_MS, input.intervalMs ?? this.state.settings.defaultIntervalMs)
    this.ensureFastSlot(intervalMs)
    const subscription: Subscription = {
      id: randomUUID(),
      keyword,
      excludeKeyword: input.excludeKeyword?.trim() ?? '',
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
      initialDisplayCount: clampInitialDisplayCount(input.initialDisplayCount),
      enabled: true,
      intervalMs,
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
    const intervalMs = Math.max(MIN_INTERVAL_MS, patch.intervalMs ?? subscription.intervalMs)
    this.ensureFastSlot(intervalMs, id)
    Object.assign(subscription, patch, {
      id,
      intervalMs
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

  async addFavorite(item: MercariItem): Promise<AppSnapshot> {
    if (this.state.favorites.some((favorite) => favorite.id === item.id)) return this.snapshot()
    this.state.favorites.unshift({
      id: item.id, name: item.name, price: item.price, thumbnail: item.thumbnail, url: item.url,
      status: item.status, addedAt: Date.now(), lastCheckedAt: Date.now()
    })
    await this.persistAndEmit()
    void this.checkFavorites()
    return this.snapshot()
  }

  async removeFavorite(itemId: string): Promise<AppSnapshot> {
    this.state.favorites = this.state.favorites.filter((favorite) => favorite.id !== itemId)
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

  /** Restarts only tasks that look healthy but have silently lost their timer. */
  private recoverStalledSubscriptions(): void {
    const now = Date.now()
    for (const subscription of this.state.subscriptions) {
      if (!subscription.enabled || subscription.status !== 'watching' || this.running.has(subscription.id)) continue
      const grace = Math.max(STALLED_CHECK_GRACE_MS, subscription.intervalMs * 3)
      if (subscription.lastCheckedAt && now - subscription.lastCheckedAt > grace) {
        console.warn(`监控任务长时间未检查，正在恢复定时器：${subscription.keyword}`)
        this.schedule(subscription.id, 0)
      }
    }
  }

  private async checkFavorites(): Promise<void> {
    const details = this.source as ItemSource & Partial<ItemDetailSource>
    if (!details.getItem || this.favoritesRunning || !this.state.favorites.length) return
    this.favoritesRunning = true
    try {
      for (const favorite of this.state.favorites) {
        const original: MercariItem = { ...favorite, detectedAt: Date.now(), subscriptionId: 'favorite', keyword: '收藏' }
        try {
          const latest = await details.getItem(original)
          favorite.lastCheckedAt = Date.now()
          if (!latest) continue
          const priceChanged = latest.price !== favorite.price
          const sold = latest.status !== favorite.status && /SOLD|SOLD_OUT/i.test(latest.status)
          favorite.name = latest.name
          favorite.price = latest.price
          favorite.thumbnail = latest.thumbnail
          favorite.status = latest.status
          favorite.error = undefined
          if (priceChanged || sold) {
            favorite.lastChangedAt = Date.now()
            this.emit('favoriteUpdate', { favorite: structuredClone(favorite), priceChanged, sold })
          }
        } catch (error) {
          favorite.lastCheckedAt = Date.now()
          favorite.error = error instanceof Error ? error.message : String(error)
        }
      }
      await this.persistAndEmit()
    } finally { this.favoritesRunning = false }
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

  private ensureFastSlot(intervalMs: number, currentId?: string): void {
    if (intervalMs > FAST_INTERVAL_MS) return
    if (this.state.subscriptions.some((subscription) => subscription.id !== currentId && subscription.intervalMs <= FAST_INTERVAL_MS)) {
      throw new Error('极速模式只允许一个关键词使用。请先将其他关键词切换到 1 秒或更慢。')
    }
  }

  private async persistAndEmit(): Promise<void> {
    await this.store.save(this.state)
    this.emitSnapshot()
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.snapshot())
  }
}
