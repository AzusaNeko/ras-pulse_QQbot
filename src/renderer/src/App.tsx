import { useEffect, useMemo, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import type { AppSnapshot, MercariItem, MonitorStatus, NewSubscription, QQBotConfig, QQBotTarget, Subscription } from '../../shared/types'

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

function ItemCard({ item, onDelete }: { item: MercariItem; onDelete: (item: MercariItem) => void }): JSX.Element {
  const openItem = (): void => { void window.mercariPulse.openExternal(item.url) }
  return (
    <article className="item-card" role="button" tabIndex={0} onClick={openItem} onKeyDown={(event) => { if (event.key === 'Enter') openItem() }}>
      <button className="item-delete" title="从商品动态中删除" aria-label="删除商品动态" onClick={(event) => { event.stopPropagation(); onDelete(item) }}>×</button>
      <div className="item-image-wrap">
        {item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" /> : <span>画像なし</span>}
      </div>
      <div className="item-copy">
        <div className="item-topline"><span className="keyword-pill">{item.keyword} · {item.discoveryType === 'baseline' ? '初始结果' : '上新'}</span><time>{timeAgo(item.detectedAt)}</time></div>
        <strong>{item.name}</strong>
        <div className="item-bottom"><b>{price(item.price)}</b><span>打开商品 ↗</span></div>
      </div>
    </article>
  )
}

function SubscriptionCard({ item, onChange, onDelete, onCheck }: {
  item: Subscription
  onChange: (id: string, patch: Partial<Subscription>) => void
  onDelete: (id: string) => void
  onCheck: (id: string) => void
}): JSX.Element {
  return (
    <article className={`subscription-card status-${item.status}`}>
      <div className="subscription-main">
        <div className="status-orbit"><span /></div>
        <div className="subscription-copy">
          <div className="subscription-title"><h3>{item.keyword}</h3><span className="status-label">{statusLabels[item.status]}</span></div>
          <p>
            {item.excludeKeyword && `排除：${item.excludeKeyword} · `}
            {item.minPrice != null || item.maxPrice != null
              ? `${item.minPrice ? price(item.minPrice) : '不限'} — ${item.maxPrice ? price(item.maxPrice) : '不限'} · ` : ''}
            首次 {item.initialDisplayCount ?? 2} 条 · 每 {(item.intervalMs / 1000).toFixed(item.intervalMs % 1000 ? 1 : 0)} 秒
          </p>
          <small title={item.error}>{item.error ? item.error : `上次成功：${timeAgo(item.lastSuccessAt)}`}</small>
        </div>
      </div>
      <div className="card-actions">
        <button className="icon-button" title="立即检查" onClick={() => onCheck(item.id)}>↻</button>
        <label className="switch" title={item.enabled ? '暂停' : '启用'}>
          <input type="checkbox" checked={item.enabled} onChange={(event) => onChange(item.id, { enabled: event.target.checked, status: event.target.checked ? 'watching' : 'paused' })} />
          <span />
        </label>
        <button className="icon-button danger" title="删除" onClick={() => onDelete(item.id)}>×</button>
      </div>
    </article>
  )
}

function AddMonitor({ defaultInterval, onAdd }: { defaultInterval: number; onAdd: (value: NewSubscription) => Promise<void> }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [excludeKeyword, setExcludeKeyword] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [initialDisplayCount, setInitialDisplayCount] = useState('2')
  const [busy, setBusy] = useState(false)

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
        initialDisplayCount: Number(initialDisplayCount)
      })
      setKeyword(''); setExcludeKeyword(''); setMinPrice(''); setMaxPrice(''); setExpanded(false)
    } finally { setBusy(false) }
  }

  return (
    <form className={`add-monitor ${expanded ? 'expanded' : ''}`} onSubmit={(event) => void submit(event)}>
      <div className="search-row">
        <span className="search-icon">⌕</span>
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} onFocus={() => setExpanded(true)} placeholder="输入想监控的商品关键词…" autoFocus />
        <button className="primary" disabled={!keyword.trim() || busy}>{busy ? '添加中…' : '开始监控'}</button>
      </div>
      {expanded && <div className="advanced-row">
        <label>排除词<input value={excludeKeyword} onChange={(event) => setExcludeKeyword(event.target.value)} placeholder="例：故障、仅盒" /></label>
        <label>首次展示<select value={initialDisplayCount} onChange={(event) => setInitialDisplayCount(event.target.value)}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count} 条</option>)}</select></label>
        <label>最低价<input type="number" min="0" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="不限" /></label>
        <label>最高价<input type="number" min="0" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="不限" /></label>
        <button type="button" className="text-button" onClick={() => setExpanded(false)}>收起</button>
      </div>}
    </form>
  )
}

