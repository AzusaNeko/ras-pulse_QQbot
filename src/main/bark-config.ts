import { randomUUID } from 'node:crypto'
import type { BarkConfig, BarkSettings, SaveBarkConfigInput } from '../shared/types'

export interface PreparedBarkConfig {
  settings: BarkSettings
  keysToStore: Array<{ deviceId: string; deviceKey: string }>
}

export function normalizeBarkServerUrl(value: string): string {
  const input = value.trim()
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('Bark Server 必须填写完整的 HTTP 或 HTTPS 地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Bark Server 只支持 HTTP 或 HTTPS 地址')
  }
  return parsed.toString().replace(/\/$/, '')
}

export function buildBarkPushUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl)
  parsed.hash = ''
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/push`
  return parsed.toString()
}

export async function prepareBarkConfig(
  input: SaveBarkConfigInput,
  getExistingKey: (deviceId: string) => Promise<string | undefined>
): Promise<PreparedBarkConfig> {
  const serverUrl = normalizeBarkServerUrl(input.serverUrl)
  const level = input.level === 'timeSensitive' ? 'timeSensitive' : 'active'
  const usedIds = new Set<string>()
  const usedKeys = new Set<string>()
  const keysToStore: PreparedBarkConfig['keysToStore'] = []
  const devices = [] as BarkSettings['devices']

  for (const [index, inputDevice] of input.devices.entries()) {
    let id = inputDevice.id.trim() || randomUUID()
    if (usedIds.has(id)) id = randomUUID()
    usedIds.add(id)
    const suppliedKey = inputDevice.deviceKey?.trim()
    const deviceKey = suppliedKey || await getExistingKey(id)
    if (!deviceKey) throw new Error(`请为${inputDevice.name.trim() || `Bark 设备 ${index + 1}`}填写 deviceKey`)
    if (usedKeys.has(deviceKey)) throw new Error('同一 Bark Server 下不能重复添加相同的 deviceKey')
    usedKeys.add(deviceKey)
    if (suppliedKey) keysToStore.push({ deviceId: id, deviceKey: suppliedKey })
    devices.push({
      id,
      name: inputDevice.name.trim() || `Bark 设备 ${index + 1}`,
      enabled: Boolean(inputDevice.enabled)
    })
  }

  if (input.enabled && !devices.some((device) => device.enabled)) {
    throw new Error('开启 Bark 手机推送前，请至少启用一台已配置设备')
  }

  return {
    settings: {
      enabled: Boolean(input.enabled),
      serverUrl,
      level,
      includeImage: Boolean(input.includeImage),
      devices
    },
    keysToStore
  }
}

export async function exposeBarkConfig(
  settings: BarkSettings,
  hasKey: (deviceId: string) => Promise<boolean>
): Promise<BarkConfig> {
  return {
    ...settings,
    devices: await Promise.all(settings.devices.map(async (device) => ({
      ...device,
      keyConfigured: await hasKey(device.id)
    })))
  }
}
