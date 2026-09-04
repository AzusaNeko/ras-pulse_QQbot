import { useEffect, useMemo, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import type { AppSnapshot, BarkConfig, BarkDeviceConfig, BulkSubscriptionPatch, FavoriteItem, LogEntry, MercariItem, MonitorStatus, NewSubscription, QQBotAccount, QQBotConfig, QQBotTarget, SaveBarkConfigInput, Subscription } from '../../shared/types'
import { isSoldMercariStatus } from '../../shared/mercari-status'

const statusLabels: Record<MonitorStatus, string> = {
  watching: '监听中', paused: '已暂停', checking: '检查中', backoff: '重试中', error: '异常'
}

function timeAgo(timestamp?: number): string {
  if (!timestamp) return '尚未检查'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function price(value: number): string {
  return `¥${value.toLocaleString('ja-JP')}`
}

function logTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function mercariTimestamp(value?: number): number | undefined {
  if (!value) return undefined
  return value > 10_000_000_000 ? value : value * 1_000
}

function listingTimes(item: MercariItem): { search: string; original: string } {
  const rankedAt = mercariTimestamp(item.updatedAt)
  const createdAt = mercariTimestamp(item.createdAt)
  return {
    search: rankedAt ? `搜索排序参考：${timeAgo(rankedAt)}` : '搜索排序：Mercari 新しい順',
    original: createdAt ? `原始上架：${timeAgo(createdAt)}` : `检测：${timeAgo(item.detectedAt)}`
  }
}

function ItemCard({ item, favorite, onFavorite, onDelete }: { item: MercariItem; favorite: boolean; onFavorite: (item: MercariItem) => void; onDelete: (item: MercariItem) => void }): JSX.Element | null {
  const openItem = (): void => { void window.mercariPulse.openExternal(item.url) }
  const [imageStatus, setImageStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const sold = isSoldMercariStatus(item.status)
  const times = listingTimes(item)
  if (!item.thumbnail || imageStatus === 'failed') return null
  return (
    <article className={`item-card ${item.isAuction === true ? 'auction-item' : ''} ${imageStatus === 'ready' ? '' : 'item-card-loading'}`} role="button" tabIndex={imageStatus === 'ready' ? 0 : -1} aria-hidden={imageStatus !== 'ready'} onClick={imageStatus === 'ready' ? openItem : undefined} onKeyDown={(event) => { if (imageStatus === 'ready' && event.key === 'Enter') openItem() }}>
      <div className="item-card-actions">
        <button className={`item-favorite ${favorite ? 'active' : ''}`} title={favorite ? '已收藏' : '收藏并监控状态'} aria-label="收藏商品" onClick={(event) => { event.stopPropagation(); onFavorite(item) }}>♥</button>
        <button className="item-delete" title="从商品动态中删除" aria-label="删除商品动态" onClick={(event) => { event.stopPropagation(); onDelete(item) }}>×</button>
      </div>
      <div className="item-image-wrap">
        <img src={item.thumbnail} alt="" onLoad={() => setImageStatus('ready')} onError={() => setImageStatus('failed')} />
      </div>
      <div className="item-copy">
        <div className="item-topline"><span className={`keyword-pill ${item.discoveryType === 'updated' ? 'updated' : item.discoveryType === 'offline' ? 'offline' : ''}`}>{item.keyword} · {item.discoveryType === 'baseline' ? '初始结果' : item.discoveryType === 'updated' ? '旧商品更新' : item.discoveryType === 'offline' ? '离线期间上新' : '上新'}</span><span className="item-times"><time title="Mercari 搜索结果使用的排序参考时间；卖家编辑旧商品时可能变新。">{times.search}</time><time>{times.original}</time></span></div>
        <strong>{item.name}</strong>
        {item.discoveryType === 'updated' && <small className="item-update-summary">更新：{item.updateSummary ?? '卖家编辑了商品信息'}</small>}
        <div className="item-bottom"><div><b>{price(item.price)}</b><i className={`sale-type ${item.isAuction === true ? 'auction' : ''}`}>{item.isAuction === true ? '拍卖商品' : item.isAuction === false ? '直售商品' : '煤炉直售类'}</i>{sold && <i className="listing-status sold">已售</i>}</div><span>打开商品 ↗</span></div>
      </div>
    </article>
  )
}

function BulkSubscriptionManager({ count, onApply, onRefresh }: { count: number; onApply: (patch: BulkSubscriptionPatch) => Promise<boolean>; onRefresh: () => Promise<void> }): JSX.Element {
  const [interval, setIntervalValue] = useState('')
  const [updates, setUpdates] = useState('')
  const [notifications, setNotifications] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const hasChanges = Boolean(interval || updates || notifications)
  const apply = async (): Promise<void> => {
    const patch: BulkSubscriptionPatch = {}
    if (interval) patch.intervalMs = Number(interval)
    if (updates) patch.monitorUpdates = updates === 'on'
    if (notifications) patch.windowsNotificationsEnabled = notifications === 'on'
    setBusy(true)
    try {
      if (await onApply(patch)) {
        setIntervalValue('')
        setUpdates('')
        setNotifications('')
      }
    } finally { setBusy(false) }
  }
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try { await onRefresh() } finally { setRefreshing(false) }
  }
  return <div className="bulk-task-manager">
    <b>统一管理</b>
    <label>查询时间<select value={interval} onChange={(event) => setIntervalValue(event.target.value)}><option value="">保持不变</option><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="5000">5 秒</option><option value="10000">10 秒</option></select></label>
    <label>旧商品更新<select value={updates} onChange={(event) => setUpdates(event.target.value)}><option value="">保持不变</option><option value="on">全部开启</option><option value="off">全部关闭</option></select></label>
    <label>Windows 弹窗<select value={notifications} onChange={(event) => setNotifications(event.target.value)}><option value="">保持不变</option><option value="on">全部开启</option><option value="off">全部关闭</option></select></label>
    <button className="secondary-button" disabled={!count || refreshing} onClick={() => void refresh()}>{refreshing ? '刷新中…' : '统一刷新'}</button>
    <button className="secondary-button" disabled={!count || !hasChanges || busy || refreshing} onClick={() => void apply()}>{busy ? '应用中…' : `应用到 ${count} 个任务`}</button>
    <small>0.1/0.5 秒模式需在单个关键词中设置</small>
  </div>
}

function SubscriptionCard({ item, qqTargets, ultraFastAtCapacity, fastAtCapacity, initialSyncing, dragging, dropTarget, onDragStart, onDragEnter, onDragEnd, onDrop, onChange, onResync, onDelete, onCheck }: {
  item: Subscription
  qqTargets: QQBotTarget[]
  ultraFastAtCapacity: boolean
  fastAtCapacity: boolean
  initialSyncing: boolean
  dragging: boolean
  dropTarget: boolean
  onDragStart: (id: string) => void
  onDragEnter: (id: string) => void
  onDragEnd: () => void
  onDrop: (id: string) => void
  onChange: (id: string, patch: Partial<Subscription>) => void
  onResync: (id: string) => void | Promise<void>
  onDelete: (id: string) => void
  onCheck: (id: string) => void
}): JSX.Element {
  const [addingExclusions, setAddingExclusions] = useState(false)
  const [excludeInput, setExcludeInput] = useState('')
  const [detailsExpanded, setDetailsExpanded] = useState(true)
  const addExclude = (): void => {
    const existing = item.excludeKeyword.split(/[，,、\n]/).map((term) => term.trim()).filter(Boolean)
    const known = new Set(existing.map((term) => term.toLocaleLowerCase()))
    const additions = excludeInput.split(/[，,、\n]/).map((term) => term.trim()).filter((term) => term && !known.has(term.toLocaleLowerCase()))
    if (!additions.length) { setAddingExclusions(false); return }
    onChange(item.id, { excludeKeyword: [...existing, ...additions].join('、') })
    setExcludeInput('')
    setAddingExclusions(false)
  }
  const qqSubscribers = qqTargets.filter((target) => target.keywords.some((keyword) => keyword.keyword.toLocaleLowerCase() === item.keyword.toLocaleLowerCase()))
  return (
    <article className={`subscription-card status-${item.status} ${item.error ? 'has-error' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-target' : ''}`} onDragEnter={() => onDragEnter(item.id)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => { event.preventDefault(); onDrop(item.id) }}>
      <div className="subscription-main">
        <button className="drag-handle" type="button" draggable title="拖动调整任务排序" aria-label={`拖动调整“${item.keyword}”的排序`} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); const card = event.currentTarget.closest<HTMLElement>('.subscription-card'); if (card) event.dataTransfer.setDragImage(card, Math.min(card.clientWidth / 2, 180), Math.min(card.clientHeight / 2, 42)); onDragStart(item.id) }} onDragEnd={onDragEnd}>⠿</button>
        <div className="status-orbit"><span /></div>
        <div className="subscription-copy">
          <div className="subscription-title"><h3>{item.keyword}</h3><span className={`status-label ${initialSyncing ? 'initial-sync' : ''}`}>{initialSyncing ? '初始同步中' : item.cooldownUntil && item.cooldownUntil > Date.now() ? '冷却中' : statusLabels[item.status]}</span></div>
          <small title={item.error}>{item.error ? item.error : initialSyncing ? '正在确认首次展示商品，期间不会发送通知' : `上次成功：${timeAgo(item.lastSuccessAt)}`}</small>
          {detailsExpanded && <div className="subscription-details">
            <p>
              {item.excludeKeyword && `排除：${item.excludeKeyword} · `}
              {item.minPrice != null || item.maxPrice != null
                ? `${item.minPrice ? price(item.minPrice) : '不限'} — ${item.maxPrice ? price(item.maxPrice) : '不限'} · ` : ''}
              首次 {item.initialDisplayCount ?? 2} 条 · 每 <select className="inline-interval" value={item.intervalMs} onChange={(event) => onChange(item.id, { intervalMs: Number(event.target.value) })}><option value="100" disabled={item.intervalMs !== 100 && ultraFastAtCapacity}>0.1 秒（极速）</option><option value="500" disabled={item.intervalMs !== 500 && fastAtCapacity}>0.5 秒（快速）</option><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="5000">5 秒</option><option value="10000">10 秒</option></select> · <label className="inline-check"><input type="checkbox" checked={item.monitorUpdates} onChange={(event) => onChange(item.id, { monitorUpdates: event.target.checked })} />旧商品更新</label> · <label className="inline-check" title="关闭后仍会监控、显示商品动态和 QQ 推送，但不会显示 Windows 右下角通知"><input type="checkbox" checked={item.windowsNotificationsEnabled !== false} onChange={(event) => onChange(item.id, { windowsNotificationsEnabled: event.target.checked })} />Windows 弹窗</label>
            </p>
            {qqSubscribers.length > 0 && <div className="subscription-qq-targets"><b>QQ 推送：</b>{qqSubscribers.map((target) => <span key={target.id} title={target.targetId}>{target.type === 'group' ? '群聊' : '私聊'} · {target.label || target.detectedNickname || target.targetId}{target.detectedNickname && target.label ? `（${target.detectedNickname}）` : ''}{!target.enabled ? '（已停用）' : ''}</span>)}</div>}
            {addingExclusions && <form className="exclude-editor" onSubmit={(event) => { event.preventDefault(); addExclude() }}>
              <input autoFocus value={excludeInput} onChange={(event) => setExcludeInput(event.target.value)} placeholder="输入屏蔽词，多个用逗号分隔" />
              <button className="secondary-button" type="submit" disabled={!excludeInput.trim()}>添加</button>
              <button className="text-button" type="button" onClick={() => { setExcludeInput(''); setAddingExclusions(false) }}>取消</button>
            </form>}
          </div>}
        </div>
      </div>
      <div className="card-actions">
        <button className={`details-toggle ${detailsExpanded ? 'expanded' : ''}`} title={detailsExpanded ? '收起详细信息' : '展开详细信息'} aria-expanded={detailsExpanded} onClick={() => setDetailsExpanded((value) => !value)}><span>{detailsExpanded ? '收起' : '详情'}</span><i>{detailsExpanded ? '⌃' : '⌄'}</i></button>
        <button className="icon-button" title="添加屏蔽词" onClick={() => { setDetailsExpanded(true); setAddingExclusions(true) }}>⊘</button>
        <button className="icon-button" title="追加同步最新初始结果（不发送通知）" onClick={() => void onResync(item.id)}>⌁</button>
        <button className="icon-button" title="立即检查" onClick={() => onCheck(item.id)}>↻</button>
        <label className="switch" title={item.enabled ? '暂停' : '启用'}>
          <input type="checkbox" checked={item.enabled} onChange={(event) => onChange(item.id, { enabled: event.target.checked, status: event.target.checked ? 'watching' : 'paused' })} />
          <span />
        </label>
      </div>
      <button className="subscription-delete" title="删除监控任务" aria-label={`删除“${item.keyword}”监控任务`} onClick={() => onDelete(item.id)}>×</button>
    </article>
  )
}

