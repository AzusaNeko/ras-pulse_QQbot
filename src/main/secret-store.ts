import { safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Stores QQ AppSecrets outside application settings, encrypted with Windows DPAPI. */
export class SecretStore {
  constructor(private readonly filePath: string) {}

  async has(botId = 'legacy-default'): Promise<boolean> {
    return Boolean((await this.readEncrypted())[botId])
  }

  async get(botId = 'legacy-default'): Promise<string | undefined> {
    const encrypted = (await this.readEncrypted())[botId]
    if (!encrypted) return undefined
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法读取 QQ 密钥')
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      throw new Error('无法解密 QQ 密钥，请在设置中重新保存')
    }
  }

  async set(botId: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法保存 QQ 密钥')
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const entries = await this.readEncrypted()
    entries[botId] = safeStorage.encryptString(value).toString('base64')
    await writeFile(temporary, JSON.stringify(entries), 'utf8')
    await rename(temporary, this.filePath)
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
