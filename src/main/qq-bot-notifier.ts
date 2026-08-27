import { QQBot } from '@tencent-connect/qqbot-nodejs'
import type { LogLevel, MercariItem, QQBotAccount, QQBotTarget, QQBotTargetType } from '../shared/types'
import { isSupportedMercariImageUrl } from './mercari-item-url'
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
    private readonly onTargetDiscovered: (target: QQBotTarget) => Promise<void>,
    private readonly onMessageReceived: (target: QQBotTarget, content: string) => Promise<string | undefined>,
    private readonly onDiagnostic?: (level: LogLevel, message: string) => void
  ) {}

  /** Starts the WebSocket gateway so QQ reports the bot as connected and targets can be discovered. */
  async connect(bot: QQBotAccount): Promise<void> {
    if (!bot.enabled) {
      this.stop()
      return
    }
    const secret = await this.requireSecret(bot)
    const key = `${bot.appId}\u0000${secret}`
    if (this.receivingKey === key) return
    this.stop()
    const client = this.getClient(bot.appId, secret)
    this.receivingKey = key
    client.on('ready', () => console.info('QQ 机器人服务已连接'))
    client.on('error', (error) => console.error(`QQ 机器人服务异常：${error.message}`))
    client.on('message', async (_context, message) => {
      const target = message.replyTarget
      if (target.scope !== 'c2c' && target.scope !== 'group') return
      const discoveredTarget: QQBotTarget = {
        id: `${bot.id}:${target.scope}:${target.targetId}`,
        botId: bot.id,
        type: target.scope,
        targetId: target.targetId,
        // A discovered target is intentionally unbound until it sends /bind 名称.
        label: '',
        detectedNickname: this.detectNickname(message),
        enabled: true,
        keywords: []
      }
      await this.onTargetDiscovered(discoveredTarget)
      const response = await this.onMessageReceived(discoveredTarget, message.content)
      if (response) await client.sendText(target, response)
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

  async sendItem(item: MercariItem, bot: QQBotAccount): Promise<QQDeliveryResult> {
    const content = this.formatItem(item)
    if (!bot.enabled) throw new Error('请先开启 QQ 机器人推送')
    const targets = this.enabledTargets(bot, item)
    const secret = await this.requireSecret(bot)
    const client = this.getClient(bot.appId, secret)
    // Text arrives first; image work must never delay a time-sensitive listing alert.
    const outcomes = await Promise.allSettled(targets.map((target) => client.sendText({
      scope: target.type,
      targetId: target.targetId.trim()
    }, content)))
    if (this.isProductImageUrl(item.thumbnail)) {
      void this.sendImageInBackground(client, targets, item.thumbnail)
    }
    return this.summarizeOutcomes(outcomes, targets)
  }

  private async sendImageInBackground(client: QQBot, targets: QQBotTarget[], imageUrl: string): Promise<void> {
    try {
      const image = await this.fetchProductImage(imageUrl)
      const outcomes = await Promise.allSettled(targets.map((target) => client.sendImage({
        scope: target.type,
        targetId: target.targetId.trim()
      }, { buffer: image })))
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length
      if (failed) console.warn(`QQ 商品图片发送失败：${failed}/${targets.length} 个目标`)
    } catch (error) {
      console.warn(`QQ 商品图片加载失败，已保留文字提醒：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async fetchProductImage(url: string): Promise<Buffer> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4_000)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`图片服务器返回 HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length') ?? '0')
      if (length > 4 * 1024 * 1024) throw new Error('商品图片超过 4 MB')
      const image = Buffer.from(await response.arrayBuffer())
      if (!image.length || image.length > 4 * 1024 * 1024) throw new Error('商品图片无效或过大')
      return image
    } finally {
      clearTimeout(timeout)
    }
  }

  async sendTest(bot: QQBotAccount, item?: MercariItem): Promise<QQDeliveryResult> {
    const content = item
      ? `【测试推送】\n${this.formatItem(item)}`
      : '【Ras Pulse 测试推送】\nQQ 机器人连接正常。后续检测到日本二手商品上新时，会在这里提醒你。'
    return this.sendText(content, bot)
  }

  /** Creates panels once, then updates their stored IDs on every later sync. */
  /** Synchronizes QQ command panels only. C2C custom menus are deliberately not managed here. */
  async syncCommandPanels(bot: QQBotAccount): Promise<{ created: number; updated: number; panelIds: Partial<Record<QQBotTargetType, string>> }> {
    const secret = await this.requireSecret(bot)
    const client = this.getClient(bot.appId, secret)
    const panel = {
      items: [
        { type: 'command', name: '/bind ', desc: '为当前会话填写名称' },
        { type: 'command', name: '/add ', desc: '选中后填写关键词' },
        { type: 'command', name: '/remove ', desc: '选中后填写关键词' },
        { type: 'command', name: '/list', desc: '查看我的订阅' },
        { type: 'command', name: '/clear', desc: '清空前会要求确认' },
        { type: 'command', name: '/help', desc: '查看使用说明' }
      ],
      remark: 'ras-pulse-command-panel-v5'
    }
    const panelIds = { ...bot.commandPanelIds }
    let created = 0
    let updated = 0
    for (const scope of ['c2c', 'group'] as const) {
      const targetIds = [...new Set(bot.targets
        .filter((target) => target.enabled && target.type === scope && Boolean(target.targetId.trim()))
        .map((target) => target.targetId.trim()))].slice(0, 20)
      // Specific panels work for the actual QQ recipients and avoid the platform's
      // separate quota for an all-user/all-group global panel.
      if (!targetIds.length) continue
      const storedId = panelIds[scope]
      if (storedId) {
        try {
          await client.api.put(`/v2/panels/${encodeURIComponent(storedId)}`, { panel })
          updated += 1
          continue
        } catch (error) {
          if ((error as { httpStatus?: number }).httpStatus !== 404) throw error
          delete panelIds[scope]
        }
      }
      const createdPanel = await client.api.post<{ panel_id?: string }>('/v2/panels', {
        scope,
        target_type: 'specific',
        ...(scope === 'c2c' ? { user_openids: targetIds } : { group_openids: targetIds }),
        panel
      })
      if (!createdPanel.panel_id) throw new Error('QQ 未返回新建指令面板 ID')
      panelIds[scope] = createdPanel.panel_id
      created += 1
    }
    return { created, updated, panelIds }
  }

  private formatItem(item: MercariItem): string {
    return [
      `${item.discoveryType === 'updated' ? '【旧商品更新】' : '【发现上新】'}${item.keyword}`,
      `商品：${item.name}`,
      `价格：¥${item.price.toLocaleString('ja-JP')}`,
      ...(item.isAuction === true ? ['商品类型：拍卖商品'] : []),
      ...(item.discoveryType === 'updated' ? [`更新内容：${item.updateSummary ?? '卖家编辑了商品信息'}`] : []),
      `链接：${item.url}`
    ].join('\n')
  }

  private async sendText(content: string, bot: QQBotAccount): Promise<QQDeliveryResult> {
    if (!bot.enabled) throw new Error('请先开启 QQ 机器人推送')
    const targets = this.enabledTargets(bot)
    const secret = await this.requireSecret(bot)
    const client = this.getClient(bot.appId, secret)
    const outcomes = await Promise.allSettled(targets.map((target) => client.sendText({
      scope: target.type,
      targetId: target.targetId.trim()
    }, content)))
    return this.summarizeOutcomes(outcomes, targets)
  }

  private enabledTargets(bot: QQBotAccount, item?: MercariItem): QQBotTarget[] {
    const targets = bot.targets.filter((target) => {
      if (!target.enabled || !target.targetId.trim() || !target.label.trim()) return false
      if (!item) return true
      const subscription = target.keywords.find((value) => value.keyword.toLocaleLowerCase() === item.keyword.toLocaleLowerCase())
      return Boolean(subscription && !subscription.excludeKeywords.some((term) => item.name.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
    })
    if (!targets.length && !item) throw new Error('请至少添加一个已绑定且启用的 QQ 推送目标')
    return targets
  }

  private summarizeOutcomes(outcomes: PromiseSettledResult<unknown>[], targets: QQBotTarget[]): QQDeliveryResult {
    const failedTargets = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [targets[index]] : [])
    for (const target of failedTargets) console.warn(`QQ 推送失败：${this.targetName(target)}`)
    return { delivered: outcomes.length - failedTargets.length, failed: failedTargets.length }
  }

  private isProductImageUrl(url: string | undefined): url is string {
    return isSupportedMercariImageUrl(url)
  }

  private getClient(appId: string, secret: string): QQBot {
    const key = `${appId}\u0000${secret}`
    if (!this.client || this.clientKey !== key) {
      this.client = new QQBot({
        appId,
        appSecret: secret,
        logger: {
          debug: (message) => this.logDiagnostic('debug', message),
          info: (message) => this.logDiagnostic('info', message),
          error: (message) => this.logDiagnostic('error', message)
        }
      })
      this.clientKey = key
    }
    return this.client
  }

  private async requireSecret(bot: QQBotAccount): Promise<string> {
    if (!bot.appId.trim()) throw new Error('请填写 QQ AppID')
    const secret = await this.secrets.get(bot.id)
    if (!secret) throw new Error('请填写并保存 QQ AppSecret')
    return secret
  }

  private logDiagnostic(level: LogLevel, message: string): void {
    console[level === 'debug' ? 'info' : level](message)
    this.onDiagnostic?.(level, message)
  }

  private targetName(target: QQBotTarget): string {
    return target.label || `${target.type === 'group' ? '群聊' : '私聊'} ${target.targetId}`
  }

  private detectNickname(message: { senderName?: string; raw?: unknown }): string | undefined {
    const author = (message.raw as { author?: Record<string, unknown> } | undefined)?.author
    const candidates = [message.senderName, author?.username, author?.nickname, author?.nick]
    return candidates.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim()
  }
}
