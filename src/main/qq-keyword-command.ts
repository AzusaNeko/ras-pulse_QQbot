export type QQKeywordCommand =
  | { type: 'add'; keyword: string; excludeKeywords: string[] }
  | { type: 'add-exclude'; keyword: string; excludeKeywords: string[] }
  | { type: 'remove'; keyword: string }
  | { type: 'clear'; confirmed: boolean }
  | { type: 'bind'; name: string }
  | { type: 'list' }
  | { type: 'help' }

/** Parses the short Chinese commands accepted by the QQ bot. */
export function parseQQKeywordCommand(content: string): QQKeywordCommand | undefined {
  const value = content.replace(/<@!?(?:\\d+)>/g, '').trim()
  if (!value) return undefined
  if (/^(?:\/)?(?:关键词列表|我的关键词|列表|list)$/i.test(value)) return { type: 'list' }
  if (/^(?:\/)?(?:帮助|help|指令)$/i.test(value)) return { type: 'help' }
  const bind = /^(?:\/)?(?:绑定昵称|绑定群名|绑定群名称|绑定名称)\s+(.+)$/i.exec(value)
  if (bind?.[1]?.trim()) return { type: 'bind', name: bind[1].trim() }
  const clear = /^(?:\/)?(?:清除所有关键词|清空关键词|清除全部|clear)(?:\s+(确认|confirm))?$/i.exec(value)
  if (clear) return { type: 'clear', confirmed: Boolean(clear[1]) }
  const addExclude = /^(?:\/)?(.+?)\s*(?:添加屏蔽词|添加排除词)\s+(.+)$/i.exec(value)
  if (addExclude) {
    const keyword = addExclude[1].trim()
    const excludeKeywords = addExclude[2].split(/[，,、\n]/).map((term) => term.trim()).filter(Boolean)
    return keyword && excludeKeywords.length ? { type: 'add-exclude', keyword, excludeKeywords } : undefined
  }
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
  return '关键词监控指令：\n私聊先发送：绑定昵称 你的昵称\n群聊先发送：绑定群名 群名称\n添加关键词 相机\n添加关键词 バンドリ 屏蔽 バンドリエール、バンドリング\nバンドリ 添加屏蔽词 バンドリーノ、バンドリング\n移除关键词 相机\n关键词列表\n清除所有关键词 确认\n\n完成绑定前不会推送商品；绑定后仅会收到当前私聊或群聊订阅关键词的提醒。'
}
