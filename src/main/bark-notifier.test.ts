import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BarkSettings, FavoriteUpdate, MercariItem } from '../shared/types'
import { BarkNotifier, buildBarkFavoritePayload, buildBarkItemPayload } from './bark-notifier'

const item: MercariItem = {
  id: 'm123',
  name: '测试商品',
  price: 12_800,
  thumbnail: 'https://static.mercdn.net/item/detail/orig/photos/m123.jpg',
  url: 'https://jp.mercari.com/item/m123',
  status: 'ITEM_STATUS_ON_SALE',
  detectedAt: 1,
  subscriptionId: 'watch-1',
  keyword: '相机',
  discoveryType: 'updated',
  updateSummary: '价格变化'
}

const settings: BarkSettings = {
  enabled: true,
  serverUrl: 'https://push.example.com/bark',
  level: 'timeSensitive',
  includeImage: true,
  devices: [
    { id: 'phone-1', name: '主力机', enabled: true },
    { id: 'phone-2', name: '备用机', enabled: true }
  ]
}

function success(): Response {
  return new Response(JSON.stringify({ code: 200 }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.useRealTimers())

describe('BarkNotifier', () => {
  it('全局关闭时不发送，设备关闭时只发送给启用设备', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => success())
    const notifier = new BarkNotifier({ get: async (id) => `secret-${id}` }, fetchMock)

    expect(await notifier.sendItem(item, { ...settings, enabled: false })).toMatchObject({ delivered: 0, failed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()

    const result = await notifier.sendItem(item, {
      ...settings,
      devices: settings.devices.map((device, index) => ({ ...device, enabled: index === 0 }))
    })
    expect(result).toMatchObject({ delivered: 1, failed: 0 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('构造包含完整商品信息、链接、等级和可选图片的负载', () => {
    expect(buildBarkItemPayload(item, settings)).toEqual({
      title: '旧商品更新 · 相机',
      body: '测试商品\n¥12,800\n更新：价格变化',
      level: 'timeSensitive',
      group: '相机',
      url: item.url,
      icon: item.thumbnail
    })
    expect(buildBarkItemPayload(item, { ...settings, includeImage: false })).not.toHaveProperty('icon')
  })

  it('构造收藏降价和售出变化且不指定声音或关键通知', () => {
    const update: FavoriteUpdate = {
      favorite: { ...item, addedAt: 1, previousPrice: 15_000 },
      priceChanged: true,
      sold: true
    }
    const payload = buildBarkFavoritePayload(update, settings)
    expect(payload.body).toContain('价格 ¥15,000 → ¥12,800')
    expect(payload.body).toContain('商品已售出')
    expect(payload).not.toHaveProperty('sound')
    expect(payload).not.toHaveProperty('critical')
    expect(payload).not.toHaveProperty('ciphertext')
  })

  it('逐设备发送且不把 deviceKey 放进 URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => success())
    const secrets = { get: vi.fn(async (id: string) => `secret-${id}`) }
    const result = await new BarkNotifier(secrets, fetchMock).sendItem(item, settings)

    expect(result).toMatchObject({ delivered: 2, failed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://push.example.com/bark/push',
      'https://push.example.com/bark/push'
    ])
    expect(fetchMock.mock.calls[0][0]).not.toContain('secret-phone-1')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      device_key: 'secret-phone-1',
      title: '旧商品更新 · 相机'
    })
  })

  it('网络错误和 5xx 等待两秒后最多重试一次', async () => {
    const wait = vi.fn(async () => undefined)
    const attempts = new Map<string, number>()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = JSON.parse(String(init?.body)).device_key as string
      const attempt = (attempts.get(key) ?? 0) + 1
      attempts.set(key, attempt)
      if (attempt === 1 && key === 'secret-phone-1') throw new Error('offline')
      if (attempt === 1 && key === 'secret-phone-2') return new Response('', { status: 503 })
      return success()
    })
    const notifier = new BarkNotifier({ get: async (id) => `secret-${id}` }, fetchMock, undefined, wait)

    const result = await notifier.sendItem(item, settings)

    expect(result).toMatchObject({ delivered: 2, failed: 0 })
    expect(wait).toHaveBeenNthCalledWith(1, 2_000)
    expect(wait).toHaveBeenNthCalledWith(2, 2_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('4xx 不重试，并把单台失败与其他设备隔离且日志脱敏', async () => {
    const wait = vi.fn(async () => undefined)
    const diagnostics: string[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = JSON.parse(String(init?.body)).device_key
      return key === 'bad-secret' ? new Response('', { status: 400 }) : success()
    })
    const notifier = new BarkNotifier({ get: async (id) => id === 'phone-1' ? 'bad-secret' : 'good-secret' }, fetchMock, (_level, message) => diagnostics.push(message), wait)

    const result = await notifier.sendItem(item, settings)

    expect(result).toMatchObject({ delivered: 1, failed: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wait).not.toHaveBeenCalled()
    expect(diagnostics.join('\n')).toContain('HTTP 400')
    expect(diagnostics.join('\n')).not.toContain('bad-secret')
    expect(diagnostics.join('\n')).not.toContain('good-secret')
  })

  it('请求超时后只进行一次重试', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const notifier = new BarkNotifier({ get: async () => 'secret' }, fetchMock, undefined, async () => undefined, 5)
    const result = notifier.sendTest(settings.devices[0], settings).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(5)

    expect(await result).toMatchObject({ message: 'Bark 请求超时' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('允许在全局和设备关闭时单独测试目标设备', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => success())
    const notifier = new BarkNotifier({ get: async () => 'secret' }, fetchMock)

    await notifier.sendTest({ id: 'phone-1', name: '主力机', enabled: false }, { ...settings, enabled: false }, undefined)

    expect(fetchMock).toHaveBeenCalledOnce()
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(payload).toMatchObject({ title: 'Mercari Pulse Bark 测试通知', group: '测试' })
    expect(payload).not.toHaveProperty('url')
    expect(payload).not.toHaveProperty('icon')
  })
})
