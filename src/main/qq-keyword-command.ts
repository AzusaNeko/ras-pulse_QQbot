export type QQKeywordCommand =
  | { type: 'add'; keyword: string }
  | { type: 'remove'; keyword: string }
  | { type: 'list' }
  | { type: 'help' }

/** Parses the short Chinese commands accepted by the QQ bot. */
export function parseQQKeywordCommand(content: string): QQKeywordCommand | undefined {
  const value = content.replace(/<@!?(?:\\d+)>/g, '').trim()
  if (!value) return undefined
  if (/^(?:\/)?(?:关键词列表|我的关键词|列表|list)$/i.test(value)) return { type: 'list' }
  if (/^(?:\/)?(?:帮助|help|指令)$/i.test(value)) return { type: 'help' }
  const match = /^(?:\/)?(添加关键词|添加|订阅|add|移除关键词|移除|删除|取消|remove)\s+(.+)$/i.exec(value)
  if (!match) return undefined
  const keyword = match[2].trim()
  if (!keyword) return undefined
  return /^(添加关键词|添加|订阅|add)$/i.test(match[1]) ? { type: 'add', keyword } : { type: 'remove', keyword }
}

export function qqKeywordHelp(): string {
  return '关键词监控指令：\n添加关键词 相机\n移除关键词 相机\n关键词列表\n\n添加后仅会收到自己订阅关键词的上新提醒。'
}