function AddFavoriteByReference({ onAdd }: { onAdd: (value: string) => Promise<boolean> }): JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!value.trim()) return
    setBusy(true)
    try { if (await onAdd(value)) setValue('') } finally { setBusy(false) }
  }
  return <form className="favorite-reference-form" onSubmit={(event) => void submit(event)}>
    <div><b>通过链接添加收藏</b><small>支持日本 Mercari 商品网址，或以 <code>m</code> 开头的商品 ID；添加前会验证商品是否有效。</small></div>
    <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="粘贴商品网址或 ID，例如 m12345678901" />
    <button className="secondary-button" disabled={!value.trim() || busy}>{busy ? '验证中…' : '验证并收藏'}</button>
  </form>
}

function FavoriteCard({ item, onRemove }: { item: FavoriteItem; onRemove: (id: string) => void }): JSX.Element {
  const sold = isSoldMercariStatus(item.status)
  const priceChange = item.previousPrice == null ? undefined : item.price - item.previousPrice
  const priceChangeLabel = priceChange == null || priceChange === 0 ? undefined : priceChange < 0 ? '降价' : '涨价'
  return <article className={`favorite-card ${sold ? 'sold' : ''}`} onClick={() => void window.mercariPulse.openExternal(item.url)}>
    <img src={item.thumbnail} alt="" />
    <div><span>{sold ? '已售出' : '收藏监控中'} · {item.lastCheckedAt ? timeAgo(item.lastCheckedAt) : '等待检查'}</span><strong>{item.name}</strong><b>{price(item.price)} <i className={`sale-type ${item.isAuction === true ? 'auction' : ''}`}>{item.isAuction === true ? '拍卖' : item.isAuction === false ? '直售' : '煤炉直售类'}</i>{sold && <i className="listing-status sold">已售</i>}</b>{priceChangeLabel && <small className={`favorite-price-change ${priceChange! < 0 ? 'decrease' : 'increase'}`}>{priceChangeLabel}：{price(item.previousPrice!)} → {price(item.price)}</small>}{item.error && <small>{item.error}</small>}</div>
    <button className="icon-button danger" title="取消收藏" onClick={(event) => { event.stopPropagation(); onRemove(item.id) }}>×</button>
  </article>
}

