import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, screen, shell, Tray } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppSettings, BulkSubscriptionPatch, FavoriteUpdate, MercariItem, NewSubscription, QQBotAccount, QQBotConfig, QQBotTarget, SaveQQBotConfigInput, Subscription } from '../shared/types'
import { MercariClient } from './mercari-client'
import { isSupportedMercariImageUrl, parseMercariItemReference } from './mercari-item-url'
import { MonitorEngine } from './monitor-engine'
import { JsonStore } from './store'
import { QQBotNotifier } from './qq-bot-notifier'
import { SecretStore } from './secret-store'
import { parseQQKeywordCommand, qqKeywordHelp } from './qq-keyword-command'

const currentDir = fileURLToPath(new URL('.', import.meta.url))
let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let engine: MonitorEngine
let mercariClient: MercariClient
let secretStore: SecretStore
const qqNotifiers = new Map<string, QQBotNotifier>()
// Legacy notifier is retained only while loading pre-v0.4.46 state; active robots use qqNotifiers.
let qqNotifier: QQBotNotifier
const activeNotifications = new Set<Notification>()
const imageToastWindows = new Set<BrowserWindow>()

app.setAppUserModelId('com.mercari-pulse.desktop')

// Keep the monitor and its background polling engine in one process. When the
// user starts the app again, Electron routes that launch to this process.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

function showTrayFallback(title: string, body: string, silent: boolean): void {
  if (process.platform !== 'win32' || !tray) return
  tray.displayBalloon({
    title,
    content: body,
    iconType: 'info',
    noSound: silent,
    respectQuietTime: false
  })
}

function showNativeNotification(
  title: string,
  body: string,
  silent: boolean,
  options?: { id?: string; groupId?: string; onClick?: () => void }
): boolean {
  if (!Notification.isSupported()) {
    showTrayFallback(title, body, silent)
    return false
  }

  const notification = new Notification({
    id: options?.id,
    ...(options?.groupId ? {
      groupId: options.groupId,
      groupTitle: 'Mercari Pulse 商品上新'
    } : {}),
    title,
    body,
    silent,
    timeoutType: 'default'
  })
  activeNotifications.add(notification)
  const release = (): void => { activeNotifications.delete(notification) }
  const retentionTimer = setTimeout(release, 60_000)
  retentionTimer.unref()
  notification.once('show', () => console.info(`Notification shown: ${title}`))
  notification.once('close', release)
  notification.once('failed', (_event, error) => {
    console.error(`Notification failed: ${error}`)
    release()
    showTrayFallback(title, body, silent)
  })
  if (options?.onClick) notification.on('click', options.onClick)
  notification.show()
  return true
}

async function showProductNotification(item: MercariItem, settings: AppSettings, isTest = false): Promise<boolean> {
  const imageUrl = settings.notificationIncludeImage && isMercariImageUrl(item.thumbnail)
    ? item.thumbnail
    : undefined
  showImageToast(item, settings, imageUrl, isTest)
  return true
}

function showFavoriteNotification(update: FavoriteUpdate, settings: AppSettings): void {
  const details = [
    update.sold ? '商品已售出' : '',
    update.priceChanged ? `价格变为 ¥${update.favorite.price.toLocaleString('ja-JP')}` : ''
  ].filter(Boolean).join(' · ')
  const item: MercariItem = { ...update.favorite, detectedAt: Date.now(), subscriptionId: 'favorite', keyword: '收藏' }
  if (settings.notificationIncludeImage && isMercariImageUrl(item.thumbnail)) showImageToast(item, settings, item.thumbnail, false)
  else showNativeNotification('收藏商品状态变化', `${item.name}\n${details}`, !settings.soundEnabled, { id: `favorite-${item.id}-${Date.now()}`, onClick: () => void shell.openExternal(item.url) })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character)
}

function isMercariImageUrl(url: string | undefined): url is string {
  return isSupportedMercariImageUrl(url)
}

