import { createHash, randomUUID, verify } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LicenseStatus } from '../shared/types'
import { LICENSE_PUBLIC_KEY_DER_BASE64 } from './license-public-key.ts'

interface LicensePayload {
  v: 1
  id: string
  holder: string
  device: string
  issuedAt: number
  expiresAt?: number
}

interface LicenseFile {
  deviceId: string
  licenseKey?: string
}

function deviceFingerprint(value: string): string {
  return createHash('sha256').update(`mercari-pulse-device-v1:${value}`).digest('hex').slice(0, 24).toUpperCase()
}

export class OfflineLicenseManager {
  private file: LicenseFile | undefined
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async status(): Promise<LicenseStatus> {
    const file = await this.load()
    if (!file.licenseKey) return { active: false, deviceId: deviceFingerprint(file.deviceId), error: '请输入授权码以启用监控功能。' }
    return this.verifyKey(file.licenseKey, file.deviceId)
  }

  async activate(licenseKey: string): Promise<LicenseStatus> {
    const file = await this.load()
    const result = this.verifyKey(licenseKey.trim(), file.deviceId)
    if (!result.active) return result
    file.licenseKey = licenseKey.trim()
    await this.save(file)
    return result
  }

  private async load(): Promise<LicenseFile> {
    if (this.file) return this.file
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<LicenseFile>
      if (typeof parsed.deviceId === 'string' && parsed.deviceId) return this.file = { deviceId: parsed.deviceId, licenseKey: parsed.licenseKey }
    } catch { /* A new installation has no license file yet. */ }
    this.file = { deviceId: randomUUID() }
    await this.save(this.file)
    return this.file
  }

  private verifyKey(key: string, deviceId: string): LicenseStatus {
    const deviceIdForUser = deviceFingerprint(deviceId)
    try {
      const [prefix, payloadPart, signaturePart, extra] = key.split('.')
      if (prefix !== 'MP1' || !payloadPart || !signaturePart || extra) throw new Error('授权码格式不正确。')
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Partial<LicensePayload>
      const signature = Buffer.from(signaturePart, 'base64url')
      const publicKey = { key: Buffer.from(LICENSE_PUBLIC_KEY_DER_BASE64, 'base64'), format: 'der' as const, type: 'spki' as const }
      if (!verify(null, Buffer.from(payloadPart), publicKey, signature)) throw new Error('授权码签名无效。')
      if (payload.v !== 1 || !payload.id || !payload.holder || !payload.device) throw new Error('授权码内容无效。')
      if (payload.device !== deviceIdForUser) throw new Error('该授权码绑定到其他设备。')
      if (payload.expiresAt != null && (!Number.isFinite(payload.expiresAt) || Date.now() > payload.expiresAt)) throw new Error('授权码已过期。')
      return { active: true, deviceId: deviceIdForUser, holder: payload.holder, expiresAt: payload.expiresAt }
    } catch (error) {
      return { active: false, deviceId: deviceIdForUser, error: error instanceof Error ? error.message : '授权码验证失败。' }
    }
  }

  private async save(value: LicenseFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await writeFile(temporary, JSON.stringify(value), 'utf8')
    await rename(temporary, this.filePath)
  }
}
