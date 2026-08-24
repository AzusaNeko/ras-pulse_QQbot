import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve(process.cwd(), 'license-admin')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'issuer-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
await writeFile(resolve(output, 'issuer-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
