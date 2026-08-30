import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AppSnapshot, AppSettings, BulkSubscriptionPatch, FavoriteUpdate, LogLevel, MercariItem, NewSubscription, Subscription } from '../shared/types'
import { matchesExcludeKeyword } from './exclude-keywords'
import type { ItemDetailSource, ItemImageValidator, ItemSource } from './mercari-client'
import { isMercariShopsItem } from './mercari-item-url'
import { isSoldMercariStatus } from '../shared/mercari-status'
import type { ObservedListing, PersistedState, StateStore } from './store'

const MIN_INTERVAL_MS = 100
const ULTRA_FAST_INTERVAL_MS = 100
const FAST_INTERVAL_MS = 500
/** At most this many activity records are retained for one monitored keyword. */
const MAX_RECENT_ITEMS_PER_KEYWORD = 200
/** Display-only cap for the aggregate “全部” activity feed. */
const MAX_GLOBAL_RECENT_ITEMS = 300
const MAX_SEEN_IDS = 500
const STALLED_CHECK_GRACE_MS = 15_000
/** Allows for Mercari/index clock skew without treating old search results as new. */
const NEW_LISTING_CLOCK_SKEW_MS = 2 * 60_000
const BASELINE_RETRY_DELAY_MS = 5_000
const EMPTY_BASELINE_RETRY_DELAY_MS = 600
const MAX_EMPTY_BASELINE_ATTEMPTS = 3
const MAX_LOG_ENTRIES = 500
/** Wait long enough for Mercari's rate-limit window to clear before retrying. */
const ACCESS_BLOCK_COOLDOWN_MS = 15 * 60_000

function clampInitialDisplayCount(value?: number): number {
  return Math.min(5, Math.max(1, Math.trunc(value ?? 2)))
}

