import { generateKeyPairSync } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve(process.cwd(), 'license-admin')
const privateKeyPath = resolve(output, 'issuer-private.pem')
try {
  await access(privateKeyPath)
  throw new Error(`发行私钥已存在：${privateKeyPath}\n为保护已发出的授权码，已拒绝覆盖。请备份该文件，不要再次生成。`)
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
await mkdir(output, { recursive: true })
await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
await writeFile(resolve(output, 'issuer-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