function AddMonitor({ defaultInterval, onAdd }: { defaultInterval: number; onAdd: (value: NewSubscription) => Promise<void> }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [excludeKeyword, setExcludeKeyword] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [initialDisplayCount, setInitialDisplayCount] = useState('2')
  const [monitorUpdates, setMonitorUpdates] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showExcludeHelp, setShowExcludeHelp] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!keyword.trim()) return
    setBusy(true)
    try {
      await onAdd({
        keyword,
        excludeKeyword,
        minPrice: minPrice ? Number(minPrice) : undefined,
        maxPrice: maxPrice ? Number(maxPrice) : undefined,
        intervalMs: defaultInterval,
        initialDisplayCount: Number(initialDisplayCount),
        monitorUpdates
      })
      setKeyword(''); setExcludeKeyword(''); setMinPrice(''); setMaxPrice(''); setMonitorUpdates(true); setExpanded(false)
    } finally { setBusy(false) }
  }

  return <>
    <form className={`add-monitor ${expanded ? 'expanded' : ''}`} onSubmit={(event) => void submit(event)}>
      <div className="search-row">
        <span className="search-icon">⌕</span>
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} onFocus={() => setExpanded(true)} placeholder="输入想监控的商品关键词…" autoFocus />
        <button className="primary" disabled={!keyword.trim() || busy}>{busy ? '添加中…' : '开始监控'}</button>
      </div>
      {expanded && <div className="advanced-row">
        <label className="exclude-field"><span className="exclude-field-title">排除词<button className="exclude-help-button" type="button" aria-label="查看屏蔽词使用方法" title="查看屏蔽词使用方法" onClick={() => setShowExcludeHelp(true)}>?</button></span><input value={excludeKeyword} onChange={(event) => setExcludeKeyword(event.target.value)} placeholder="例：故障、仅盒" /></label>
        <label>首次展示<select value={initialDisplayCount} onChange={(event) => setInitialDisplayCount(event.target.value)}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count} 条</option>)}</select></label>
        <label>最低价<input type="number" min="0" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="不限" /></label>
        <label>最高价<input type="number" min="0" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="不限" /></label>
        <label className="monitor-updates-check"><input type="checkbox" checked={monitorUpdates} onChange={(event) => setMonitorUpdates(event.target.checked)} />监控旧商品编辑</label>
        <button type="button" className="text-button" onClick={() => setExpanded(false)}>收起</button>
      </div>}
    </form>
    {showExcludeHelp && <ExcludeKeywordHelpDialog onClose={() => setShowExcludeHelp(false)} />}
  </>
}

function ExcludeKeywordHelpDialog({ onClose }: { onClose: () => void }): JSX.Element {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="confirm-dialog exclusion-help-dialog" role="dialog" aria-modal="true" aria-labelledby="exclude-help-title" onMouseDown={(event) => event.stopPropagation()}>
      <p className="eyebrow">EXCLUDE KEYWORDS</p>
      <h2 id="exclude-help-title">屏蔽词使用方法</h2>
      <p>支持英文逗号 <code>,</code>、中文逗号 <code>，</code>、顿号 <code>、</code> 或换行分隔多个词。商品标题命中任意一个屏蔽词，就不会显示或推送。</p>
      <div className="exclude-help-examples"><b>使用案例</b><code>バンドリーノ、バンドリエール</code><code>故障, 仅盒</code><code>バンドリーノ{`\n`}バンドリエール</code></div>
      <div className="confirm-dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>知道了</button></div>
    </section>
  </div>
}

