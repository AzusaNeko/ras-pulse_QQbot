import { describe, expect, it, vi } from 'vitest'
import type { SaveBarkConfigInput } from '../shared/types'
import { buildBarkPushUrl, exposeBarkConfig, normalizeBarkServerUrl, prepareBarkConfig } from './bark-config'

const baseInput: SaveBarkConfigInput = {
  enabled: true,
  serverUrl: 'https://api.day.app',
  level: 'active',
  includeImage: true,
  devices: [{ id: 'phone-1', name: '主力机', enabled: true, deviceKey: 'key-1' }]
}

describe('Bark 配置', () => {
  it('只接受完整 HTTP/HTTPS 地址并保留反向代理路径', () => {
    expect(normalizeBarkServerUrl(' https://push.example.com/bark/ ')).toBe('https://push.example.com/bark')
    expect(normalizeBarkServerUrl('http://192.168.1.20:8080')).toBe('http://192.168.1.20:8080')
    expect(() => normalizeBarkServerUrl('ftp://example.com')).toThrow('只支持 HTTP 或 HTTPS')
    expect(() => normalizeBarkServerUrl('/bark')).toThrow('必须填写完整')
    expect(buildBarkPushUrl('https://push.example.com/bark')).toBe('https://push.example.com/bark/push')
  })

  it('规范化名称、保留已有密钥并不向配置读取方暴露密钥', async () => {
    const prepared = await prepareBarkConfig({
      ...baseInput,
      devices: [{ id: 'phone-1', name: '  ', enabled: true }]
    }, async () => 'stored-key')

    expect(prepared.settings.devices).toEqual([{ id: 'phone-1', name: 'Bark 设备 1', enabled: true }])
    expect(prepared.keysToStore).toEqual([])
    expect(await exposeBarkConfig(prepared.settings, async () => true)).toEqual({
      ...prepared.settings,
      devices: [{ id: 'phone-1', name: 'Bark 设备 1', enabled: true, keyConfigured: true }]
    })
  })

  it('拒绝空密钥、重复密钥以及没有启用设备的全局开启', async () => {
    await expect(prepareBarkConfig({ ...baseInput, devices: [{ id: 'phone-1', name: '', enabled: true }] }, async () => undefined))
      .rejects.toThrow('填写 deviceKey')
    await expect(prepareBarkConfig({
      ...baseInput,
      devices: [
        { id: 'phone-1', name: 'A', enabled: true, deviceKey: 'same-key' },
        { id: 'phone-2', name: 'B', enabled: true, deviceKey: 'same-key' }
      ]
    }, async () => undefined)).rejects.toThrow('不能重复')
    await expect(prepareBarkConfig({
      ...baseInput,
      devices: [{ id: 'phone-1', name: 'A', enabled: false, deviceKey: 'key-1' }]
    }, async () => undefined)).rejects.toThrow('至少启用一台')
  })

  it('只保存本次输入的新密钥', async () => {
    const existing = vi.fn(async () => 'old-key')
    const result = await prepareBarkConfig({
      ...baseInput,
      devices: [
        { id: 'phone-1', name: 'A', enabled: true },
        { id: 'phone-2', name: 'B', enabled: true, deviceKey: 'new-key' }
      ]
    }, existing)

    expect(result.keysToStore).toEqual([{ deviceId: 'phone-2', deviceKey: 'new-key' }])
    expect(existing).toHaveBeenCalledWith('phone-1')
  })
})
