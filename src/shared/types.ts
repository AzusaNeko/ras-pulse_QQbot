export type MonitorStatus = 'watching' | 'paused' | 'checking' | 'backoff' | 'error'

export interface Subscription {
  id: string
  keyword: string
  excludeKeyword: string
  minPrice?: number
  maxPrice?: number
  initialDisplayCount: number
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
  createdAt?: number
  detectedAt: number
  subscriptionId: string
  keyword: string
  discoveryType?: 'baseline' | 'new'
}

export interface AppSettings {
  notificationsEnabled: boolean
  soundEnabled: boolean
  notificationIncludeImage: boolean
  notificationIncludeName: boolean
  notificationIncludePrice: boolean
  launchMinimized: boolean
  defaultIntervalMs: number
}

export interface AppSnapshot {
  subscriptions: Subscription[]
  recentItems: MercariItem[]
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
}

export interface MonitorEvent {
  type: 'snapshot' | 'new-item'
  snapshot?: AppSnapshot
  item?: MercariItem
}

export interface MercariPulseApi {
  getSnapshot(): Promise<AppSnapshot>
  addSubscription(input: NewSubscription): Promise<AppSnapshot>
  updateSubscription(id: string, patch: Partial<Subscription>): Promise<AppSnapshot>
  removeSubscription(id: string, removeRelatedItems: boolean): Promise<AppSnapshot>
  dismissRecentItem(subscriptionId: string, itemId: string): Promise<AppSnapshot>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSnapshot>
  checkNow(id: string): Promise<void>
  testNotification(): Promise<{ supported: boolean }>
  openExternal(url: string): Promise<void>
  onMonitorEvent(listener: (event: MonitorEvent) => void): () => void
}