function LogPanel({ logs }: { logs: LogEntry[] }): JSX.Element {
  const [level, setLevel] = useState<'all' | LogEntry['level']>('all')
  const visible = logs.filter((entry) => level === 'all' || entry.level === level)
  return <>
    <header><div><p className="eyebrow">RUNTIME LOGS</p><h1>运行日志</h1><p>保留最近 500 条关键运行事件，重启后仍可查看。</p></div><div className="live-chip"><i /> {logs.length} 条</div></header>
    <section className="log-panel">
      <div className="log-toolbar"><div className="item-filters"><button className={level === 'all' ? 'active' : ''} onClick={() => setLevel('all')}>全部</button><button className={level === 'debug' ? 'active' : ''} onClick={() => setLevel('debug')}>调试</button><button className={level === 'info' ? 'active' : ''} onClick={() => setLevel('info')}>信息</button><button className={level === 'warn' ? 'active' : ''} onClick={() => setLevel('warn')}>警告</button><button className={level === 'error' ? 'active' : ''} onClick={() => setLevel('error')}>错误</button></div><span>最新记录在前</span></div>
      <div className="log-list">{visible.map((entry) => <div className={`log-entry ${entry.level}`} key={entry.id}><time>{logTime(entry.timestamp)}</time><b>{entry.level === 'debug' ? '调试' : entry.level === 'info' ? '信息' : entry.level === 'warn' ? '警告' : '错误'}</b><span>{entry.message}</span></div>)}{!visible.length && <div className="empty-state compact"><b>暂无日志</b><span>监控运行后，关键事件会显示在这里。</span></div>}</div>
    </section>
  </>
}

function RemoveSubscriptionDialog({ subscription, onCancel, onRemove }: {
  subscription: Subscription
  onCancel: () => void
  onRemove: (removeRelatedItems: boolean) => void
}): JSX.Element {
  return <div className="dialog-backdrop" role="presentation">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-subscription-title">
      <p className="eyebrow">取消监控</p>
      <h2 id="remove-subscription-title">取消“{subscription.keyword}”的监控？</h2>
      <p>你可以仅停止该关键词的监控，或同时清除它已有的商品动态。此操作不会影响其他关键词。</p>
      <div className="confirm-dialog-actions">
        <button className="text-button" type="button" onClick={onCancel}>返回</button>
        <button className="secondary-button" type="button" onClick={() => onRemove(false)}>仅取消监控</button>
        <button className="danger-button" type="button" onClick={() => onRemove(true)}>取消并清理动态</button>
      </div>
    </section>
  </div>
}

function QQBotPanel({ bot, secretConfigured, onSave, onTest, onSyncPanels }: {
  bot: QQBotAccount
  secretConfigured: boolean
  onSave: (value: { bot: QQBotAccount; appSecret?: string }) => Promise<void>
  onTest: () => Promise<void>
  onSyncPanels: () => Promise<void>
}): JSX.Element {
  const [enabled, setEnabled] = useState(bot.enabled)
  const [appId, setAppId] = useState(bot.appId)
  const [secret, setSecret] = useState('')
  const [targets, setTargets] = useState(bot.targets)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setEnabled(bot.enabled); setAppId(bot.appId); setTargets(bot.targets)
  }, [bot])

  const changeTarget = (id: string, patch: Partial<QQBotTarget>): void => {
    setTargets((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }
  const addTarget = (): void => setTargets((items) => [...items, {
    id: `${bot.id}:${crypto.randomUUID()}`, botId: bot.id, type: 'group', targetId: '', label: '', enabled: true, keywords: []
  }])
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSave({ bot: { ...bot, enabled, appId, targets }, appSecret: secret || undefined })
      setSecret('')
    } finally { setBusy(false) }
  }

  return <section className="qq-panel">
    <div className="qq-panel-heading"><div><p className="eyebrow">QQ BOT</p><h2>QQ 机器人推送</h2><span>AppSecret 使用 Windows 加密存储，不会显示或上传到 GitHub。</span></div><label className="switch" title={enabled ? '关闭 QQ 推送' : '开启 QQ 推送'}><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span /></label></div>
    <div className="qq-fields">
      <label>AppID<input value={appId} onChange={(event) => setAppId(event.target.value)} inputMode="numeric" placeholder="QQ 开放平台 AppID" /></label>
      <label>AppSecret {secretConfigured && <em>已保存</em>}<input value={secret} onChange={(event) => setSecret(event.target.value)} type="password" autoComplete="new-password" placeholder={secretConfigured ? '留空则保留当前密钥' : '仅保存到本机'} /></label>
    </div>
    <div className="qq-target-heading"><div><b>推送目标</b><span>填写 QQ 开放平台提供的 openid / group_openid，不是 QQ 号或群号。</span></div><button className="secondary-button" type="button" onClick={addTarget}>+ 添加目标</button></div>
    <div className="qq-targets">
      {targets.map((target) => <div className="qq-target" key={target.id}>
        <label className="switch compact-switch" title={target.enabled ? '停用目标' : '启用目标'}><input type="checkbox" checked={target.enabled} onChange={(event) => changeTarget(target.id, { enabled: event.target.checked })} /><span /></label>
        <select value={target.type} onChange={(event) => changeTarget(target.id, { type: event.target.value as QQBotTarget['type'] })}><option value="group">普通 QQ 群</option><option value="c2c">QQ 私聊</option></select>
        <input value={target.label} onChange={(event) => changeTarget(target.id, { label: event.target.value })} placeholder="备注（可选）" />
        <span className="qq-target-nickname" title={target.detectedNickname ?? 'QQ 未在事件中提供昵称'}>{target.detectedNickname ? `昵称：${target.detectedNickname}` : '昵称：等待 QQ 提供'}</span>
        <input value={target.targetId} onChange={(event) => changeTarget(target.id, { targetId: event.target.value })} placeholder={target.type === 'group' ? 'group_openid' : 'openid'} />
        <button className="icon-button danger" type="button" title="移除目标" onClick={() => setTargets((items) => items.filter((item) => item.id !== target.id))}>×</button>
      </div>)}
      {!targets.length && <div className="qq-empty">保存开启后，私聊机器人或在群内 @ 机器人一次，软件会自动发现并添加对应目标。</div>}
    </div>
    <p className="qq-command-hint">机器人指令：<code>/bind</code> 绑定会话、<code>/add</code> 添加监控、<code>/remove</code> 移除监控、<code>/list</code> 查看订阅、<code>/clear</code> 清空订阅、<code>/help</code> 查看完整说明。屏蔽词使用 <code>/add 关键词 exclude 屏蔽词</code>。</p>
    <div className="qq-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存 QQ 配置'}</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void onSyncPanels()}>同步 QQ 指令面板</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void onTest()}>发送 QQ 测试消息</button></div>
  </section>
}

