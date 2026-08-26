export type MonitorStatus = 'watching' | 'paused' | 'checking' | 'backoff' | 'error'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  timestamp: number
  level: LogLevel
  message: string
}

export interface Subscription {
  id: string
  keyword: string
  excludeKeyword: string
  minPrice?: number
  maxPrice?: number
  initialDisplayCount: number
  /** Emit an activity record when an already-seen listing is edited. */
  monitorUpdates: boolean
  enabled: boolean
  intervalMs: number
  createdAt: number
  lastCheckedAt?: number
  lastSuccessAt?: number
  status: MonitorStatus
  error?: string
  consecutiveErrors: number
}

export interface MercariItem {
  id: string
  name: string
  price: number
  thumbnail: string
  url: string
  status: string
  itemType?: string
  /** Undefined means the item detail could not be loaded yet. */
  isAuction?: boolean
  createdAt?: number
  updatedAt?: number
  /** Human-readable summary when this is an edit to a previously seen listing. */
  updateSummary?: string
  detectedAt: number
  subscriptionId: string
  keyword: string
  discoveryType?: 'baseline' | 'new' | 'updated'
}

export interface FavoriteItem {
  id: string
  name: string
  price: number
  thumbnail: string
  url: string
  status: string
  itemType?: string
  isAuction?: boolean
  addedAt: number
  lastCheckedAt?: number
  lastChangedAt?: number
  /** Price before the most recently observed price change. */
  previousPrice?: number
  error?: string
}

export interface FavoriteUpdate {
  favorite: FavoriteItem
  priceChanged: boolean
  sold: boolean
}

export interface AppSettings {
  notificationsEnabled: boolean
  soundEnabled: boolean
  notificationIncludeImage: boolean
  notificationIncludeName: boolean
  notificationIncludePrice: boolean
  launchMinimized: boolean
  defaultIntervalMs: number
  qqBotEnabled: boolean
  qqBotAppId: string
  qqBotTargets: QQBotTarget[]
}

export type QQBotTargetType = 'group' | 'c2c'

export interface QQBotKeyword {
  /** The monitored search term. */
  keyword: string
  /** Product names containing any of these terms are not delivered to this target. */
  excludeKeywords: string[]
}

export interface QQBotTarget {
  id: string
  type: QQBotTargetType
  targetId: string
  label: string
  enabled: boolean
  /** Keyword subscriptions belonging to this QQ private chat or group. */
  keywords: QQBotKeyword[]
}

export interface QQBotConfig {
  enabled: boolean
  appId: string
  targets: QQBotTarget[]
  secretConfigured: boolean
}

export interface QQCommandPanelSyncResult {
  created: number
  updated: number
  menuUpdated: boolean
}

export interface SaveQQBotConfigInput {
  enabled: boolean
  appId: string
  targets: QQBotTarget[]
  /** Empty keeps the existing local secret. It is never returned to the renderer. */
  appSecret?: string
}

export interface AppSnapshot {
  subscriptions: Subscription[]
  recentItems: MercariItem[]
  favorites: FavoriteItem[]
  logs: LogEntry[]
  settings: AppSettings
  startedAt: number
}

export interface NewSubscription {
  keyword: string
  excludeKeyword?: string
  minPrice?: number
  maxPrice?: number
  intervalMs?: number
  initialDisplayCount?: number
  monitorUpdates?: boolean
}

export interface MonitorEvent {
  type: 'snapshot' | 'new-item' | 'favorite-update'
  snapshot?: AppSnapshot
  item?: MercariItem
  favoriteUpdate?: FavoriteUpdate
}

export interface MercariPulseApi {
  getSnapshot(): Promise<AppSnapshot>
  addSubscription(input: NewSubscription): Promise<AppSnapshot>
  updateSubscription(id: string, patch: Partial<Subscription>): Promise<AppSnapshot>
  removeSubscription(id: string, removeRelatedItems: boolean): Promise<AppSnapshot>
  dismissRecentItem(subscriptionId: string, itemId: string): Promise<AppSnapshot>
  addFavorite(item: MercariItem): Promise<AppSnapshot>
  removeFavorite(itemId: string): Promise<AppSnapshot>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSnapshot>
  checkNow(id: string): Promise<void>
  testNotification(): Promise<{ supported: boolean }>
  getQQBotConfig(): Promise<QQBotConfig>
  saveQQBotConfig(input: SaveQQBotConfigInput): Promise<QQBotConfig>
  testQQBot(): Promise<{ delivered: number; failed: number }>
  syncQQCommandPanels(): Promise<QQCommandPanelSyncResult>
  openExternal(url: string): Promise<void>
  onMonitorEvent(listener: (event: MonitorEvent) => void): () => void
}