function clampSpeedQuota(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(20, Math.trunc(value))) : 0
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
  private readonly baselineRetryAt = new Map<string, number>()
  /** Existing tasks silently absorb search results from the time the app was offline. */
  private readonly startupResyncPending = new Set<string>()
  private readonly baselineEmptyAttempts = new Map<string, number>()
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
    const retained = this.retainRecentItems(this.state.recentItems)
    if (retained.length !== this.state.recentItems.length) {
      this.state.recentItems = retained
      await this.store.save(this.state)
    }
    this.startedAt = Date.now()
    this.startupResyncPending.clear()
    for (const subscription of this.state.subscriptions) {
      if (this.state.baselineReadyBySubscription[subscription.id]) this.startupResyncPending.add(subscription.id)
    }
    this.recordLog('info', `监控引擎已启动，已加载 ${this.state.subscriptions.length} 个关键词任务。`)
    await this.store.save(this.state)
    for (const subscription of this.state.subscriptions) this.schedule(subscription.id, 120)
    this.healthTimer = setInterval(() => this.recoverStalledSubscriptions(), 5_000)
    this.healthTimer.unref()
    this.favoriteTimer = setInterval(() => void this.checkFavorites(), 30_000)
    this.favoriteTimer.unref()
    this.emitSnapshot()
    void this.checkFavorites()
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
      globalRecentItems: structuredClone(this.state.recentItems.slice(0, MAX_GLOBAL_RECENT_ITEMS)),
      favorites: structuredClone(this.state.favorites),
      logs: structuredClone(this.state.logs),
      settings: structuredClone(this.state.settings),
      initialSyncingSubscriptionIds: this.state.subscriptions.filter((subscription) => !this.state.baselineReadyBySubscription[subscription.id]).map((subscription) => subscription.id),
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
    this.ensureSpeedSlot(intervalMs, undefined, true)
    const subscription: Subscription = {
      id: randomUUID(),
      keyword,
      excludeKeyword: input.excludeKeyword?.trim() ?? '',
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
      initialDisplayCount: clampInitialDisplayCount(input.initialDisplayCount),
      monitorUpdates: input.monitorUpdates ?? true,
      windowsNotificationsEnabled: true,
      enabled: true,
      intervalMs,
      createdAt: Date.now(),
      status: 'watching',
      consecutiveErrors: 0
    }
    this.state.subscriptions.unshift(subscription)
    this.recordLog('info', `已添加关键词监控：${keyword}（每 ${intervalMs} ms）。`)
    await this.persistAndEmit()
    this.schedule(subscription.id, 20)
    return this.snapshot()
  }

  async update(id: string, patch: Partial<Subscription>): Promise<AppSnapshot> {
    const subscription = this.requireSubscription(id)
    const intervalMs = Math.max(MIN_INTERVAL_MS, patch.intervalMs ?? subscription.intervalMs)
    this.ensureSpeedSlot(intervalMs, id, patch.enabled ?? subscription.enabled)
    Object.assign(subscription, patch, {
      id,
      intervalMs
    })
    if (patch.excludeKeyword !== undefined) {
      this.state.recentItems = this.state.recentItems.filter(
        (item) => item.subscriptionId !== id || !matchesExcludeKeyword(item.name, subscription.excludeKeyword)
      )
    }
    this.recordLog('info', `已更新关键词监控：${subscription.keyword}。`)
    await this.persistAndEmit()
    this.schedule(id, 20)
    return this.snapshot()
  }

  async reorder(ids: string[]): Promise<AppSnapshot> {
    const currentIds = this.state.subscriptions.map((subscription) => subscription.id)
    if (ids.length !== currentIds.length || new Set(ids).size !== ids.length || ids.some((id) => !currentIds.includes(id))) {
      throw new Error('监控任务排序数据无效，请刷新后重试。')
    }
    const byId = new Map(this.state.subscriptions.map((subscription) => [subscription.id, subscription]))
    this.state.subscriptions = ids.map((id) => byId.get(id)!)
    this.recordLog('info', '已调整监控任务排序。')
    await this.persistAndEmit()
    return this.snapshot()
  }

  async updateAll(patch: BulkSubscriptionPatch): Promise<AppSnapshot> {
    if (!this.state.subscriptions.length) return this.snapshot()
    const intervalMs = patch.intervalMs === undefined ? undefined : Math.max(MIN_INTERVAL_MS, patch.intervalMs)
    if (intervalMs !== undefined && intervalMs < 1_000) {
      throw new Error('统一查询时间只支持 1 秒或更慢；0.1/0.5 秒模式请在对应关键词中单独设置。')
    }
    for (const subscription of this.state.subscriptions) {
      if (intervalMs !== undefined) subscription.intervalMs = intervalMs
      if (patch.monitorUpdates !== undefined) subscription.monitorUpdates = patch.monitorUpdates
      if (patch.windowsNotificationsEnabled !== undefined) subscription.windowsNotificationsEnabled = patch.windowsNotificationsEnabled
    }
    const changes = [
      intervalMs === undefined ? '' : `查询间隔 ${intervalMs} ms`,
      patch.monitorUpdates === undefined ? '' : `旧商品更新${patch.monitorUpdates ? '开启' : '关闭'}`,
      patch.windowsNotificationsEnabled === undefined ? '' : `Windows 弹窗${patch.windowsNotificationsEnabled ? '开启' : '关闭'}`
    ].filter(Boolean).join('；')
    this.recordLog('info', `已批量更新 ${this.state.subscriptions.length} 个监控任务：${changes}。`)
    await this.persistAndEmit()
    if (intervalMs !== undefined) this.state.subscriptions.forEach((subscription, index) => this.schedule(subscription.id, 20 + index * 20))
    return this.snapshot()
  }

  async remove(id: string, removeRelatedItems = false): Promise<AppSnapshot> {
    const removed = this.requireSubscription(id)
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.id !== id)
    if (removeRelatedItems) {
      this.state.recentItems = this.state.recentItems.filter((item) => item.subscriptionId !== id)
    }
    delete this.state.seenBySubscription[id]
    delete this.state.baselineReadyBySubscription[id]
    delete this.state.observedUpdatesBySubscription[id]
    this.baselineRetryAt.delete(id)
    this.baselineEmptyAttempts.delete(id)
    this.startupResyncPending.delete(id)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.recordLog('info', `已取消关键词监控：${removed.keyword}${removeRelatedItems ? '，并清理关联商品动态。' : '。'}`)
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
      status: item.status, itemType: item.itemType, isAuction: item.isAuction, addedAt: Date.now(), lastCheckedAt: Date.now()
    })
    this.recordLog('info', `已收藏商品：${item.name}。`)
    await this.persistAndEmit()
    void this.checkFavorites()
    return this.snapshot()
  }

  async removeFavorite(itemId: string): Promise<AppSnapshot> {
    const favorite = this.state.favorites.find((item) => item.id === itemId)
    this.state.favorites = this.state.favorites.filter((favorite) => favorite.id !== itemId)
    if (favorite) this.recordLog('info', `已取消收藏：${favorite.name}。`)
    await this.persistAndEmit()
    return this.snapshot()
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSnapshot> {
    const maxUltraFastSubscriptions = patch.maxUltraFastSubscriptions === undefined
      ? this.state.settings.maxUltraFastSubscriptions
      : clampSpeedQuota(patch.maxUltraFastSubscriptions)
    const maxFastSubscriptions = patch.maxFastSubscriptions === undefined
      ? this.state.settings.maxFastSubscriptions
      : clampSpeedQuota(patch.maxFastSubscriptions)
    const runningUltraFast = this.state.subscriptions.filter((item) => item.enabled && item.intervalMs <= ULTRA_FAST_INTERVAL_MS).length
    const runningFast = this.state.subscriptions.filter((item) => item.enabled && item.intervalMs > ULTRA_FAST_INTERVAL_MS && item.intervalMs <= FAST_INTERVAL_MS).length
    if (runningUltraFast > maxUltraFastSubscriptions) throw new Error(`当前有 ${runningUltraFast} 个关键词使用 0.1 秒极速模式，请先调整任务后再降低配额。`)
    if (runningFast > maxFastSubscriptions) throw new Error(`当前有 ${runningFast} 个关键词使用 0.5 秒快速模式，请先调整任务后再降低配额。`)
    this.state.settings = { ...this.state.settings, ...patch, maxUltraFastSubscriptions, maxFastSubscriptions }
    await this.persistAndEmit()
    return this.snapshot()
  }

  async checkNow(id: string): Promise<void> {
    await this.check(id, true)
  }

  /** Appends a keyword's newest initial cards without replaying any notifications. */
  async resyncInitialResults(id: string): Promise<AppSnapshot> {
    const subscription = this.requireSubscription(id)
    this.state.baselineReadyBySubscription[id] = false
    this.baselineEmptyAttempts.delete(id)
    this.baselineRetryAt.delete(id)
    this.recordLog('info', `开始追加同步初始结果：${subscription.keyword}。`)
    await this.persistAndEmit()
    await this.check(id, true)
    return this.snapshot()
  }

  /** Refresh enabled tasks with small controlled concurrency to avoid a request burst. */
  async checkAllNow(): Promise<{ requested: number; skipped: number }> {
    const now = Date.now()
    const candidates = this.state.subscriptions.filter((subscription) => (
      subscription.enabled &&
      !this.running.has(subscription.id) &&
      (subscription.cooldownUntil ?? 0) <= now
    )).map((subscription) => subscription.id)
    const skipped = this.state.subscriptions.length - candidates.length
    if (!candidates.length) return { requested: 0, skipped }
    this.recordLog('info', `开始统一刷新 ${candidates.length} 个监控任务${skipped ? `，跳过 ${skipped} 个暂停、检查中或冷却中的任务` : ''}。`)
    await this.persistAndEmit()
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        const id = candidates[next]
        next += 1
        await this.check(id, true)
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, worker))
    return { requested: candidates.length, skipped }
  }

  private schedule(id: string, delay?: number): void {
    const oldTimer = this.timers.get(id)
    if (oldTimer) clearTimeout(oldTimer)
    const subscription = this.state.subscriptions.find((item) => item.id === id)
    if (!subscription?.enabled) return
    const backoff = Math.min(60_000, subscription.intervalMs * 2 ** subscription.consecutiveErrors)
    const coolingDelay = Math.max(0, (subscription.cooldownUntil ?? 0) - Date.now())
    const timer = setTimeout(() => void this.check(id), Math.max(delay ?? backoff, coolingDelay))
    timer.unref()
    this.timers.set(id, timer)
  }

  private async check(id: string, manual = false): Promise<void> {
    const subscription = this.state.subscriptions.find((item) => item.id === id)
    if (!subscription || (!subscription.enabled && !manual) || this.running.has(id)) return
    if (!manual && (subscription.cooldownUntil ?? 0) > Date.now()) {
      subscription.status = 'backoff'
      this.schedule(id)
      this.emitSnapshot()
      return
    }
    this.running.add(id)
    subscription.status = 'checking'
    subscription.lastCheckedAt = Date.now()
    this.emitSnapshot()
    try {
      const prior = this.state.seenBySubscription[id]
      // Preserve Mercari's returned “newest” ranking. Its `created` field can
      // reflect the original listing time rather than the web-search position.
      const items = (await this.source.search(subscription, { includeSold: !prior }))
        .filter((item) => !matchesExcludeKeyword(item.name, subscription.excludeKeyword))
      const seen = new Set(prior ?? [])
      subscription.status = subscription.enabled ? 'watching' : 'paused'
      subscription.lastSuccessAt = Date.now()
      subscription.consecutiveErrors = 0
      subscription.error = undefined
      subscription.cooldownUntil = undefined

      if (prior) {
        if (this.startupResyncPending.delete(id)) {
          // The app may have been closed while items appeared. Add listings
          // that were not in the previous seen baseline to the activity feed,
          // but deliberately do not emit `newItem`: no desktop or QQ replay
          // should occur just because the app restarted.
          const offlineItems = await this.withAccessibleImages(items.filter((item) => !seen.has(item.id)))
          const nextSeen = [...new Set([...items.map((item) => item.id), ...seen])].slice(0, MAX_SEEN_IDS)
          this.state.seenBySubscription[id] = nextSeen
          this.recordObservedUpdates(id, items, nextSeen)
          for (const item of offlineItems.reverse()) {
            item.discoveryType = 'offline'
            this.state.recentItems = this.retainRecentItems([
              item,
              ...this.state.recentItems.filter((old) => !(old.subscriptionId === item.subscriptionId && old.id === item.id))
            ])
          }
          this.recordLog('info', `启动同步完成：${subscription.keyword}，已补充 ${offlineItems.length} 条离线期间上新（不发送通知）。`)
          return
        }
        const wasWaitingForInitialBaseline = !this.state.baselineReadyBySubscription[id]
        await this.retryMissingBaseline(id, subscription, items, manual)
        if (wasWaitingForInitialBaseline) {
          // A delayed first result is still a baseline, never a new-item alert.
          const nextSeen = [...new Set([...items.map((item) => item.id), ...seen])].slice(0, MAX_SEEN_IDS)
          this.state.seenBySubscription[id] = nextSeen
          this.recordObservedUpdates(id, items, nextSeen)
          return
        }
        const unseenItems = items.filter((candidate) => !seen.has(candidate.id))
        const previousUpdates = this.state.observedUpdatesBySubscription[id] ?? {}
        const editedItems = subscription.monitorUpdates
          ? items.filter((candidate) => seen.has(candidate.id) && candidate.updatedAt != null && previousUpdates[candidate.id] != null && candidate.updatedAt > previousUpdates[candidate.id].updatedAt)
          : []
        // A newly-created subscription can receive an incomplete first search
        // page, then older indexed listings on the next poll. Those listings
        // must be remembered, but can never be surfaced as a new arrival.
        const staleItems = unseenItems.filter((candidate) => !this.wasListedAfterMonitoringStarted(candidate, subscription))
        const staleIds = new Set(staleItems.map((candidate) => candidate.id))
        // A listing can be old but freshly edited, then re-enter Mercari's
        // newest search results. It was not part of our baseline, so there is
        // no former snapshot to diff; still surface it as an old-item update
        // instead of silently discarding it as an ordinary delayed old result.
        const firstObservedOldUpdates = subscription.monitorUpdates
          ? staleItems.filter((candidate) => this.wasUpdatedAfterMonitoringStarted(candidate, subscription))
          : []
        const oldUpdateIds = new Set(firstObservedOldUpdates.map((candidate) => candidate.id))
        const ordinaryStaleIds = new Set(staleItems
          .filter((candidate) => !oldUpdateIds.has(candidate.id))
          .map((candidate) => candidate.id))
        const newItems = await this.withAccessibleImages(unseenItems.filter((candidate) => !staleIds.has(candidate.id)))
        const visibleFirstObservedOldUpdates = await this.withAccessibleImages(firstObservedOldUpdates)
        // Do not mark a new item as seen until its image has passed validation.
        // A temporary CDN timeout must let the next poll retry the item instead
        // of silently discarding it forever.
        const acceptedIds = new Set([...newItems, ...visibleFirstObservedOldUpdates].map((item) => item.id))
        const nextSeen = [...new Set([
          ...items.filter((item) => seen.has(item.id) || acceptedIds.has(item.id) || ordinaryStaleIds.has(item.id)).map((item) => item.id),
          ...seen
        ])].slice(0, MAX_SEEN_IDS)
        this.state.seenBySubscription[id] = nextSeen
        for (const item of newItems.reverse()) {
          item.discoveryType = 'new'
          this.state.recentItems = this.retainRecentItems([
            item,
            ...this.state.recentItems.filter((old) => !(old.subscriptionId === item.subscriptionId && old.id === item.id))
          ])
          this.recordLog('info', `发现上新：${subscription.keyword} · ${item.name}`)
          this.emit('newItem', item)
        }
        for (const item of visibleFirstObservedOldUpdates.reverse()) {
          item.discoveryType = 'updated'
          item.updateSummary = '旧商品在监控开始后被编辑，首次进入搜索结果'
          this.state.recentItems = this.retainRecentItems([
            item,
            ...this.state.recentItems.filter((old) => !(old.subscriptionId === item.subscriptionId && old.id === item.id))
          ])
          this.recordLog('info', `发现旧商品更新：${subscription.keyword} · ${item.name}（${item.updateSummary}）`)
          this.emit('newItem', item)
        }
        const visibleEdits = await this.withAccessibleImages(editedItems)
        for (const item of visibleEdits.reverse()) {
          item.discoveryType = 'updated'
          item.updateSummary = this.describeListingUpdate(previousUpdates[item.id], item)
          this.state.recentItems = this.retainRecentItems([
            item,
            ...this.state.recentItems.filter((old) => !(old.subscriptionId === item.subscriptionId && old.id === item.id))
          ])
          this.recordLog('info', `旧商品更新：${subscription.keyword} · ${item.name}（${item.updateSummary}）`)
          // Updates intentionally use the same event as a new listing: this
          // keeps desktop and QQ delivery rules consistent with ordinary alerts.
          this.emit('newItem', item)
        }
        this.recordObservedUpdates(id, [...items, ...newItems, ...visibleEdits], nextSeen)
      } else {
        this.startupResyncPending.delete(id)
        // Baseline entries intentionally count as seen even if a thumbnail is
        // unavailable, so pre-existing listings never become false "new" alerts.
        const nextSeen = [...new Set([...items.map((item) => item.id), ...seen])].slice(0, MAX_SEEN_IDS)
        this.state.seenBySubscription[id] = nextSeen
        this.recordObservedUpdates(id, items, nextSeen)
        await this.retryMissingBaseline(id, subscription, items, true)
      }
    } catch (error) {
      subscription.consecutiveErrors += 1
      subscription.status = subscription.consecutiveErrors >= 5 ? 'error' : 'backoff'
      const message = error instanceof Error ? error.message : String(error)
      if (isMercariAccessBlocked(message)) {
        subscription.status = 'backoff'
        subscription.cooldownUntil = Date.now() + ACCESS_BLOCK_COOLDOWN_MS
        subscription.error = `Mercari 暂时限制访问，已停止此关键词请求至 ${new Date(subscription.cooldownUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      } else {
        subscription.error = message
      }
      this.recordLog(subscription.consecutiveErrors >= 5 ? 'error' : 'warn', `监控检查失败：${subscription.keyword} · ${subscription.error}`)
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
        // A sold listing is terminal. Keeping its final state is useful to the
        // user, but polling it forever wastes requests and can add needless load.
        if (isSoldMercariStatus(favorite.status)) continue
        const original: MercariItem = { ...favorite, detectedAt: Date.now(), subscriptionId: 'favorite', keyword: '收藏' }
        try {
          const latest = await details.getItem(original)
          favorite.lastCheckedAt = Date.now()
          if (!latest) continue
          const priceChanged = latest.price !== favorite.price
          const previousPrice = favorite.price
          const sold = latest.status !== favorite.status && isSoldMercariStatus(latest.status)
          favorite.name = latest.name
          favorite.price = latest.price
          favorite.thumbnail = latest.thumbnail
          favorite.status = latest.status
          favorite.isAuction = latest.isAuction
          favorite.error = undefined
          if (priceChanged || sold) {
          if (priceChanged) favorite.previousPrice = previousPrice
          favorite.lastChangedAt = Date.now()
            this.recordLog('info', `收藏商品状态变化：${favorite.name}${sold ? ' · 已售出' : ''}${priceChanged ? ` · 价格 ¥${previousPrice.toLocaleString('ja-JP')} → ¥${favorite.price.toLocaleString('ja-JP')}` : ''}`)
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

  /** Keeps newest records first and caps each keyword independently. */
  private retainRecentItems(items: MercariItem[]): MercariItem[] {
    const perKeyword = new Map<string, number>()
    const retained = items.filter((item) => {
      const count = perKeyword.get(item.subscriptionId) ?? 0
      if (count >= MAX_RECENT_ITEMS_PER_KEYWORD) return false
      perKeyword.set(item.subscriptionId, count + 1)
      return true
    })
    return retained
  }

  private async withAccessibleImages(items: MercariItem[]): Promise<MercariItem[]> {
    const validator = this.source as ItemSource & Partial<ItemImageValidator>
    const details = this.source as ItemSource & Partial<ItemDetailSource>
    const outcomes = await Promise.all(items.map(async (item) => {
      let enriched = item
      if (details.getItem && !isMercariShopsItem(item)) {
        try { enriched = (await details.getItem(item)) ?? item } catch { /* Keep the listing when detail lookup is temporarily unavailable. */ }
      }
      return { item: enriched, accessible: validator.isImageAccessible ? await validator.isImageAccessible(enriched) : true }
    }))
    return outcomes.flatMap((outcome) => outcome.accessible ? [outcome.item] : [])
  }

  private recordLog(level: LogLevel, message: string): void {
    this.state.logs.unshift({ id: randomUUID(), timestamp: Date.now(), level, message })
    if (this.state.logs.length > MAX_LOG_ENTRIES) this.state.logs.length = MAX_LOG_ENTRIES
  }

  private wasListedAfterMonitoringStarted(item: MercariItem, subscription: Subscription): boolean {
    if (!item.createdAt) return true
    const createdAt = item.createdAt > 10_000_000_000 ? item.createdAt : item.createdAt * 1_000
    return createdAt >= subscription.createdAt - NEW_LISTING_CLOCK_SKEW_MS
  }

  /** Records a service diagnostic outside the polling loop and publishes it immediately. */
  async recordDiagnostic(level: LogLevel, message: string): Promise<void> {
    this.recordLog(level, message)
    await this.persistAndEmit()
  }

  private wasUpdatedAfterMonitoringStarted(item: MercariItem, subscription: Subscription): boolean {
    if (!item.updatedAt) return false
    const updatedAt = item.updatedAt > 10_000_000_000 ? item.updatedAt : item.updatedAt * 1_000
    return updatedAt >= subscription.createdAt - NEW_LISTING_CLOCK_SKEW_MS
  }

  private selectBaselineItems(items: MercariItem[], count: number): MercariItem[] {
    return items.filter((item) => !isSoldMercariStatus(item.status)).slice(0, count)
  }

  private async retryMissingBaseline(id: string, subscription: Subscription, items: MercariItem[], manual: boolean): Promise<void> {
    if (this.state.baselineReadyBySubscription[id]) return
    const nextRetry = this.baselineRetryAt.get(id) ?? 0
    if (!manual && Date.now() < nextRetry) return
    const candidates = this.selectBaselineItems(items, clampInitialDisplayCount(subscription.initialDisplayCount))
    if (!candidates.length) {
      const attempts = (this.baselineEmptyAttempts.get(id) ?? 0) + 1
      this.baselineEmptyAttempts.set(id, attempts)
      if (attempts >= MAX_EMPTY_BASELINE_ATTEMPTS) {
        this.state.baselineReadyBySubscription[id] = true
        this.baselineEmptyAttempts.delete(id)
        this.baselineRetryAt.delete(id)
        this.recordLog('info', `初始同步结束：${subscription.keyword} 连续 ${attempts} 次未返回商品。`)
      } else {
        this.baselineRetryAt.set(id, Date.now() + EMPTY_BASELINE_RETRY_DELAY_MS)
        this.recordLog('info', `初始同步等待重试：${subscription.keyword} 本次未返回商品（${attempts}/${MAX_EMPTY_BASELINE_ATTEMPTS}）。`)
      }
      return
    }
    const baselineItems = (await this.withAccessibleImages(candidates))
      .filter((item) => !isSoldMercariStatus(item.status))
      .map((item) => ({ ...item, discoveryType: 'baseline' as const }))
    if (!baselineItems.length) {
      this.baselineRetryAt.set(id, Date.now() + BASELINE_RETRY_DELAY_MS)
      this.recordLog('info', `初始同步等待重试：${subscription.keyword} 的商品图片暂不可用。`)
      return
    }
    const existingIds = new Set(this.state.recentItems.filter((item) => item.subscriptionId === subscription.id).map((item) => item.id))
    const appendedItems = baselineItems.filter((item) => !existingIds.has(item.id))
    this.state.recentItems = this.retainRecentItems([
      ...appendedItems,
      ...this.state.recentItems
    ])
    this.state.baselineReadyBySubscription[id] = true
    this.baselineEmptyAttempts.delete(id)
    this.baselineRetryAt.delete(id)
    this.recordLog('info', `已建立首次基线：${subscription.keyword}，搜索返回 ${items.length} 条，新增 ${appendedItems.length} 条初始商品。`)
  }

  private recordObservedUpdates(subscriptionId: string, items: MercariItem[], seenIds: string[]): void {
    const previous = this.state.observedUpdatesBySubscription[subscriptionId] ?? {}
    const returned = new Map(items.map((item) => [item.id, this.toObservedListing(item)]))
    this.state.observedUpdatesBySubscription[subscriptionId] = Object.fromEntries(seenIds.flatMap((id) => {
      const observed = returned.get(id) ?? previous[id]
      return observed == null ? [] : [[id, observed]]
    }))
  }

  private toObservedListing(item: MercariItem): ObservedListing | undefined {
    if (item.updatedAt == null) return undefined
    return {
      updatedAt: item.updatedAt,
      name: item.name,
      price: Number.isFinite(item.price) ? item.price : null,
      status: item.status,
      thumbnail: item.thumbnail
    }
  }

  private describeListingUpdate(previous: ObservedListing | undefined, item: MercariItem): string {
    if (!previous) return '卖家编辑了商品信息'
    const changes: string[] = []
    if (previous.price != null && previous.price !== item.price) {
      changes.push(`价格 ¥${previous.price.toLocaleString('ja-JP')} → ¥${item.price.toLocaleString('ja-JP')}`)
    }
    if (previous.name && previous.name !== item.name) changes.push('商品标题已修改')
    if (previous.status && previous.status !== item.status) {
      changes.push(isSoldMercariStatus(item.status) ? '商品状态变为已售' : '商品在售状态已变更')
    }
    if (previous.thumbnail && previous.thumbnail !== item.thumbnail) changes.push('商品主图已更新')
    return changes.length ? changes.join('；') : '卖家编辑了商品信息'
  }

  private requireSubscription(id: string): Subscription {
    const subscription = this.state.subscriptions.find((item) => item.id === id)
    if (!subscription) throw new Error('找不到该监控任务')
    return subscription
  }

  private ensureSpeedSlot(intervalMs: number, currentId: string | undefined, enabled: boolean): void {
    if (!enabled || intervalMs > FAST_INTERVAL_MS) return
    const ultraFast = intervalMs <= ULTRA_FAST_INTERVAL_MS
    const used = this.state.subscriptions.filter((subscription) => subscription.id !== currentId && subscription.enabled && (
      ultraFast
        ? subscription.intervalMs <= ULTRA_FAST_INTERVAL_MS
        : subscription.intervalMs > ULTRA_FAST_INTERVAL_MS && subscription.intervalMs <= FAST_INTERVAL_MS
    )).length
    const limit = ultraFast ? this.state.settings.maxUltraFastSubscriptions : this.state.settings.maxFastSubscriptions
    if (used >= limit) {
      throw new Error(`${ultraFast ? '0.1 秒极速模式' : '0.5 秒快速模式'}配额已满（${limit} 个），请在“个性化设置”中提高配额或调整其他任务。`)
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

function isMercariAccessBlocked(message: string): boolean {
  return /(?:Mercari(?:\s+\w+)*\s+API\s+(?:403|429)\b|\b(?:403|429)\b|forbidden|access denied|too many requests|rate limit|captcha|访问(?:被)?(?:限制|拒绝))/i.test(message)
}
