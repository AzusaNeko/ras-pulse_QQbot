export type QQKeywordCommand =
  | { type: 'add'; keyword: string; excludeKeywords: string[] }
  | { type: 'remove'; keyword: string }
  | { type: 'clear'; confirmed: boolean }
  | { type: 'list' }
  | { type: 'help' }

/** Parses the short Chinese commands accepted by the QQ bot. */
export function parseQQKeywordCommand(content: string): QQKeywordCommand | undefined {
  const value = content.replace(/<@!?(?:\\d+)>/g, '').trim()
  if (!value) return undefined
  if (/^(?:\/)?(?:关键词列表|我的关键词|列表|list)$/i.test(value)) return { type: 'list' }
  if (/^(?:\/)?(?:帮助|help|指令)$/i.test(value)) return { type: 'help' }
  const clear = /^(?:\/)?(?:清除所有关键词|清空关键词|清除全部|clear)(?:\s+(确认|confirm))?$/i.exec(value)
  if (clear) return { type: 'clear', confirmed: Boolean(clear[1]) }
  const match = /^(?:\/)?(添加关键词|添加|订阅|add|移除关键词|移除|删除|取消|remove)\s+(.+)$/i.exec(value)
  if (!match) return undefined
  const [keywordPart, excludePart = ''] = match[2].split(/\s+(?:屏蔽|排除)\s*/i, 2)
  const keyword = keywordPart.trim()
  if (!keyword) return undefined
  if (/^(添加关键词|添加|订阅|add)$/i.test(match[1])) {
    const excludeKeywords = excludePart.split(/[，,、\n]/).map((term) => term.trim()).filter(Boolean)
    return { type: 'add', keyword, excludeKeywords }
  }
  return { type: 'remove', keyword }
}

export function qqKeywordHelp(): string {
  return '关键词监控指令：\n添加关键词 相机\n添加关键词 バンドリ 屏蔽 バンドリエール、バンドリング\n移除关键词 相机\n关键词列表\n清除所有关键词 确认\n\n添加后仅会收到自己订阅关键词的上新提醒；屏蔽词仅对当前私聊或群聊生效。'
}
