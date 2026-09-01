import { safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Stores application secrets outside normal settings, encrypted with Windows DPAPI. */
export class SecretStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly secretLabel = 'QQ 密钥'
  ) {}

  async has(botId = 'legacy-default'): Promise<boolean> {
    return Boolean((await this.readEncrypted())[botId])
  }

  async get(botId = 'legacy-default'): Promise<string | undefined> {
    const encrypted = (await this.readEncrypted())[botId]
    if (!encrypted) return undefined
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`Windows 安全存储不可用，无法读取${this.secretLabel}`)
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      throw new Error(`无法解密${this.secretLabel}，请在设置中重新保存`)
    }
  }

  async set(botId: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`Windows 安全存储不可用，无法保存${this.secretLabel}`)
    const encrypted = safeStorage.encryptString(value).toString('base64')
    await this.mutate((entries) => { entries[botId] = encrypted })
  }

  async delete(secretId: string): Promise<void> {
    await this.mutate((entries) => { delete entries[secretId] })
  }

  private async mutate(update: (entries: Record<string, string>) => void): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const entries = await this.readEncrypted()
      update(entries)
      const temporary = `${this.filePath}.tmp`
      await writeFile(temporary, JSON.stringify(entries), 'utf8')
      await rename(temporary, this.filePath)
    })
    this.writeQueue = write.catch(() => undefined)
    await write
  }

  private async readEncrypted(): Promise<Record<string, string>> {
    try {
      const raw = (await readFile(this.filePath, 'utf8')).trim()
      if (!raw) return {}
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      } catch { /* v0.4.45 stored exactly one encrypted string */ }
      return { 'legacy-default': raw }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
}
