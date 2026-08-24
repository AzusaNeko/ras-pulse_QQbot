import { MercariClient } from '../src/main/mercari-client.ts'
import type { Subscription } from '../src/shared/types.ts'

const keyword = process.argv[2] ?? 'Nintendo Switch'
const subscription: Subscription = {
  id: 'smoke-test',
  keyword,
  excludeKeyword: '',
  enabled: true,
  intervalMs: 1_000,
  initialDisplayCount: 5,
  createdAt: Date.now(),
  status: 'checking',
  consecutiveErrors: 0
}

try {
  const items = await new MercariClient().search(subscription)
  console.log(JSON.stringify({ ok: true, keyword, resultCount: items.length, firstItem: items[0]?.name ?? null }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
