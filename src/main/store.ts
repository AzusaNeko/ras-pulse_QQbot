import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings, FavoriteItem, LogEntry, MercariItem, QQBotKeyword, Subscription } from '../shared/types'
import { buildMercariItemUrl, isMercariShopsItem, MERCARI_SHOPS_ITEM_TYPE } from './mercari-item-url'

export interface PersistedState {
  subscriptions: Subscription[]
  recentItems: MercariItem[]
  favorites: FavoriteItem[]
  logs: LogEntry[]
  settings: AppSettings
  seenBySubscription: Record<string, string[]>
  /** Whether this subscription has successfully rendered its first baseline. */
  baselineReadyBySubscription: Record<string, boolean>
  observedUpdatesBySubscription: Record<string, Record<string, ObservedListing>>
}

/** Small snapshot used to explain a later edit without retaining full listing data. */
export interface ObservedListing {
  updatedAt: number
  name: string
  price: number | null
  status: string
  thumbnail: string
}

export interface StateStore {
  load(): Promise<PersistedState>
  save(state: PersistedState): Promise<void>
}

export const defaultState: PersistedState = {
  subscriptions: [],
  recentItems: [],
  favorites: [],
  logs: [],
  settings: {
    notificationsEnabled: true,
    soundEnabled: true,
    notificationIncludeImage: false,
    notificationIncludeName: true,
    notificationIncludePrice: true,
    launchMinimized: false,
    defaultIntervalMs: 1_000,
    qqBotEnabled: false,
    qqBotAppId: '',
    qqBotTargets: [],
    qqCommandPanelIds: {},
    qqCommandPanelAppId: ''
  },
  seenBySubscription: {},
  baselineReadyBySubscription: {},
  observedUpdatesBySubscription: {}
}

function normalizeQQKeywords(value: unknown): QQBotKeyword[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() ? [{ keyword: entry.trim(), excludeKeywords: [] }] : []
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as Partial<QQBotKeyword>
    if (typeof candidate.keyword !== 'string' || !candidate.keyword.trim()) return []
    return [{
      keyword: candidate.keyword.trim(),
      excludeKeywords: Array.isArray(candidate.excludeKeywords)
        ? candidate.excludeKeywords.filter((term): term is string => typeof term === 'string' && Boolean(term.trim())).map((term) => term.trim())
        : []
    }]
  })
}

function normalizeStoredItem<T extends MercariItem | FavoriteItem>(item: T): T {
  const itemType = item.itemType ?? (isMercariShopsItem(item) ? MERCARI_SHOPS_ITEM_TYPE : undefined)
  return {
    ...item,
    itemType,
    url: buildMercariItemUrl({ ...item, itemType })
  }
}

function normalizeObservedUpdates(value: unknown): PersistedState['observedUpdatesBySubscription'] {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value).flatMap(([subscriptionId, entries]) => {
    if (!entries || typeof entries !== 'object') return []
    const normalized = Object.fromEntries(Object.entries(entries).flatMap(([itemId, entry]) => {
      // v0.4.22 stored just the timestamp. Keep it so future edits are still
      // detected, while gracefully falling back to a generic edit message.
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        return [[itemId, { updatedAt: entry, name: '', price: null, status: '', thumbnail: '' }]]
      }
      if (!entry || typeof entry !== 'object') return []
      const candidate = entry as Partial<ObservedListing>
      if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return []
      return [[itemId, {
        updatedAt: candidate.updatedAt,
        name: typeof candidate.name === 'string' ? candidate.name : '',
        price: typeof candidate.price === 'number' && Number.isFinite(candidate.price) ? candidate.price : null,
        status: typeof candidate.status === 'string' ? candidate.status : '',
        thumbnail: typeof candidate.thumbnail === 'string' ? candidate.thumbnail : ''
      }]]
    }))
    return [[subscriptionId, normalized]]
  }))
}

function normalizeLogs(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as Partial<LogEntry>
    if (typeof candidate.id !== 'string' || typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)
      || typeof candidate.message !== 'string' || !['info', 'warn', 'error'].includes(candidate.level ?? '')) return []
    return [{ id: candidate.id, timestamp: candidate.timestamp, message: candidate.message, level: candidate.level as LogEntry['level'] }]
  }).slice(0, 500)
}

export class JsonStore implements StateStore {
  /**
   * Multiple keyword checks may finish at the same moment. Serialize disk
   * writes so they never race on `state.json.tmp` and interrupt scheduling.
   */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedState>
      return {
        ...defaultState,
        ...parsed,
        settings: {
          ...defaultState.settings,
          ...parsed.settings,
          qqBotTargets: (parsed.settings?.qqBotTargets ?? []).map((target) => ({ ...target, keywords: normalizeQQKeywords(target.keywords) })),
          qqCommandPanelIds: parsed.settings?.qqCommandPanelIds ?? {},
          qqCommandPanelAppId: parsed.settings?.qqCommandPanelAppId ?? ''
        },
        subscriptions: (parsed.subscriptions ?? []).map((subscription) => ({ ...subscription, monitorUpdates: typeof subscription.monitorUpdates === 'boolean' ? subscription.monitorUpdates : true })),
        recentItems: (parsed.recentItems ?? []).map((item) => ({ ...normalizeStoredItem(item), isAuction: typeof item.isAuction === 'boolean' ? item.isAuction : undefined })),
        favorites: (parsed.favorites ?? []).map((item) => ({ ...normalizeStoredItem(item), isAuction: typeof item.isAuction === 'boolean' ? item.isAuction : undefined })),
        logs: normalizeLogs(parsed.logs),
        seenBySubscription: parsed.seenBySubscription ?? {},
        baselineReadyBySubscription: parsed.baselineReadyBySubscription ?? {},
        observedUpdatesBySubscription: normalizeObservedUpdates(parsed.observedUpdatesBySubscription)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to read state', error)
      return structuredClone(defaultState)
    }
  }

  async save(state: PersistedState): Promise<void> {
    // Serialize before queueing: callers continue mutating the in-memory state
    // while an earlier disk write is running, so each queued write needs its
    // own immutable representation.
    const contents = JSON.stringify(state, null, 2)
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp`
      await writeFile(temporary, contents, 'utf8')
      await rename(temporary, this.filePath)
    })
    // Keep subsequent writes alive even if one filesystem operation fails.
    this.writeQueue = write.catch(() => undefined)
    await write
  }
}
