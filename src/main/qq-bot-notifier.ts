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

  constructor(private readonly secrets: SecretStore) {}

  async sendItem(item: MercariItem, settings: AppSettings): Promise<QQDeliveryResult> {
    const content = this.formatItem(item, settings)
    return this.sendText(content, settings)
  }

  async sendTest(settings: AppSettings, item?: MercariItem): Promise<QQDeliveryResult> {
    const content = item
      ? `【测试推送】\n${this.formatItem(item, settings)}`
      : '【Ras Pulse 测试推送】\nQQ 机器人连接正常。后续检测到日本二手商品上新时，会在这里提醒你。'
    return this.sendText(content, settings)
  }

  private formatItem(item: MercariItem, settings: AppSettings): string {
    const lines = [`【发现上新】${item.keyword}`]
    if (settings.notificationIncludeName) lines.push(`商品：${item.name}`)
    if (settings.notificationIncludePrice) lines.push(`价格：¥${item.price.toLocaleString('ja-JP')}`)
    lines.push(`链接：${item.url}`)
    return lines.join('\n')
  }

  private async sendText(content: string, settings: AppSettings): Promise<QQDeliveryResult> {
    if (!settings.qqBotEnabled) throw new Error('请先开启 QQ 机器人推送')
    if (!settings.qqBotAppId.trim()) throw new Error('请填写 QQ AppID')
    const targets = settings.qqBotTargets.filter((target) => target.enabled && target.targetId.trim())
    if (!targets.length) throw new Error('请至少添加一个启用的 QQ 推送目标')
    const secret = await this.secrets.get()
    if (!secret) throw new Error('请填写并保存 QQ AppSecret')
    const client = this.getClient(settings.qqBotAppId, secret)
    const outcomes = await Promise.allSettled(targets.map((target) => client.sendText({
      scope: target.type,
      targetId: target.targetId.trim()
    }, content)))
    const failedTargets = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [targets[index]] : [])
    for (const target of failedTargets) console.warn(`QQ 推送失败：${this.targetName(target)}`)
    return { delivered: outcomes.length - failedTargets.length, failed: failedTargets.length }
  }

  private getClient(appId: string, secret: string): QQBot {
    const key = `${appId}\u0000${secret}`
    if (!this.client || this.clientKey !== key) {
      this.client = new QQBot({ appId, appSecret: secret })
      this.clientKey = key
    }
    return this.client
  }

  private targetName(target: QQBotTarget): string {
    return target.label || `${target.type === 'group' ? '群聊' : '私聊'} ${target.targetId}`
  }
}
