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
    subscriptionVisibleCount: 5,
    theme: 'emerald',
    qqBotEnabled: false,
    qqBotAppId: '',
    qqBotTargets: [],
    qqCommandPanelIds: {},
    qqCommandPanelAppId: '',
    qqBots: []
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

function normalizeQQBots(settings: Partial<AppSettings> | undefined): AppSettings['qqBots'] {
  const storedBots = settings?.qqBots
  if (Array.isArray(storedBots)) {
    return storedBots.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const bot = entry as Partial<AppSettings['qqBots'][number]>
      if (typeof bot.id !== 'string' || !bot.id.trim()) return []
      const botId = bot.id
      return [{
        id: botId,
        enabled: Boolean(bot.enabled),
        appId: typeof bot.appId === 'string' ? bot.appId.trim() : '',
        targets: Array.isArray(bot.targets) ? bot.targets.map((target) => ({
          ...target,
          botId,
          label: /^自动发现的 QQ (?:群|私聊)$/.test(target.label ?? '') ? '' : target.label ?? '',
          keywords: normalizeQQKeywords(target.keywords)
        })) : [],
        commandPanelIds: bot.commandPanelIds ?? {}
      }]
    })
  }
  // Migrate the v0.4.45-and-earlier single robot without losing subscriptions.
  if (!settings?.qqBotAppId && !(settings?.qqBotTargets?.length)) return []
  return [{
    id: 'legacy-default',
    enabled: Boolean(settings?.qqBotEnabled),
    appId: settings?.qqBotAppId?.trim() ?? '',
    targets: (settings?.qqBotTargets ?? []).map((target) => ({ ...target, botId: 'legacy-default', label: /^自动发现的 QQ (?:群|私聊)$/.test(target.label ?? '') ? '' : target.label ?? '', keywords: normalizeQQKeywords(target.keywords) })),
    commandPanelIds: settings?.qqCommandPanelAppId === settings?.qqBotAppId ? settings?.qqCommandPanelIds ?? {} : {}
  }]
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
      || typeof candidate.message !== 'string' || !['debug', 'info', 'warn', 'error'].includes(candidate.level ?? '')) return []
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
          qqBotTargets: (parsed.settings?.qqBotTargets ?? []).map((target) => ({ ...target, botId: target.botId ?? 'legacy-default', keywords: normalizeQQKeywords(target.keywords) })),
          qqCommandPanelIds: parsed.settings?.qqCommandPanelIds ?? {},
          qqCommandPanelAppId: parsed.settings?.qqCommandPanelAppId ?? '',
          qqBots: normalizeQQBots(parsed.settings),
          subscriptionVisibleCount: Math.max(1, Math.min(10, Number(parsed.settings?.subscriptionVisibleCount) || defaultState.settings.subscriptionVisibleCount)),
          theme: ['emerald', 'sapphire', 'violet', 'rose', 'amber', 'obsidian', 'porcelain'].includes(parsed.settings?.theme ?? '') ? parsed.settings?.theme as AppSettings['theme'] : defaultState.settings.theme
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
