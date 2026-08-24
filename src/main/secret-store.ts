import { safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Stores the QQ AppSecret outside application settings, encrypted with Windows DPAPI. */
export class SecretStore {
  constructor(private readonly filePath: string) {}

  async has(): Promise<boolean> {
    return Boolean(await this.readEncrypted())
  }

  async get(): Promise<string | undefined> {
    const encrypted = await this.readEncrypted()
    if (!encrypted) return undefined
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法读取 QQ 密钥')
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      throw new Error('无法解密 QQ 密钥，请在设置中重新保存')
    }
  }

  async set(value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法保存 QQ 密钥')
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await writeFile(temporary, safeStorage.encryptString(value).toString('base64'), 'utf8')
    await rename(temporary, this.filePath)
  }

  private async readEncrypted(): Promise<string | undefined> {
    try {
      return (await readFile(this.filePath, 'utf8')).trim() || undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}