function showImageToast(item: MercariItem, settings: AppSettings, imageUrl: string | undefined, isTest = false): void {
  const display = screen.getPrimaryDisplay().workArea
  const width = 390
  const hasImage = Boolean(imageUrl)
  const isUpdated = item.discoveryType === 'updated'
  const height = hasImage ? 158 : 128
  const offset = imageToastWindows.size
  const toast = new BrowserWindow({
    width,
    height,
    x: Math.round(display.x + display.width - width - 22),
    y: Math.round(display.y + display.height - height - 22 - offset * (height + 10)),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  imageToastWindows.add(toast)
  const title = escapeHtml(`${isTest ? '测试通知' : isUpdated ? '旧商品更新' : '发现上新'} · ${item.keyword}`)
  const name = escapeHtml(settings.notificationIncludeName ? item.name : '检测到新商品')
  const priceText = settings.notificationIncludePrice ? escapeHtml(`¥${item.price.toLocaleString('ja-JP')}`) : ''
  const url = escapeHtml(item.url)
  const thumbnail = imageUrl ? escapeHtml(imageUrl) : ''
  const updateSummary = isUpdated ? escapeHtml(item.updateSummary ?? '卖家编辑了商品信息') : ''
  const media = hasImage
    ? '<div class="media" id="media">加载图片…</div>'
    : ''
  const loader = hasImage
    ? `<script>const media=document.getElementById('media');const image=new Image();image.alt='商品图片';image.onload=()=>media.replaceChildren(image);image.onerror=()=>media.textContent='图片不可用';image.src='${thumbnail}';</script>`
    : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
    .toast{position:relative;width:390px;height:${height}px;display:flex;gap:13px;padding:11px;color:#eaf5ef;background:linear-gradient(135deg,#10271c,#0b1712 72%);border:1px solid #397454;border-radius:14px;box-shadow:0 14px 42px #000b;cursor:pointer}
    .close{position:absolute;top:8px;right:8px;width:22px;height:22px;border:0;border-radius:50%;color:#b9d2c4;background:#1d3829;cursor:pointer;font-size:17px;line-height:20px}.close:hover{color:#fff;background:#365d46}.media{width:116px;height:116px;flex:none;display:grid;place-items:center;border-radius:9px;overflow:hidden;background:#193325;color:#8ba99a;font-size:11px}.media img{display:block;width:100%;height:100%;object-fit:cover}.copy{min-width:0;display:flex;flex:1;flex-direction:column;padding:2px 20px 2px 0}.tag{color:#6df0ac;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.name{margin-top:9px;line-height:1.35;font-size:13px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.update{margin-top:5px;color:#ffd27d;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bottom{display:flex;align-items:end;justify-content:space-between;gap:8px;margin-top:auto}.price{color:#7df4b5;font-family:monospace;font-size:15px}.hint{color:#749085;font-size:10px}
  </style></head><body><div class="toast" onclick="window.open('${url}','_blank')">${media}<div class="copy"><div class="tag">${title}</div><div class="name">${name}</div>${updateSummary ? `<div class="update">更新：${updateSummary}</div>` : ''}<div class="bottom"><b class="price">${priceText}</b><span class="hint">点击打开商品 ↗</span></div></div><button class="close" title="关闭通知" aria-label="关闭通知" onclick="event.stopPropagation();window.close()">×</button></div>${loader}</body></html>`
  toast.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const parsed = new URL(target)
      if (parsed.protocol === 'https:' && parsed.hostname === 'jp.mercari.com') void shell.openExternal(target)
    } catch { /* Ignore malformed links from the isolated toast. */ }
    return { action: 'deny' }
  })
  toast.webContents.on('did-finish-load', () => toast.showInactive())
  toast.webContents.on('did-fail-load', () => toast.close())
  toast.on('closed', () => imageToastWindows.delete(toast))
  void toast.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const timer = setTimeout(() => { if (!toast.isDestroyed()) toast.close() }, 8_000)
  timer.unref()
}

function broadcast(event: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send('monitor:event', event)
}

function showWindow(): void {
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#08110e',
    title: 'Mercari Pulse',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => {
    if (!engine.snapshot().settings.launchMinimized) window?.show()
  })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`Renderer failed to load (${code}): ${description}`)
    window?.show()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited', details)
  })
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(currentDir, '../renderer/index.html'))
  }
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR42mNgGAWjYBSMglEwCkbB////z2BgYGBg+M/AwMCATQfVQYHhPwMAx6sFHb8vQgcAAAAASUVORK5CYII='
  )
  tray = new Tray(icon)
  tray.setToolTip('Mercari Pulse 正在后台监控')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Mercari Pulse', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', showWindow)
  tray.on('balloon-click', showWindow)
}

function registerIpc(): void {
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('monitor:snapshot', () => engine.snapshot())
  ipcMain.handle('monitor:add', (_event, input: NewSubscription) => engine.add(input))
  ipcMain.handle('monitor:update', (_event, id: string, patch: Partial<Subscription>) => engine.update(id, patch))
  ipcMain.handle('monitor:reorder', (_event, ids: string[]) => engine.reorder(ids))
  ipcMain.handle('monitor:update-all', (_event, patch: BulkSubscriptionPatch) => engine.updateAll(patch))
  ipcMain.handle('monitor:remove', async (_event, id: string, removeRelatedItems: boolean) => {
    const snapshot = engine.snapshot()
    const subscription = snapshot.subscriptions.find((entry) => entry.id === id)
    if (!subscription) throw new Error('未找到该关键词监控')
    const normalizedKeyword = subscription.keyword.toLocaleLowerCase()
    const affectedBots = snapshot.settings.qqBots.map((bot) => ({
      bot,
      targets: bot.targets.filter((target) => target.keywords.some((entry) => entry.keyword.toLocaleLowerCase() === normalizedKeyword))
    })).filter((entry) => entry.targets.length > 0)
    const cleanedBots = snapshot.settings.qqBots.map((bot) => ({
      ...bot,
      targets: bot.targets.map((target) => ({
        ...target,
        keywords: target.keywords.filter((entry) => entry.keyword.toLocaleLowerCase() !== normalizedKeyword)
      }))
    }))
    await engine.remove(id, removeRelatedItems)
    if (affectedBots.length) {
      await engine.updateSettings({ qqBots: cleanedBots })
      const targetCount = affectedBots.reduce((count, entry) => count + entry.targets.length, 0)
      void engine.recordDiagnostic('info', `管理员移除了关键词“${subscription.keyword}”，已从 ${targetCount} 个 QQ 目标的订阅列表中同步移除。`)
      void Promise.allSettled(affectedBots.filter(({ bot }) => bot.enabled).map(({ bot, targets }) =>
        getQQNotifier(bot.id).sendKeywordRemovedByAdmin(subscription.keyword, targets, bot)
      )).then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            void engine.recordDiagnostic('warn', `关键词“${subscription.keyword}”的 QQ 管理员移除通知发送失败：${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`)
          }
        }
      })
    }
    return engine.snapshot()
  })
  ipcMain.handle('monitor:dismiss-item', (_event, subscriptionId: string, itemId: string) => engine.dismissRecentItem(subscriptionId, itemId))
  ipcMain.handle('favorites:add', (_event, item: MercariItem) => engine.addFavorite(item))
  ipcMain.handle('favorites:add-by-reference', async (_event, value: string) => {
    const reference = parseMercariItemReference(value)
    const item = await mercariClient.getItem({
      id: reference.id,
      name: '',
      price: 0,
      thumbnail: '',
      url: reference.url,
      status: 'ITEM_STATUS_UNSPECIFIED',
      itemType: reference.itemType,
      detectedAt: Date.now(),
      subscriptionId: 'favorite',
      keyword: '收藏'
    })
    if (!item?.name || !Number.isFinite(item.price)) throw new Error('未找到该商品：链接可能已失效、商品不存在，或不是 Mercari 商品。')
    return engine.addFavorite(item)
  })
  ipcMain.handle('favorites:remove', (_event, itemId: string) => engine.removeFavorite(itemId))
  ipcMain.handle('monitor:check-now', (_event, id: string) => engine.checkNow(id))
  ipcMain.handle('monitor:check-all-now', () => engine.checkAllNow())
  ipcMain.handle('notifications:test', async () => {
    const snapshot = engine.snapshot()
    const latestItem = snapshot.recentItems[0]
    if (latestItem) {
      return { supported: await showProductNotification(latestItem, snapshot.settings, true) }
    }
    return {
      supported: showNativeNotification(
        'Mercari Pulse 测试通知',
        '后台通知工作正常。添加商品动态后，可在这里预览名称、价格和图片组合。',
        false,
        { id: `test-${Date.now()}`, onClick: showWindow }
      )
    }
  })
  ipcMain.handle('qqbot:get-config', async (): Promise<QQBotConfig> => {
    const settings = engine.snapshot().settings
    return {
      bots: await Promise.all(settings.qqBots.map(async (bot) => ({ ...bot, secretConfigured: await secretStore.has(bot.id) })))
    }
  })
  ipcMain.handle('qqbot:save-config', async (_event, input: SaveQQBotConfigInput): Promise<QQBotConfig> => {
    const settings = engine.snapshot().settings
    const bot = input.bot
    const appId = bot.appId.trim()
    if (bot.enabled && !appId) throw new Error('开启 QQ 推送前请填写 AppID')
    const targets = deduplicateQQTargets(bot.targets.map((target) => ({
      ...target,
      botId: bot.id,
      targetId: target.targetId.trim(),
      label: target.label.trim(),
      enabled: Boolean(target.enabled)
    })).filter((target) => target.targetId))
    const secret = input.appSecret?.trim()
    if (secret) await secretStore.set(bot.id, secret)
    if (bot.enabled && !secret && !await secretStore.has(bot.id)) throw new Error('开启 QQ 推送前请填写 AppSecret')
    const savedBot: QQBotAccount = { ...bot, appId, targets, commandPanelIds: bot.commandPanelIds ?? {} }
    await engine.updateSettings({
      qqBots: settings.qqBots.map((entry) => entry.id === savedBot.id ? savedBot : entry)
    })
    await connectQQBots()
    return { bots: await Promise.all(engine.snapshot().settings.qqBots.map(async (entry) => ({ ...entry, secretConfigured: await secretStore.has(entry.id) }))) }
  })
  ipcMain.handle('qqbot:test', async (_event, botId: string) => {
    const snapshot = engine.snapshot()
    const bot = snapshot.settings.qqBots.find((entry) => entry.id === botId)
    if (!bot) throw new Error('未找到 QQ 机器人配置')
    return getQQNotifier(bot.id).sendTest(bot, snapshot.recentItems[0])
  })
  ipcMain.handle('qqbot:sync-command-panels', async (_event, botId: string) => {
    const settings = engine.snapshot().settings
    const bot = settings.qqBots.find((entry) => entry.id === botId)
    if (!bot) throw new Error('未找到 QQ 机器人配置')
    const result = await getQQNotifier(bot.id).syncCommandPanels(bot)
    await engine.updateSettings({ qqBots: settings.qqBots.map((entry) => entry.id === bot.id ? { ...entry, commandPanelIds: result.panelIds } : entry) })
    return result
  })
  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>) => engine.updateSettings(patch))
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !['jp.mercari.com', 'www.mercari.com'].includes(parsed.hostname)) {
      throw new Error('不允许打开该链接')
    }
    await shell.openExternal(url)
  })
}

function deduplicateQQTargets(targets: QQBotTarget[]): QQBotTarget[] {
  const result = new Map<string, QQBotTarget>()
  for (const target of targets) {
    const normalized: QQBotTarget = { ...target, targetId: target.targetId.trim(), label: target.label.trim() }
    const key = normalized.targetId ? `${normalized.type}:${normalized.targetId}` : `draft:${normalized.id}`
    const previous = result.get(key)
    if (!previous) { result.set(key, normalized); continue }
    const preferred = normalized.label && !previous.label ? normalized : previous
    const other = preferred === previous ? normalized : previous
    const keywords = [...preferred.keywords]
    for (const incoming of other.keywords) {
      const existing = keywords.find((entry) => entry.keyword.toLocaleLowerCase() === incoming.keyword.toLocaleLowerCase())
      if (!existing) keywords.push(incoming)
      else existing.excludeKeywords = [...new Set([...existing.excludeKeywords, ...incoming.excludeKeywords])]
    }
    result.set(key, { ...preferred, enabled: preferred.enabled || other.enabled, detectedNickname: preferred.detectedNickname ?? other.detectedNickname, keywords })
  }
  return [...result.values()]
}

/**
 * QQ 会在收到消息时再次构造 replyTarget；它的临时 id 不一定等于本地
 * 配置中手工创建目标的 id。对同一机器人而言，真正稳定的身份是会话类型
 * 与 openid（targetId），而不是本地记录 id。
 */
function isSameQQTarget(left: QQBotTarget, right: QQBotTarget): boolean {
  return left.id === right.id || (
    left.botId === right.botId &&
    left.type === right.type &&
    Boolean(left.targetId.trim()) &&
    left.targetId.trim() === right.targetId.trim()
  )
}

function replaceBotTargets(botId: string, transform: (targets: QQBotTarget[]) => QQBotTarget[]): Promise<unknown> {
  const settings = engine.snapshot().settings
  return engine.updateSettings({ qqBots: settings.qqBots.map((bot) => bot.id === botId ? { ...bot, targets: deduplicateQQTargets(transform(bot.targets)) } : bot) })
}

function getQQNotifier(botId: string): QQBotNotifier {
  const existing = qqNotifiers.get(botId)
  if (existing) return existing
  const notifier = new QQBotNotifier(secretStore, async (target) => {
    const bot = engine.snapshot().settings.qqBots.find((entry) => entry.id === target.botId)
    if (!bot) return
    const current = bot.targets.find((entry) => isSameQQTarget(entry, target))
    if (!current) {
      await replaceBotTargets(target.botId, (targets) => [...targets, target])
      console.info(`已自动发现 QQ 推送目标：${target.type}:${target.targetId}`)
    } else if (target.detectedNickname && target.detectedNickname !== current.detectedNickname) {
      await replaceBotTargets(target.botId, (targets) => targets.map((entry) => isSameQQTarget(entry, target) ? { ...entry, detectedNickname: target.detectedNickname } : entry))
    }
  }, async (target, content) => {
    const command = parseQQKeywordCommand(content)
    if (!command) return '指令错误 可以先在帮助中查看指令'
    if (command.type === 'help') return qqKeywordHelp()
    const bot = engine.snapshot().settings.qqBots.find((entry) => entry.id === target.botId)
    const currentTarget = bot?.targets.find((entry) => isSameQQTarget(entry, target))
    if (!bot || !currentTarget) return '目标初始化中，请稍后再试。'
    if (command.type === 'bind') {
      await replaceBotTargets(bot.id, (targets) => targets.map((entry) => isSameQQTarget(entry, target) ? { ...entry, label: command.name } : entry))
      return `已绑定当前${target.type === 'group' ? '群聊' : '私聊'}为“${command.name}”。`
    }
    if (!currentTarget.label.trim()) return '请先完成绑定后再使用其他指令。请发送：/bind 名称'
    if (command.type === 'list') return currentTarget.keywords.length ? `你的监控关键词：\n${currentTarget.keywords.map((entry, index) => `${index + 1}. ${entry.keyword}${entry.excludeKeywords.length ? `（屏蔽：${entry.excludeKeywords.join('、')}）` : ''}`).join('\n')}` : `你还没有订阅关键词。\n\n${qqKeywordHelp()}`
    if (command.type === 'clear') {
      if (!command.confirmed) return `将清除当前${target.type === 'group' ? '群聊' : '私聊'}的全部 ${currentTarget.keywords.length} 个关键词订阅。\n如确认，请发送：/clear confirm`
      await replaceBotTargets(bot.id, (targets) => targets.map((entry) => isSameQQTarget(entry, target) ? { ...entry, keywords: [] } : entry))
      return '已清除当前会话的全部关键词订阅。不会影响其他用户、群聊或机器人。'
    }
    const normalized = command.keyword.toLocaleLowerCase()
    if (command.type === 'add') {
      if (currentTarget.keywords.some((entry) => entry.keyword.toLocaleLowerCase() === normalized)) return `你已经订阅了“${command.keyword}”。`
      await replaceBotTargets(bot.id, (targets) => targets.map((entry) => isSameQQTarget(entry, target) ? { ...entry, keywords: [...entry.keywords, { keyword: command.keyword, excludeKeywords: command.excludeKeywords }] } : entry))
      if (!engine.snapshot().subscriptions.some((entry) => entry.keyword.toLocaleLowerCase() === normalized)) await engine.add({ keyword: command.keyword, initialDisplayCount: 2 })
      return `已添加关键词“${command.keyword}”。`
    }
    const matching = currentTarget.keywords.find((entry) => entry.keyword.toLocaleLowerCase() === normalized)
    if (!matching) return `你尚未订阅“${command.keyword}”。`
    if (command.type === 'add-exclude') {
      const additions = command.excludeKeywords.filter((term) => !matching.excludeKeywords.some((known) => known.toLocaleLowerCase() === term.toLocaleLowerCase()))
      if (!additions.length) return `“${matching.keyword}”中的这些屏蔽词已存在。`
      await replaceBotTargets(bot.id, (targets) => targets.map((entry) => isSameQQTarget(entry, target) ? { ...entry, keywords: entry.keywords.map((keyword) => keyword.keyword.toLocaleLowerCase() === normalized ? { ...keyword, excludeKeywords: [...keyword.excludeKeywords, ...additions] } : keyword) } : entry))
      return `已为“${matching.keyword}”添加屏蔽词：${additions.join('、')}。`
    }
    await replaceBotTargets(bot.id, (targets) => targets.map((entry) => isSameQQTarget(entry, target) ? { ...entry, keywords: entry.keywords.filter((keyword) => keyword.keyword.toLocaleLowerCase() !== normalized) } : entry))
    return `已移除关键词“${matching.keyword}”。`
  }, (level, message) => void engine.recordDiagnostic(level, message).catch((error) => console.error(`QQ 诊断日志写入失败：${error}`)),
  (url, init) => net.fetch(url, init))
  qqNotifiers.set(botId, notifier)
  return notifier
}

async function connectQQBots(): Promise<void> {
  const bots = engine.snapshot().settings.qqBots
  for (const [id, notifier] of qqNotifiers) if (!bots.some((bot) => bot.id === id && bot.enabled)) notifier.stop()
  await Promise.all(bots.filter((bot) => bot.enabled).map((bot) => getQQNotifier(bot.id).connect(bot)))
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  const userData = app.getPath('userData')
  secretStore = new SecretStore(join(userData, 'qqbot-secret.dat'))
  mercariClient = new MercariClient((input, init) => net.fetch(input, init))
  engine = new MonitorEngine(mercariClient, new JsonStore(join(userData, 'state.json')))
  await engine.start()
  const storedBots = engine.snapshot().settings.qqBots
  const normalizedBots = storedBots.map((bot) => ({ ...bot, targets: deduplicateQQTargets(bot.targets) }))
  if (normalizedBots.some((bot, index) => bot.targets.length !== storedBots[index]?.targets.length)) {
    await engine.updateSettings({ qqBots: normalizedBots })
  }
  qqNotifier = new QQBotNotifier(secretStore, async (target) => {
    const settings = engine.snapshot().settings
    const existing = settings.qqBotTargets.find((item) => isSameQQTarget(item, target))
    if (!existing) {
      await engine.updateSettings({ qqBotTargets: [...settings.qqBotTargets, target] })
      console.info(`已自动发现 QQ 推送目标：${target.type}:${target.targetId}`)
      return
    }
    if (target.detectedNickname && target.detectedNickname !== existing.detectedNickname) {
      await engine.updateSettings({ qqBotTargets: settings.qqBotTargets.map((item) => isSameQQTarget(item, target)
        ? { ...item, detectedNickname: target.detectedNickname }
        : item) })
    }
  }, async (target, content) => {
    const command = parseQQKeywordCommand(content)
    if (!command) return '指令错误 可以先在帮助中查看指令'
    if (command.type === 'help') return qqKeywordHelp()
    const settings = engine.snapshot().settings
    const currentTarget = settings.qqBotTargets.find((item) => isSameQQTarget(item, target))
    if (!currentTarget) return '目标初始化中，请稍后再试。'
    if (command.type === 'bind') {
      await engine.updateSettings({
        qqBotTargets: settings.qqBotTargets.map((item) => isSameQQTarget(item, target) ? { ...item, label: command.name } : item)
      })
      return `已绑定当前${target.type === 'group' ? '群聊' : '私聊'}为“${command.name}”。`
    }
    if (command.type === 'list') {
      return currentTarget.keywords.length
        ? `你的监控关键词：\n${currentTarget.keywords.map((entry, index) => `${index + 1}. ${entry.keyword}${entry.excludeKeywords.length ? `（屏蔽：${entry.excludeKeywords.join('、')}）` : ''}`).join('\n')}`
        : `你还没有订阅关键词。\n\n${qqKeywordHelp()}`
    }
    if (command.type === 'clear') {
      if (!command.confirmed) return `将清除当前${target.type === 'group' ? '群聊' : '私聊'}的全部 ${currentTarget.keywords.length} 个关键词订阅。\n如确认，请发送：/clear confirm`
      if (!currentTarget.keywords.length) return '你还没有订阅关键词。'
      await engine.updateSettings({
        qqBotTargets: settings.qqBotTargets.map((item) => isSameQQTarget(item, target) ? { ...item, keywords: [] } : item)
      })
      return `已清除当前${target.type === 'group' ? '群聊' : '私聊'}的全部关键词订阅。不会影响其他用户或群聊的订阅。`
    }
    const normalized = command.keyword.toLocaleLowerCase()
    if (command.type === 'add') {
      if (currentTarget.keywords.some((entry) => entry.keyword.toLocaleLowerCase() === normalized)) return `你已经订阅了“${command.keyword}”。如需调整屏蔽词，请先移除后重新添加。`
      const subscription = { keyword: command.keyword, excludeKeywords: command.excludeKeywords }
      const nextTargets = settings.qqBotTargets.map((item) => isSameQQTarget(item, target) ? { ...item, keywords: [...item.keywords, subscription] } : item)
      await engine.updateSettings({ qqBotTargets: nextTargets })
      if (!engine.snapshot().subscriptions.some((subscription) => subscription.keyword.toLocaleLowerCase() === normalized)) {
        await engine.add({ keyword: command.keyword, initialDisplayCount: 2 })
      }
      return `已添加关键词“${command.keyword}”。${command.excludeKeywords.length ? `\n已屏蔽：${command.excludeKeywords.join('、')}` : ''}\n后续仅向当前${target.type === 'group' ? '群聊' : '私聊'}推送该关键词的上新商品。`
    }
    const matchingKeyword = currentTarget.keywords.find((entry) => entry.keyword.toLocaleLowerCase() === normalized)
    if (!matchingKeyword) return `你尚未订阅“${command.keyword}”。`
    if (command.type === 'add-exclude') {
      const existing = new Set(matchingKeyword.excludeKeywords.map((term) => term.toLocaleLowerCase()))
      const additions = command.excludeKeywords.filter((term) => !existing.has(term.toLocaleLowerCase()))
      if (!additions.length) return `“${matchingKeyword.keyword}”中的这些屏蔽词已存在。`
      await engine.updateSettings({
        qqBotTargets: settings.qqBotTargets.map((item) => isSameQQTarget(item, target)
          ? { ...item, keywords: item.keywords.map((entry) => entry.keyword.toLocaleLowerCase() === normalized
            ? { ...entry, excludeKeywords: [...entry.excludeKeywords, ...additions] }
            : entry) }
          : item)
      })
      return `已为“${matchingKeyword.keyword}”添加屏蔽词：${additions.join('、')}。`
    }
    await engine.updateSettings({
      qqBotTargets: settings.qqBotTargets.map((item) => isSameQQTarget(item, target) ? { ...item, keywords: item.keywords.filter((entry) => entry.keyword.toLocaleLowerCase() !== normalized) } : item)
    })
      return `已移除关键词“${matchingKeyword.keyword}”，后续不会再向当前${target.type === 'group' ? '群聊' : '私聊'}推送相关商品。`
    }, (level, message) => {
      void engine.recordDiagnostic(level, message).catch((error) => console.error(`QQ 诊断日志写入失败：${error}`))
    }, (url, init) => net.fetch(url, init))
  engine.on('snapshot', (snapshot) => broadcast({ type: 'snapshot', snapshot }))
  engine.on('newItem', (item) => {
    broadcast({ type: 'new-item', item })
    const settings = engine.snapshot().settings
    const subscription = engine.snapshot().subscriptions.find((candidate) => candidate.id === item.subscriptionId)
    if (settings.notificationsEnabled && subscription?.windowsNotificationsEnabled !== false) {
      void showProductNotification(item, settings)
    }
    void Promise.allSettled(settings.qqBots.filter((bot) => bot.enabled).map((bot) => getQQNotifier(bot.id).sendItem(item, bot))).then((results) => {
      for (const result of results) if (result.status === 'rejected') console.error(`QQ 推送失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
    })
  })
  engine.on('favoriteUpdate', (favoriteUpdate) => {
    broadcast({ type: 'favorite-update', favoriteUpdate })
    if (engine.snapshot().settings.notificationsEnabled) showFavoriteNotification(favoriteUpdate, engine.snapshot().settings)
  })
  registerIpc()
  void connectQQBots().catch((error) => console.error(`QQ 机器人自动连接失败：${error instanceof Error ? error.message : String(error)}`))
  createWindow()
  createTray()

  app.on('activate', () => window ? showWindow() : createWindow())
})

app.on('second-instance', () => {
  showWindow()
})

app.on('before-quit', () => {
  quitting = true
  engine?.stop()
  qqNotifier?.stop()
  for (const notifier of qqNotifiers.values()) notifier.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') window = null
})
