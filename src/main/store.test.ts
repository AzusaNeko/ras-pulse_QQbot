import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore, defaultState } from './store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('JsonStore', () => {
  it('为旧状态补齐默认关闭的 Bark 配置', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mercari-pulse-store-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state.json')
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify({
      ...structuredClone(defaultState),
      settings: { notificationsEnabled: false }
    }), 'utf8'))

    const state = await new JsonStore(path).load()

    expect(state.settings.notificationsEnabled).toBe(false)
    expect(state.settings.bark).toEqual({
      enabled: false,
      serverUrl: 'https://api.day.app',
      level: 'active',
      includeImage: true,
      devices: []
    })
  })

  it('serializes simultaneous saves so every keyword check can persist safely', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mercari-pulse-store-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state.json')
    const store = new JsonStore(path)

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.save({
      ...structuredClone(defaultState),
      logs: [{ id: String(index), timestamp: index, level: 'info', message: `save-${index}` }]
    })))

    const persisted = JSON.parse(await readFile(path, 'utf8')) as typeof defaultState
    expect(persisted.logs[0]?.message).toBe('save-19')
  })
})
