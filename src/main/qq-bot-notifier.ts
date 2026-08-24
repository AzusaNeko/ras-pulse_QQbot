import { QQBot } from '@tencent-connect/qqbot-nodejs'
import type { AppSettings, MercariItem, QQBotTarget } from '../shared/types'
import { SecretStore } from './secret-store'

export interface QQDeliveryResult {
  delivered: number
  failed: number
}

export class QQBotNotifier {
  private client: QQBot | null = null
  private clientKey = ''
  private receivingKey = ''

  constructor(
    private readonly secrets: SecretStore,
    private readonly onTargetDiscovered: (target: QQBotTarget) => Promise<void>
  ) {}

  /** Starts the WebSocket gateway so QQ reports the bot as connected and targets can be discovered. */
  async connect(settings: AppSettings): Promise<void> {
    if (!settings.qqBotEnabled) {
      this.stop()
      return
    }
    const secret = await this.requireSecret(settings)
    const key = `${settings.qqBotAppId}\u0000${secret}`
    if (this.receivingKey === key) return
    this.stop()
    const client = this.getClient(settings.qqBotAppId, secret)
    this.receivingKey = key
    client.on('ready', () => console.info('QQ 机器人服务已连接'))
    client.on('error', (error) => console.error(`QQ 机器人服务异常：${error.message}`))
    client.on('message', async (_context, message) => {
      const target = message.replyTarget
      if (target.scope !== 'c2c' && target.scope !== 'group') return
      await this.onTargetDiscovered({
        id: `${target.scope}:${target.targetId}`,
        type: target.scope,
        targetId: target.targetId,
        label: target.scope === 'group' ? '自动发现的 QQ 群' : '自动发现的 QQ 私聊',
        enabled: true
      })
    })
    void client.start().catch((error) => {
      if (this.receivingKey === key) this.receivingKey = ''
      console.error(`QQ 机器人连接失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  stop(): void {
    this.client?.stop()
    this.receivingKey = ''
  }

  async sendItem(item: MercariItem, settings: AppSettings): Promise<QQDeliveryResult> {
    const content = this.formatItem(item, settings)
    if (!settings.qqBotEnabled) throw new Error('请先开启 QQ 机器人推送')
    const targets = this.enabledTargets(settings)
    const secret = await this.requireSecret(settings)
    const client = this.getClient(settings.qqBotAppId, secret)
    const outcomes = await Promise.allSettled(targets.map(async (target) => {
      const replyTarget = { scope: target.type, targetId: target.targetId.trim() } as const
      if (!this.isProductImageUrl(item.thumbnail)) {
        await client.sendText(replyTarget, content)
        return
      }
      try {
        // QQ retrieves the image directly from the product URL; no image is stored locally.
        await client.sendImage(replyTarget, { url: item.thumbnail }, { content })
      } catch (error) {
        console.warn(`QQ 商品图片上传失败，改为文字推送：${this.targetName(target)} (${error instanceof Error ? error.message : String(error)})`)
        await client.sendText(replyTarget, content)
      }
    }))
    return this.summarizeOutcomes(outcomes, targets)
  }

  async sendTest(settings: AppSettings, item?: MercariItem): Promise<QQDeliveryResult> {
    const content = item
      ? `【测试推送】\n${this.formatItem(item, settings)}`
      : '【Ras Pulse 测试推送】\nQQ 机器人连接正常。后续检测到日本二手商品上新时，会在这里提醒你。'
    return this.sendText(content, settings)
  }

  private formatItem(item: MercariItem, settings: AppSettings): string {
    void settings
    return [
      `【发现上新】${item.keyword}`,
      `商品：${item.name}`,
      `价格：¥${item.price.toLocaleString('ja-JP')}`,
      `链接：${item.url}`
    ].join('\n')
  }

  private async sendText(content: string, settings: AppSettings): Promise<QQDeliveryResult> {
    if (!settings.qqBotEnabled) throw new Error('请先开启 QQ 机器人推送')
    const targets = this.enabledTargets(settings)
    const secret = await this.requireSecret(settings)
    const client = this.getClient(settings.qqBotAppId, secret)
    const outcomes = await Promise.allSettled(targets.map((target) => client.sendText({
      scope: target.type,
      targetId: target.targetId.trim()
    }, content)))
    return this.summarizeOutcomes(outcomes, targets)
  }

  private enabledTargets(settings: AppSettings): QQBotTarget[] {
    const targets = settings.qqBotTargets.filter((target) => target.enabled && target.targetId.trim())
    if (!targets.length) throw new Error('请至少添加一个启用的 QQ 推送目标')
    return targets
  }

  private summarizeOutcomes(outcomes: PromiseSettledResult<unknown>[], targets: QQBotTarget[]): QQDeliveryResult {
    const failedTargets = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [targets[index]] : [])
    for (const target of failedTargets) console.warn(`QQ 推送失败：${this.targetName(target)}`)
    return { delivered: outcomes.length - failedTargets.length, failed: failedTargets.length }
  }

  private isProductImageUrl(url: string | undefined): url is string {
    return Boolean(url && url.startsWith('https://static.mercdn.net/'))
  }

  private getClient(appId: string, secret: string): QQBot {
    const key = `${appId}\u0000${secret}`
    if (!this.client || this.clientKey !== key) {
      this.client = new QQBot({ appId, appSecret: secret })
      this.clientKey = key
    }
    return this.client
  }

  private async requireSecret(settings: AppSettings): Promise<string> {
    if (!settings.qqBotAppId.trim()) throw new Error('请填写 QQ AppID')
    const secret = await this.secrets.get()
    if (!secret) throw new Error('请填写并保存 QQ AppSecret')
    return secret
  }

  private targetName(target: QQBotTarget): string {
    return target.label || `${target.type === 'group' ? '群聊' : '私聊'} ${target.targetId}`
  }
}
