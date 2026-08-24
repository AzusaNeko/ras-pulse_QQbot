import { createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'

function value(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const privateKeyPath = value('--private')
const holder = value('--holder')
const deviceId = value('--device')
const expiresAt = value('--expires')
if (!privateKeyPath || !holder || !deviceId) {
  throw new Error('用法：node scripts/issue-license.mjs --private license-admin/issuer-private.pem --holder 用户名 --device 设备代码 [--expires 2027-12-31]')
}
const expiry = expiresAt ? Date.parse(`${expiresAt}T23:59:59.999Z`) : undefined
if (expiresAt && Number.isNaN(expiry)) throw new Error('--expires 必须是 YYYY-MM-DD')
const payload = { v: 1, id: crypto.randomUUID(), holder, device: deviceId, issuedAt: Date.now(), ...(expiry ? { expiresAt: expiry } : {}) }
const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
const signature = sign(null, Buffer.from(encoded), createPrivateKey(await readFile(privateKeyPath, 'utf8'))).toString('base64url')
console.log(`MP1.${encoded}.${signature}`)
