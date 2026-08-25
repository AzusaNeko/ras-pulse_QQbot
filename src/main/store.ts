import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings, FavoriteItem, MercariItem, QQBotKeyword, Subscription } from '../shared/types'
import { buildMercariItemUrl, isMercariShopsItem, MERCARI_SHOPS_ITEM_TYPE } from './mercari-item-url'

export interface PersistedState {
  subscriptions: Subscription[]
  recentItems: MercariItem[]
  favorites: FavoriteItem[]
  settings: AppSettings
  seenBySubscription: Record<string, string[]>
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
    qqBotTargets: []
  },
  seenBySubscription: {},
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

export class JsonStore implements StateStore {
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
          qqBotTargets: (parsed.settings?.qqBotTargets ?? []).map((target) => ({ ...target, keywords: normalizeQQKeywords(target.keywords) }))
        },
        subscriptions: (parsed.subscriptions ?? []).map((subscription) => ({ ...subscription, monitorUpdates: Boolean(subscription.monitorUpdates) })),
        recentItems: (parsed.recentItems ?? []).map((item) => ({ ...normalizeStoredItem(item), isAuction: typeof item.isAuction === 'boolean' ? item.isAuction : undefined })),
        favorites: (parsed.favorites ?? []).map((item) => ({ ...normalizeStoredItem(item), isAuction: typeof item.isAuction === 'boolean' ? item.isAuction : undefined })),
        seenBySubscription: parsed.seenBySubscription ?? {},
        observedUpdatesBySubscription: normalizeObservedUpdates(parsed.observedUpdatesBySubscription)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to read state', error)
      return structuredClone(defaultState)
    }
  }

  async save(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
    await rename(temporary, this.filePath)
  }
}
