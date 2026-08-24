import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings, FavoriteItem, MercariItem, QQBotKeyword, Subscription } from '../shared/types'

export interface PersistedState {
  subscriptions: Subscription[]
  recentItems: MercariItem[]
  favorites: FavoriteItem[]
  settings: AppSettings
  seenBySubscription: Record<string, string[]>
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
  seenBySubscription: {}
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
        subscriptions: parsed.subscriptions ?? [],
        recentItems: (parsed.recentItems ?? []).map((item) => ({ ...item, isAuction: typeof item.isAuction === 'boolean' ? item.isAuction : undefined })),
        favorites: (parsed.favorites ?? []).map((item) => ({ ...item, isAuction: typeof item.isAuction === 'boolean' ? item.isAuction : undefined })),
        seenBySubscription: parsed.seenBySubscription ?? {}
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
