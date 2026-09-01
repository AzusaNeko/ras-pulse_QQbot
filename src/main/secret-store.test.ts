import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, ''))
}))

vi.mock('electron', () => ({ safeStorage }))

import { SecretStore } from './secret-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  vi.clearAllMocks()
  safeStorage.isEncryptionAvailable.mockReturnValue(true)
})

describe('SecretStore', () => {
  it('加密保存多个密钥并可独立删除', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mercari-pulse-secret-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'bark-secret.dat')
    const store = new SecretStore(path, 'Bark 设备密钥')

    await Promise.all([store.set('phone-1', 'key-one'), store.set('phone-2', 'key-two')])
    expect(await store.get('phone-1')).toBe('key-one')
    expect(await store.get('phone-2')).toBe('key-two')
    expect(await readFile(path, 'utf8')).not.toContain('key-one')

    await store.delete('phone-1')

    expect(await store.has('phone-1')).toBe(false)
    expect(await store.get('phone-2')).toBe('key-two')
  })

  it('安全存储不可用时给出不包含密钥的错误', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mercari-pulse-secret-'))
    temporaryDirectories.push(directory)
    const store = new SecretStore(join(directory, 'bark-secret.dat'), 'Bark 设备密钥')
    safeStorage.isEncryptionAvailable.mockReturnValue(false)

    await expect(store.set('phone-1', 'should-not-leak')).rejects.toThrow('无法保存Bark 设备密钥')
    await expect(store.set('phone-1', 'should-not-leak')).rejects.not.toThrow('should-not-leak')
  })
})