function QQBotSettings({ config, onChange, onNotice }: { config: QQBotConfig; onChange: (config: QQBotConfig) => void; onNotice: (message: string) => void }): JSX.Element {
  const addBot = (): void => onChange({ ...config, bots: [...config.bots, { id: crypto.randomUUID(), enabled: false, appId: '', targets: [], commandPanelIds: {}, secretConfigured: false }] })
  const saveBot = async (value: { bot: QQBotAccount; appSecret?: string }): Promise<void> => {
    try { const next = await window.mercariPulse.saveQQBotConfig(value); onChange(next); onNotice('QQ 机器人配置已保存') } catch (error) { onNotice(error instanceof Error ? error.message : String(error)) }
  }
  return <>
    <header><div><p className="eyebrow">QQ BOT</p><h1>QQ机器人设置</h1><p>每个机器人独立保存 AppSecret、推送目标、关键词订阅及指令面板。</p></div><button className="primary" type="button" onClick={addBot}>+ 添加 QQ 机器人</button></header>
    {config.bots.map((bot) => <QQBotPanel key={bot.id} bot={bot} secretConfigured={bot.secretConfigured} onSave={saveBot} onTest={async () => {
      try { const result = await window.mercariPulse.testQQBot(bot.id); onNotice(result.failed ? `QQ 测试完成：成功 ${result.delivered}，失败 ${result.failed}` : `QQ 测试消息已发送至 ${result.delivered} 个目标`) } catch (error) { onNotice(error instanceof Error ? error.message : String(error)) }
    }} onSyncPanels={async () => {
      try { const result = await window.mercariPulse.syncQQCommandPanels(bot.id); onNotice(`QQ 指令面板已同步：新建 ${result.created} 个，更新 ${result.updated} 个。`) } catch (error) { onNotice(error instanceof Error ? error.message : String(error)) }
    }} />)}
    {!config.bots.length && <div className="empty-state compact"><b>还没有 QQ 机器人</b><span>点击“添加 QQ 机器人”后填写 AppID 与 AppSecret。</span></div>}
  </>
}