function QQBotPanel({ config, onSave, onTest }: {
  config: QQBotConfig
  onSave: (value: { enabled: boolean; appId: string; targets: QQBotTarget[]; appSecret?: string }) => Promise<void>
  onTest: () => Promise<void>
}): JSX.Element {
  const [enabled, setEnabled] = useState(config.enabled)
  const [appId, setAppId] = useState(config.appId)
  const [secret, setSecret] = useState('')
  const [targets, setTargets] = useState(config.targets)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setEnabled(config.enabled); setAppId(config.appId); setTargets(config.targets)
  }, [config])

  const changeTarget = (id: string, patch: Partial<QQBotTarget>): void => {
    setTargets((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }
  const addTarget = (): void => setTargets((items) => [...items, {
    id: crypto.randomUUID(), type: 'group', targetId: '', label: '', enabled: true
  }])
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSave({ enabled, appId, targets, appSecret: secret || undefined })
      setSecret('')
    } finally { setBusy(false) }
  }

  return <section className="qq-panel">
    <div className="qq-panel-heading"><div><p className="eyebrow">QQ BOT</p><h2>QQ 机器人推送</h2><span>AppSecret 使用 Windows 加密存储，不会显示或上传到 GitHub。</span></div><label className="switch" title={enabled ? '关闭 QQ 推送' : '开启 QQ 推送'}><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span /></label></div>
    <div className="qq-fields">
      <label>AppID<input value={appId} onChange={(event) => setAppId(event.target.value)} inputMode="numeric" placeholder="QQ 开放平台 AppID" /></label>
      <label>AppSecret {config.secretConfigured && <em>已保存</em>}<input value={secret} onChange={(event) => setSecret(event.target.value)} type="password" autoComplete="new-password" placeholder={config.secretConfigured ? '留空则保留当前密钥' : '仅保存到本机'} /></label>
    </div>
    <div className="qq-target-heading"><div><b>推送目标</b><span>填写 QQ 开放平台提供的 openid / group_openid，不是 QQ 号或群号。</span></div><button className="secondary-button" type="button" onClick={addTarget}>+ 添加目标</button></div>
    <div className="qq-targets">
      {targets.map((target) => <div className="qq-target" key={target.id}>
        <label className="switch compact-switch" title={target.enabled ? '停用目标' : '启用目标'}><input type="checkbox" checked={target.enabled} onChange={(event) => changeTarget(target.id, { enabled: event.target.checked })} /><span /></label>
        <select value={target.type} onChange={(event) => changeTarget(target.id, { type: event.target.value as QQBotTarget['type'] })}><option value="group">普通 QQ 群</option><option value="c2c">QQ 私聊</option></select>
        <input value={target.label} onChange={(event) => changeTarget(target.id, { label: event.target.value })} placeholder="备注（可选）" />
        <input value={target.targetId} onChange={(event) => changeTarget(target.id, { targetId: event.target.value })} placeholder={target.type === 'group' ? 'group_openid' : 'openid'} />
        <button className="icon-button danger" type="button" title="移除目标" onClick={() => setTargets((items) => items.filter((item) => item.id !== target.id))}>×</button>
      </div>)}
      {!targets.length && <div className="qq-empty">保存开启后，私聊机器人或在群内 @ 机器人一次，软件会自动发现并添加对应目标。</div>}
    </div>
    <div className="qq-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存 QQ 配置'}</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void onTest()}>发送 QQ 测试消息</button></div>
  </section>
}

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [bootError, setBootError] = useState('')
  const [page, setPage] = useState<'dashboard' | 'settings'>('dashboard')
  const [notice, setNotice] = useState('')
  const [qqConfig, setQQConfig] = useState<QQBotConfig | null>(null)
  const [, forceClock] = useState(0)

  useEffect(() => {
    if (!window.mercariPulse) {
      setBootError('桌面桥接组件未能加载。请安装最新版本后重新启动应用。')
      return
    }
    void Promise.all([window.mercariPulse.getSnapshot(), window.mercariPulse.getQQBotConfig()])
      .then(([nextSnapshot, nextQQConfig]) => { setSnapshot(nextSnapshot); setQQConfig(nextQQConfig) })
      .catch((error) => setBootError(String(error)))
    return window.mercariPulse.onMonitorEvent((event) => {
      if (event.snapshot) {
        setSnapshot(event.snapshot)
        setQQConfig((current) => current ? {
          ...current,
          enabled: event.snapshot!.settings.qqBotEnabled,
          appId: event.snapshot!.settings.qqBotAppId,
          targets: event.snapshot!.settings.qqBotTargets
        } : current)
      }
      if (event.item) setNotice(`发现上新：${event.item.name}`)
    })
  }, [])

  useEffect(() => {
    const timer = setInterval(() => forceClock((value) => value + 1), 1_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  const activeCount = useMemo(() => snapshot?.subscriptions.filter((item) => item.enabled).length ?? 0, [snapshot])

  async function action(work: Promise<AppSnapshot | void>): Promise<void> {
    try {
      const result = await work
      if (result) setSnapshot(result)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }

  if (bootError) return <main className="loading"><div className="pulse-logo">!</div><p>{bootError}</p></main>
  if (!snapshot) return <main className="loading"><div className="pulse-logo">M</div><p>正在启动监控引擎…</p></main>

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><div className="brand-mark">M</div><div><strong>Mercari</strong><span>Pulse</span></div></div>
        <nav>
          <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}><span>◫</span>监控面板</button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><span>⚙</span>偏好设置</button>
        </nav>
        <div className="engine-state"><i /><div><b>监控引擎在线</b><span>{activeCount} 个任务运行中</span></div></div>
        <p className="version">MERCARI PULSE · V0.2.0</p>
      </aside>

      <main className="content">
        {page === 'dashboard' ? <>
          <header><div><p className="eyebrow">LOW-LATENCY WATCHER</p><h1>不错过每一次上新</h1><p>以约 1 秒间隔追踪 Mercari JP 最新商品</p></div><div className="live-chip"><i /> LIVE</div></header>
          <AddMonitor defaultInterval={snapshot.settings.defaultIntervalMs} onAdd={async (input) => { await action(window.mercariPulse.addSubscription(input)) }} />
          <section className="section-block">
            <div className="section-heading"><div><h2>监控任务</h2><span>{snapshot.subscriptions.length} 个关键词</span></div></div>
            <div className="subscription-grid">
              {snapshot.subscriptions.map((item) => <SubscriptionCard key={item.id} item={item}
                onChange={(id, patch) => void action(window.mercariPulse.updateSubscription(id, patch))}
                onCheck={(id) => void action(window.mercariPulse.checkNow(id))}
                onDelete={(id) => {
                  const subscription = snapshot.subscriptions.find((value) => value.id === id)
                  if (!confirm(`确认取消“${subscription?.keyword ?? '该关键词'}”的监控吗？`)) return
                  const removeRelatedItems = confirm('是否同时剔除该关键词相关的商品动态？\n\n确定：同时删除商品动态\n取消：保留商品动态')
                  void action(window.mercariPulse.removeSubscription(id, removeRelatedItems))
                }} />)}
              {!snapshot.subscriptions.length && <div className="empty-state"><b>还没有监控任务</b><span>在上方输入关键词，第一次检查会建立商品基线。</span></div>}
            </div>
          </section>
          <section className="section-block items-section">
            <div className="section-heading"><div><h2>商品动态</h2><span>首次显示选定数量，随后显示上新</span></div></div>
            <div className="item-grid">
              {snapshot.recentItems.map((item) => <ItemCard key={`${item.subscriptionId}-${item.id}`} item={item} onDelete={(value) => {
                if (confirm(`确认从商品动态中删除“${value.name}”吗？`)) {
                  void action(window.mercariPulse.dismissRecentItem(value.subscriptionId, value.id))
                }
              }} />)}
              {!snapshot.recentItems.length && <div className="empty-state compact"><b>等待查询结果</b><span>添加关键词后会展示选定数量的最新商品，后续上新将发送系统通知。</span></div>}
            </div>
          </section>
        </> : <>
          <header><div><p className="eyebrow">PREFERENCES</p><h1>偏好设置</h1><p>调整通知与默认轮询节奏</p></div></header>
          <section className="settings-panel">
            <Setting label="系统通知" detail="检测到上新时发送桌面通知"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationsEnabled} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationsEnabled: e.target.checked }))} /><span /></label></Setting>
            <Setting label="通知显示商品图片" detail="通知立即出现，图片在窗口内直连加载；不保存到本地"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationIncludeImage} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationIncludeImage: e.target.checked }))} /><span /></label></Setting>
            <Setting label="通知显示商品名称" detail="在通知正文中包含完整商品名称"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationIncludeName} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationIncludeName: e.target.checked }))} /><span /></label></Setting>
            <Setting label="通知显示商品价格" detail="在通知正文中包含日元价格"><label className="switch"><input type="checkbox" checked={snapshot.settings.notificationIncludePrice} onChange={(e) => void action(window.mercariPulse.updateSettings({ notificationIncludePrice: e.target.checked }))} /><span /></label></Setting>
            <Setting label="测试后台通知" detail="使用最新一条商品动态预览当前通知组合"><button className="secondary-button" onClick={() => void window.mercariPulse.testNotification().then((result) => setNotice(result.supported ? '测试通知已发送' : '系统通知不可用，已尝试托盘气泡提醒')).catch((error) => setNotice(String(error)))}>发送测试通知</button></Setting>
            <Setting label="通知声音" detail="使用操作系统的默认提示音"><label className="switch"><input type="checkbox" checked={snapshot.settings.soundEnabled} onChange={(e) => void action(window.mercariPulse.updateSettings({ soundEnabled: e.target.checked }))} /><span /></label></Setting>
            <Setting label="启动时最小化" detail="应用启动后直接驻留系统托盘"><label className="switch"><input type="checkbox" checked={snapshot.settings.launchMinimized} onChange={(e) => void action(window.mercariPulse.updateSettings({ launchMinimized: e.target.checked }))} /><span /></label></Setting>
            <Setting label="默认检查间隔" detail="低于 1 秒会被安全限制为 1 秒"><select value={snapshot.settings.defaultIntervalMs} onChange={(e) => void action(window.mercariPulse.updateSettings({ defaultIntervalMs: Number(e.target.value) }))}><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="5000">5 秒</option><option value="10000">10 秒</option></select></Setting>
          </section>
          {qqConfig && <QQBotPanel config={qqConfig} onSave={async (value) => {
            try { setQQConfig(await window.mercariPulse.saveQQBotConfig(value)); setNotice('QQ 机器人配置已保存') } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
          }} onTest={async () => {
            try {
              const result = await window.mercariPulse.testQQBot()
              setNotice(result.failed ? `QQ 测试完成：成功 ${result.delivered}，失败 ${result.failed}` : `QQ 测试消息已发送至 ${result.delivered} 个目标`)
            } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
          }} />}
          <div className="notice-box"><b>关于 1 秒延迟</b><p>应用每约 1 秒发起一次检查，但最终发现延迟还取决于 Mercari 搜索索引更新时间、网络 RTT 和接口限流。失败时会自动退避，恢复后回到设定间隔。</p></div>
        </>}
      </main>
      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

function Setting({ label, detail, children }: { label: string; detail: string; children: ReactNode }): JSX.Element {
  return <div className="setting-row"><div><b>{label}</b><span>{detail}</span></div>{children}</div>
}
