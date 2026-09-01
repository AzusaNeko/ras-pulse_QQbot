import type { BarkDevice, BarkSettings, FavoriteUpdate, LogLevel, MercariItem } from '../shared/types'
import { isSupportedMercariImageUrl } from './mercari-item-url'
import type { FetchLike } from './mercari-client'

const DEFAULT_TIMEOUT_MS = 8_000
const RETRY_DELAY_MS = 2_000

interface BarkSecretReader {
  get(deviceId: string): Promise<string | undefined>
}

export interface BarkPayload {
  title: string
  body: string
  level: BarkSettings['level']
  group?: string
  url?: string
  icon?: string
}

export interface BarkBroadcastResult {
  delivered: number
  failed: number
  failures: Array<{ deviceId: string; deviceName: string; reason: string }>
}

class BarkHttpError extends Error {
  constructor(readonly status: number) {
    super(`Bark HTTP ${status}`)
  }
}

class BarkTimeoutError extends Error {}

function price(value: number): string {
  return `¥${value.toLocaleString('ja-JP')}`
}

export function buildBarkItemPayload(item: MercariItem, settings: BarkSettings, isTest = false): BarkPayload {
  const eventTitle = item.discoveryType === 'updated' ? '旧商品更新' : '发现上新'
  const lines = [item.name, price(item.price)]
  if (item.updateSummary) lines.push(`更新：${item.updateSummary}`)
  return {
    title: `${isTest ? '测试 · ' : ''}${eventTitle} · ${item.keyword}`,
    body: lines.join('\n'),
    level: settings.level,
    group: item.keyword,
    url: item.url,
    ...(settings.includeImage && isSupportedMercariImageUrl(item.thumbnail) ? { icon: item.thumbnail } : {})
  }
}

export function buildBarkFavoritePayload(update: FavoriteUpdate, settings: BarkSettings): BarkPayload {
  const lines = [update.favorite.name, price(update.favorite.price)]
  const changes = [
    update.sold ? '商品已售出' : '',
    update.priceChanged
      ? update.favorite.previousPrice === undefined
        ? `价格变为 ${price(update.favorite.price)}`
        : `价格 ${price(update.favorite.previousPrice)} → ${price(update.favorite.price)}`
      : ''
  ].filter(Boolean)
  if (changes.length) lines.push(changes.join(' · '))
  return {
    title: '收藏商品状态变化',
    body: lines.join('\n'),
    level: settings.level,
    group: '收藏',
    url: update.favorite.url,
    ...(settings.includeImage && isSupportedMercariImageUrl(update.favorite.thumbnail) ? { icon: update.favorite.thumbnail } : {})
  }
}

export class BarkNotifier {
  constructor(
    private readonly secrets: BarkSecretReader,
    private readonly fetchImpl: FetchLike,
    private readonly onDiagnostic?: (level: LogLevel, message: string) => void,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  async sendItem(item: MercariItem, settings: BarkSettings): Promise<BarkBroadcastResult> {
    if (!settings.enabled) return { delivered: 0, failed: 0, failures: [] }
    return this.broadcast(buildBarkItemPayload(item, settings), settings)
  }

  async sendFavoriteUpdate(update: FavoriteUpdate, settings: BarkSettings): Promise<BarkBroadcastResult> {
    if (!settings.enabled) return { delivered: 0, failed: 0, failures: [] }
    return this.broadcast(buildBarkFavoritePayload(update, settings), settings)
  }

  async sendTest(device: BarkDevice, settings: BarkSettings, item?: MercariItem): Promise<void> {
    const payload = item
      ? buildBarkItemPayload(item, settings, true)
      : {
          title: 'Mercari Pulse Bark 测试通知',
          body: 'Bark 手机推送配置工作正常。',
          level: settings.level,
          group: '测试'
        } satisfies BarkPayload
    await this.sendToDevice(device, payload, settings.serverUrl)
  }

  private async broadcast(payload: BarkPayload, settings: BarkSettings): Promise<BarkBroadcastResult> {
    const devices = settings.devices.filter((device) => device.enabled)
    const outcomes = await Promise.allSettled(devices.map((device) => this.sendToDevice(device, payload, settings.serverUrl)))
    const failures: BarkBroadcastResult['failures'] = []
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') return
      const device = devices[index]
      const reason = this.describeError(outcome.reason)
      failures.push({ deviceId: device.id, deviceName: device.name, reason })
      this.onDiagnostic?.('warn', `Bark 设备“${device.name}”（${device.id}）推送失败：${reason}`)
    })
    return { delivered: devices.length - failures.length, failed: failures.length, failures }
  }

  private async sendToDevice(device: BarkDevice, payload: BarkPayload, serverUrl: string): Promise<void> {
    const deviceKey = await this.secrets.get(device.id)
    if (!deviceKey) throw new Error('设备密钥未配置')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.sendOnce(serverUrl, deviceKey, payload)
        return
      } catch (error) {
        if (attempt === 1 || !this.shouldRetry(error)) throw error
        await this.wait(RETRY_DELAY_MS)
      }
    }
  }

  private async sendOnce(serverUrl: string, deviceKey: string, payload: BarkPayload): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(this.pushUrl(serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ device_key: deviceKey, ...payload }),
        signal: controller.signal
      })
      if (!response.ok) throw new BarkHttpError(response.status)
      if (response.headers.get('content-type')?.includes('application/json')) {
        const result = await response.json().catch(() => undefined) as { code?: unknown } | undefined
        if (typeof result?.code === 'number' && result.code !== 200) {
          throw new BarkHttpError(result.code >= 400 && result.code <= 599 ? result.code : 500)
        }
      }
    } catch (error) {
      if (error instanceof BarkHttpError) throw error
      if (controller.signal.aborted) throw new BarkTimeoutError('Bark 请求超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private pushUrl(serverUrl: string): string {
    const parsed = new URL(serverUrl)
    parsed.hash = ''
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/push`
    return parsed.toString()
  }

  private shouldRetry(error: unknown): boolean {
    return !(error instanceof BarkHttpError) || error.status >= 500
  }

  private describeError(error: unknown): string {
    if (error instanceof BarkHttpError) return `服务器返回 HTTP ${error.status}`
    if (error instanceof BarkTimeoutError) return '请求超时'
    if (error instanceof Error && error.message === '设备密钥未配置') return error.message
    return '网络请求失败'
  }
}