function BarkSettingsPanel({ config, onChange, onNotice }: { config: BarkConfig; onChange: (config: BarkConfig) => void; onNotice: (message: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(config)
  const [deviceKeys, setDeviceKeys] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string>()

  useEffect(() => {
    setDraft(config)
    setDeviceKeys({})
  }, [config])

  const changeDevice = (id: string, patch: Partial<BarkDeviceConfig>): void => {
    setDraft((value) => ({ ...value, devices: value.devices.map((device) => device.id === id ? { ...device, ...patch } : device) }))
  }
  const addDevice = (): void => setDraft((value) => ({
    ...value,
    devices: [...value.devices, { id: crypto.randomUUID(), name: '', enabled: true, keyConfigured: false }]
  }))
  const save = async (): Promise<BarkConfig | undefined> => {
    setBusy(true)
    try {
      const input: SaveBarkConfigInput = {
        enabled: draft.enabled,
        serverUrl: draft.serverUrl,
        level: draft.level,
        includeImage: draft.includeImage,
        devices: draft.devices.map(({ keyConfigured: _keyConfigured, ...device }) => ({
          ...device,
          deviceKey: deviceKeys[device.id]?.trim() || undefined
        }))
      }
      const saved = await window.mercariPulse.saveBarkConfig(input)
      onChange(saved)
      onNotice('Bark 手机推送配置已保存')
      return saved
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
      return undefined
    } finally { setBusy(false) }
  }
  const removeDevice = async (deviceId: string): Promise<void> => {
    if (!config.devices.some((device) => device.id === deviceId)) {
      setDraft((value) => ({ ...value, devices: value.devices.filter((device) => device.id !== deviceId) }))
      setDeviceKeys((keys) => { const next = { ...keys }; delete next[deviceId]; return next })
      return
    }
    try {
      const saved = await window.mercariPulse.removeBarkDevice(deviceId)
      onChange(saved)
      onNotice('Bark 设备已删除')
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)) }
  }
  const testDevice = async (deviceId: string): Promise<void> => {
    const saved = await save()
    if (!saved?.devices.some((device) => device.id === deviceId && device.keyConfigured)) return
    setTestingId(deviceId)
    try {
      const result = await window.mercariPulse.testBarkDevice(deviceId)
      onNotice(`Bark 测试通知已发送至“${result.deviceName}”`)
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)) } finally { setTestingId(undefined) }
  }
  const insecure = draft.serverUrl.trim().toLocaleLowerCase().startsWith('http://')

  return <section className="bark-panel">
    <div className="bark-panel-heading"><div><p className="eyebrow">BARK PUSH</p><h2>Bark 手机推送</h2><span>向所有启用的 iPhone 广播上新和收藏变化；deviceKey 使用 Windows 加密存储。</span></div><label className="switch" title={draft.enabled ? '关闭 Bark 手机推送' : '开启 Bark 手机推送'}><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.checked }))} /><span /></label></div>
    <div className="bark-global-fields">
      <label>Bark Server<input value={draft.serverUrl} onChange={(event) => setDraft((value) => ({ ...value, serverUrl: event.target.value }))} placeholder="https://api.day.app" /></label>
      <label>通知等级<select value={draft.level} onChange={(event) => setDraft((value) => ({ ...value, level: event.target.value as BarkConfig['level'] }))}><option value="active">普通通知</option><option value="timeSensitive">时效性通知</option></select></label>
      <label className="bark-image-check"><input type="checkbox" checked={draft.includeImage} onChange={(event) => setDraft((value) => ({ ...value, includeImage: event.target.checked }))} /> 显示商品图片</label>
    </div>
    {insecure && <div className="bark-http-warning"><b>明文连接警告</b><span>当前 Server 使用 HTTP，deviceKey 与通知内容会以明文方式传输。</span></div>}
    <div className="bark-device-heading"><div><b>Bark 设备</b><span>每台 iPhone 在 Bark App 中复制自己的推送 Key。</span></div><button className="secondary-button" type="button" onClick={addDevice}>+ 添加设备</button></div>
    <div className="bark-devices">
      {draft.devices.map((device) => <div className="bark-device" key={device.id}>
        <label className="switch compact-switch" title={device.enabled ? '停用设备' : '启用设备'}><input type="checkbox" checked={device.enabled} onChange={(event) => changeDevice(device.id, { enabled: event.target.checked })} /><span /></label>
        <input value={device.name} onChange={(event) => changeDevice(device.id, { name: event.target.value })} placeholder="设备名称（可选）" />
        <label className="bark-key-field"><span>deviceKey {device.keyConfigured && <em>已保存</em>}</span><input type="password" autoComplete="new-password" value={deviceKeys[device.id] ?? ''} onChange={(event) => setDeviceKeys((keys) => ({ ...keys, [device.id]: event.target.value }))} placeholder={device.keyConfigured ? '留空则保留当前 Key' : '粘贴 Bark 推送 Key'} /></label>
        <button className="secondary-button" type="button" disabled={busy || testingId === device.id} onClick={() => void testDevice(device.id)}>{testingId === device.id ? '测试中…' : '测试'}</button>
        <button className="icon-button danger" type="button" title="删除 Bark 设备和本地密钥" onClick={() => void removeDevice(device.id)}>×</button>
      </div>)}
      {!draft.devices.length && <div className="bark-empty">还没有 Bark 设备。添加设备并保存 Key 后即可测试。</div>}
    </div>
    <div className="bark-actions"><button className="primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存 Bark 配置'}</button><span>手机声音由各设备的 Bark App 与 iOS 通知设置管理。</span></div>
  </section>
}

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [bootError, setBootError] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [page, setPage] = useState<'dashboard' | 'favorites' | 'logs' | 'settings' | 'qqbots'>('dashboard')
  const [notice, setNotice] = useState('')
  const [qqConfig, setQQConfig] = useState<QQBotConfig | null>(null)
  const [barkConfig, setBarkConfig] = useState<BarkConfig | null>(null)
  const [itemFilter, setItemFilter] = useState<'all' | string>('all')
  const [favoriteFilter, setFavoriteFilter] = useState<'all' | 'auction' | 'direct' | 'sold' | 'available'>('all')
  const [pendingRemoval, setPendingRemoval] = useState<Subscription | null>(null)
  const [draggingSubscriptionId, setDraggingSubscriptionId] = useState<string | undefined>()
  const [dragOverSubscriptionId, setDragOverSubscriptionId] = useState<string | undefined>()
  const [, forceClock] = useState(0)

  useEffect(() => {
    if (!window.mercariPulse) {
      setBootError('桌面桥接组件未能加载。请安装最新版本后重新启动应用。')
      return
    }
    void Promise.all([window.mercariPulse.getSnapshot(), window.mercariPulse.getQQBotConfig(), window.mercariPulse.getBarkConfig(), window.mercariPulse.getAppVersion()])
      .then(([nextSnapshot, nextQQConfig, nextBarkConfig, nextVersion]) => { setSnapshot(nextSnapshot); setQQConfig(nextQQConfig); setBarkConfig(nextBarkConfig); setAppVersion(nextVersion) })
      .catch((error) => setBootError(String(error)))
    return window.mercariPulse.onMonitorEvent((event) => {
      if (event.snapshot) {
        setSnapshot(event.snapshot)
        void window.mercariPulse.getQQBotConfig().then(setQQConfig).catch(() => undefined)
      }
      if (event.item) setNotice(`${event.item.discoveryType === 'updated' ? '旧商品更新' : '发现上新'}：${event.item.name}`)
    })
  }, [])

  useEffect(() => {
    const timer = setInterval(() => forceClock((value) => value + 1), 1_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    document.body.dataset.theme = snapshot?.settings.theme ?? 'emerald'
  }, [snapshot?.settings.theme])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  const activeCount = useMemo(() => snapshot?.subscriptions.filter((item) => item.enabled).length ?? 0, [snapshot])
  const filteredItems = useMemo(() => {
    if (!snapshot) return []
    return itemFilter === 'all' ? snapshot.globalRecentItems : snapshot.recentItems.filter((item) => item.subscriptionId === itemFilter)
  }, [snapshot, itemFilter])
  const filteredFavorites = useMemo(() => (snapshot?.favorites ?? []).filter((favorite) => {
    if (favoriteFilter === 'all') return true
    if (favoriteFilter === 'auction') return favorite.isAuction === true
    if (favoriteFilter === 'direct') return favorite.isAuction !== true
    return favoriteFilter === 'sold' ? isSoldMercariStatus(favorite.status) : !isSoldMercariStatus(favorite.status)
  }), [snapshot?.favorites, favoriteFilter])

  useEffect(() => {
    if (itemFilter !== 'all' && !snapshot?.subscriptions.some((item) => item.id === itemFilter)) setItemFilter('all')
  }, [snapshot?.subscriptions, itemFilter])

  async function action(work: Promise<AppSnapshot | void>): Promise<boolean> {
    try {
      const result = await work
      if (result) setSnapshot(result)
      return true
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false }
  }

  async function reorderSubscription(sourceId: string, targetId: string): Promise<void> {
    if (!snapshot || sourceId === targetId) return
    const from = snapshot.subscriptions.findIndex((item) => item.id === sourceId)
    const to = snapshot.subscriptions.findIndex((item) => item.id === targetId)
    if (from < 0 || to < 0) return
    const ordered = [...snapshot.subscriptions]
    const [moved] = ordered.splice(from, 1)
    ordered.splice(to, 0, moved)
    if (await action(window.mercariPulse.reorderSubscriptions(ordered.map((item) => item.id)))) setNotice('已调整监控任务排序')
  }

  if (bootError) return <main className="loading"><div className="pulse-logo">!</div><p>{bootError}</p></main>
  if (!snapshot) return <main className="loading"><div className="pulse-logo">M</div><p>正在启动监控引擎…</p></main>

  return (
    <div className={`app-shell theme-${snapshot.settings.theme}`}>
      <aside>
        <div className="brand"><div className="brand-mark">M</div><div><strong>Mercari</strong><span>Pulse</span></div></div>
        <nav>
          <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}><span>◫</span>监控面板</button>
          <button className={page === 'favorites' ? 'active' : ''} onClick={() => setPage('favorites')}><span>♥</span>我的收藏</button>
          <button className={page === 'logs' ? 'active' : ''} onClick={() => setPage('logs')}><span>≡</span>运行日志</button>
          <button className={page === 'qqbots' ? 'active' : ''} onClick={() => setPage('qqbots')}><span>♟</span>QQ机器人设置</button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><span>⚙</span>偏好设置</button>
        </nav>
        <div className="engine-state"><i /><div><b>监控引擎在线</b><span>{activeCount} 个任务运行中</span></div></div>
        <p className="version">MERCARI PULSE · {appVersion ? `V${appVersion}` : '正在读取版本…'}</p>
      </aside>

      <main className="content">
        {page === 'dashboard' ? <>
          <header><div><p className="eyebrow">LOW-LATENCY WATCHER</p><h1>不错过每一次上新</h1><p>以约 1 秒间隔追踪 Mercari JP 最新商品</p></div><div className="live-chip"><i /> LIVE</div></header>
          <AddMonitor defaultInterval={snapshot.settings.defaultIntervalMs} onAdd={async (input) => { await action(window.mercariPulse.addSubscription(input)) }} />
          <section className="section-block">
            <div className="section-heading"><div><h2>监控任务</h2><span>{snapshot.subscriptions.length} 个关键词</span></div><label className="task-height-control">可见任务 <input type="range" min="1" max="10" value={snapshot.settings.subscriptionVisibleCount} onChange={(event) => void action(window.mercariPulse.updateSettings({ subscriptionVisibleCount: Number(event.target.value) }))} /><input type="number" min="1" max="10" value={snapshot.settings.subscriptionVisibleCount} onChange={(event) => void action(window.mercariPulse.updateSettings({ subscriptionVisibleCount: Math.max(1, Math.min(10, Number(event.target.value) || 1)) }))} /> 条</label></div>
            <BulkSubscriptionManager count={snapshot.subscriptions.length} onApply={async (patch) => {
              const success = await action(window.mercariPulse.updateAllSubscriptions(patch))
              if (success) setNotice(`已统一更新 ${snapshot.subscriptions.length} 个监控任务`)
              return success
            }} onRefresh={async () => {
              try {
                const result = await window.mercariPulse.checkAllNow()
                setNotice(result.requested ? `已开始刷新 ${result.requested} 个任务${result.skipped ? `，跳过 ${result.skipped} 个` : ''}` : '没有可立即刷新的任务')
              } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
            }} />
            <div className="subscription-grid" style={{ maxHeight: `${snapshot.settings.subscriptionVisibleCount * 122}px` }}>
              {snapshot.subscriptions.map((item) => <SubscriptionCard key={item.id} item={item} qqTargets={snapshot.settings.qqBots.flatMap((bot) => bot.targets)} initialSyncing={snapshot.initialSyncingSubscriptionIds.includes(item.id)} dragging={draggingSubscriptionId === item.id} dropTarget={dragOverSubscriptionId === item.id && draggingSubscriptionId !== item.id}
                onDragStart={(id) => { setDraggingSubscriptionId(id); setDragOverSubscriptionId(undefined) }} onDragEnter={setDragOverSubscriptionId} onDragEnd={() => { setDraggingSubscriptionId(undefined); setDragOverSubscriptionId(undefined) }} onDrop={(targetId) => { const sourceId = draggingSubscriptionId; setDraggingSubscriptionId(undefined); setDragOverSubscriptionId(undefined); if (sourceId) void reorderSubscription(sourceId, targetId) }}
                ultraFastAtCapacity={snapshot.subscriptions.filter((other) => other.id !== item.id && other.enabled && other.intervalMs <= 100).length >= snapshot.settings.maxUltraFastSubscriptions}
                fastAtCapacity={snapshot.subscriptions.filter((other) => other.id !== item.id && other.enabled && other.intervalMs > 100 && other.intervalMs <= 500).length >= snapshot.settings.maxFastSubscriptions}
                onChange={(id, patch) => void action(window.mercariPulse.updateSubscription(id, patch))}
                onResync={async (id) => { if (await action(window.mercariPulse.resyncInitialResults(id))) setNotice('正在重新同步该关键词的初始结果') }}
                onCheck={(id) => void action(window.mercariPulse.checkNow(id))}
                onDelete={(id) => {
                  const subscription = snapshot.subscriptions.find((value) => value.id === id)
                  if (subscription) setPendingRemoval(subscription)
                }} />)}
              {!snapshot.subscriptions.length && <div className="empty-state"><b>还没有监控任务</b><span>在上方输入关键词，第一次检查会建立商品基线。</span></div>}
            </div>
          </section>
          <section className="section-block items-section">
            <div className="section-heading"><div><h2>商品动态</h2><span>首次显示选定数量，随后显示上新；图片无法加载的商品会自动隐藏</span></div></div>
            <div className="item-filters" role="tablist" aria-label="商品关键词分类"><button className={itemFilter === 'all' ? 'active' : ''} onClick={() => setItemFilter('all')}>全部 <span>{snapshot.globalRecentItems.length}</span></button>{snapshot.subscriptions.map((subscription) => <button key={subscription.id} className={itemFilter === subscription.id ? 'active' : ''} onClick={() => setItemFilter(subscription.id)}>{subscription.keyword} <span>{snapshot.recentItems.filter((item) => item.subscriptionId === subscription.id).length}</span></button>)}</div>
            <div className="item-grid">
              {filteredItems.map((item) => <ItemCard key={`${item.subscriptionId}-${item.id}`} item={item} favorite={snapshot.favorites.some((favorite) => favorite.id === item.id)} onFavorite={(value) => void action(window.mercariPulse.addFavorite(value))} onDelete={(value) => {
                if (confirm(`确认从商品动态中删除“${value.name}”吗？`)) {
                  void action(window.mercariPulse.dismissRecentItem(value.subscriptionId, value.id))
                }
              }} />)}
              {!filteredItems.length && <div className="empty-state compact"><b>{itemFilter === 'all' ? '等待查询结果' : '该关键词暂无商品动态'}</b><span>添加关键词后会展示选定数量的最新商品，后续上新将发送系统通知。</span></div>}
            </div>
          </section>
        </> : page === 'favorites' ? <>
          <header><div><p className="eyebrow">MY FAVORITES</p><h1>我的收藏</h1><p>每 30 秒检查一次商品价格与在售状态</p></div><div className="live-chip"><i /> {snapshot.favorites.length} 件收藏</div></header>
          <section className="section-block favorites-page">
            <AddFavoriteByReference onAdd={(value) => action(window.mercariPulse.addFavoriteByReference(value))} />
            <div className="item-filters" role="tablist" aria-label="收藏商品分类">
              <button className={favoriteFilter === 'all' ? 'active' : ''} onClick={() => setFavoriteFilter('all')}>全部 <span>{snapshot.favorites.length}</span></button>
              <button className={favoriteFilter === 'auction' ? 'active' : ''} onClick={() => setFavoriteFilter('auction')}>拍卖 <span>{snapshot.favorites.filter((item) => item.isAuction === true).length}</span></button>
              <button className={favoriteFilter === 'direct' ? 'active' : ''} onClick={() => setFavoriteFilter('direct')}>直售 <span>{snapshot.favorites.filter((item) => item.isAuction !== true).length}</span></button>
              <button className={favoriteFilter === 'available' ? 'active' : ''} onClick={() => setFavoriteFilter('available')}>未售出 <span>{snapshot.favorites.filter((item) => !isSoldMercariStatus(item.status)).length}</span></button>
              <button className={favoriteFilter === 'sold' ? 'active' : ''} onClick={() => setFavoriteFilter('sold')}>已售出 <span>{snapshot.favorites.filter((item) => isSoldMercariStatus(item.status)).length}</span></button>
            </div>
            <div className="favorite-grid">{filteredFavorites.map((favorite) => <FavoriteCard key={favorite.id} item={favorite} onRemove={(id) => void action(window.mercariPulse.removeFavorite(id))} />)}{!filteredFavorites.length && <div className="empty-state compact"><b>{snapshot.favorites.length ? '该分类暂无收藏商品' : '还没有收藏商品'}</b><span>{snapshot.favorites.length ? '切换其他分类查看。' : '在“监控面板 → 商品动态”中点击 ♥ 即可收藏并监控。'}</span></div>}</div>
          </section>
        </> : page === 'logs' ? <LogPanel logs={snapshot.logs} /> : page === 'qqbots' ? <>
          {qqConfig && <QQBotSettings config={qqConfig} onChange={setQQConfig} onNotice={setNotice} />}
        </> : <>
          <header><div><p className="eyebrow">PREFERENCES</p><h1>偏好设置</h1><p>调整通知与默认轮询节奏</p></div></header>
          <section className="settings-panel">
            <Setting label="系统通知" detail="检测到上新时发送桌面通知"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationsEnabled} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationsEnabled: e.target.checked }))} /><span /></label></Setting>
            <Setting label="通知显示商品图片" detail="通知立即出现，图片在窗口内直连加载；不保存到本地"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationIncludeImage} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationIncludeImage: e.target.checked }))} /><span /></label></Setting>
            <Setting label="通知显示商品名称" detail="在通知正文中包含完整商品名称"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationIncludeName} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationIncludeName: e.target.checked }))} /><span /></label></Setting>
            <Setting label="通知显示商品价格" detail="在通知正文中包含日元价格"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationIncludePrice} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationIncludePrice: e.target.checked }))} /><span /></label></Setting>
            <Setting label="测试后台通知" detail="使用最新一条商品动态预览当前通知组合"><button className="secondary-button" onClick={() => void window.mercariPulse.testNotification().then((result) => setNotice(result.supported ? '测试通知已发送' : '系统通知不可用，已尝试托盘气泡提醒')).catch((error) => setNotice(String(error)))}>发送测试通知</button></Setting>
            <Setting label="通知声音" detail="使用操作系统的默认提示音"><label className="switch"><input type="checkbox" checked={snapshot.settings.soundEnabled} onChange={(e) => void action(window.mercariPulse.updateSettings({ soundEnabled: e.target.checked }))} /><span /></label></Setting>
            <Setting label="开机自动启动" detail="登录 Windows 后自动启动 Mercari Pulse；可与“启动时最小化”组合使用"><label className="switch"><input type="checkbox" checked={snapshot.settings.launchAtStartup} onChange={(e) => void action(window.mercariPulse.updateSettings({ launchAtStartup: e.target.checked }))} /><span /></label></Setting>
            <Setting label="启动时最小化" detail="应用启动后直接驻留系统托盘"><label className="switch"><input type="checkbox" checked={snapshot.settings.launchMinimized} onChange={(e) => void action(window.mercariPulse.updateSettings({ launchMinimized: e.target.checked }))} /><span /></label></Setting>
            <Setting label="默认检查间隔" detail="0.1 秒与 0.5 秒模式请求频繁，更容易触发限流"><select value={snapshot.settings.defaultIntervalMs} onChange={(e) => void action(window.mercariPulse.updateSettings({ defaultIntervalMs: Number(e.target.value) }))}><option value="100">0.1 秒（极速）</option><option value="500">0.5 秒（快速）</option><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="5000">5 秒</option><option value="10000">10 秒</option></select></Setting>
            <Setting label="当前版本" detail="版本号由当前运行的安装包自动读取"><span className="app-version-badge">V{appVersion || '读取中'}</span></Setting>
          </section>
          {barkConfig && <BarkSettingsPanel config={barkConfig} onChange={setBarkConfig} onNotice={setNotice} />}
          <section className="settings-panel personalization-panel">
            <div className="personalization-heading"><p className="eyebrow">PERSONALIZATION</p><h2>个性化设置</h2><span>选择偏好的界面主题颜色，设置会自动保存。</span></div>
            <Setting label="主题颜色" detail="改变软件界面配色，不影响商品图片"><select value={snapshot.settings.theme} onChange={(e) => void action(window.mercariPulse.updateSettings({ theme: e.target.value as AppSnapshot['settings']['theme'] }))}><option value="emerald">翡翠绿（默认）</option><option value="sapphire">深海蓝</option><option value="violet">暮光紫</option><option value="rose">玫瑰粉</option><option value="amber">琥珀金</option><option value="obsidian">曜石黑</option><option value="porcelain">极简白</option></select></Setting>
            <Setting label="极速模式任务数" detail="允许同时运行 0.1 秒轮询的关键词数量；0 表示禁用"><input className="quota-input" type="number" min="0" max="20" value={snapshot.settings.maxUltraFastSubscriptions} onChange={(e) => void action(window.mercariPulse.updateSettings({ maxUltraFastSubscriptions: Number(e.target.value) }))} /></Setting>
            <Setting label="快速模式任务数" detail="允许同时运行 0.5 秒轮询的关键词数量；0 表示禁用"><input className="quota-input" type="number" min="0" max="20" value={snapshot.settings.maxFastSubscriptions} onChange={(e) => void action(window.mercariPulse.updateSettings({ maxFastSubscriptions: Number(e.target.value) }))} /></Setting>
          </section>
          <div className="notice-box"><b>关于 1 秒延迟</b><p>应用每约 1 秒发起一次检查，但最终发现延迟还取决于 Mercari 搜索索引更新时间、网络 RTT 和接口限流。失败时会自动退避，恢复后回到设定间隔。</p></div>
        </>}
      </main>
      {pendingRemoval && <RemoveSubscriptionDialog subscription={pendingRemoval} onCancel={() => setPendingRemoval(null)} onRemove={(removeRelatedItems) => {
        const subscription = pendingRemoval
        setPendingRemoval(null)
        void action(window.mercariPulse.removeSubscription(subscription.id, removeRelatedItems))
      }} />}
      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

function Setting({ label, detail, children }: { label: string; detail: string; children: ReactNode }): JSX.Element {
  return <div className="setting-row"><div><b>{label}</b><span>{detail}</span></div>{children}</div>
}
