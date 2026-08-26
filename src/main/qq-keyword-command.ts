export type QQKeywordCommand =
  | { type: 'bind'; name: string }
  | { type: 'add'; keyword: string; excludeKeywords: string[] }
  | { type: 'add-exclude'; keyword: string; excludeKeywords: string[] }
  | { type: 'remove'; keyword: string }
  | { type: 'clear'; confirmed: boolean }
  | { type: 'list' }
  | { type: 'help' }

/** Parses the Chinese and concise English commands accepted by the QQ bot. */
export function parseQQKeywordCommand(content: string): QQKeywordCommand | undefined {
  const value = content.replace(/<@!?(?:\\d+)>/g, '').trim()
  if (!value) return undefined
  const bind = /^(?:\/)?(?:绑定|绑定名称|绑定昵称|绑定群名|bind)\s+(.+)$/i.exec(value)
  if (bind?.[1].trim()) return { type: 'bind', name: bind[1].trim() }
  if (/^(?:\/)?(?:关键词列表|我的关键词|列表|list)$/i.test(value)) return { type: 'list' }
  if (/^(?:\/)?(?:帮助|help|指令)$/i.test(value)) return { type: 'help' }
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
  const [keywordPart, excludePart = ''] = match[2].split(/\s+(?:屏蔽|排除|exclude)\s*/i, 2)
  const keyword = keywordPart.trim()
  if (!keyword) return undefined
  if (/^(添加关键词|添加|订阅|add)$/i.test(match[1])) {
    const excludeKeywords = excludePart.split(/[，,、\n]/).map((term) => term.trim()).filter(Boolean)
    return { type: 'add', keyword, excludeKeywords }
  }
  return { type: 'remove', keyword }
}

export function qqKeywordHelp(): string {
  return [
    '【Ras Pulse 指令帮助】',
    '',
    '/bind 名称',
    '功能：绑定当前私聊或群聊。完成绑定后才能订阅、管理关键词和接收推送。',
    '示例：/bind 我的收藏群',
    '',
    '/add 关键词',
    '功能：添加商品关键词监控，仅向当前会话推送匹配商品。',
    '示例：/add 相机',
    '',
    '/add 关键词 exclude 屏蔽词1、屏蔽词2',
    '功能：添加监控时同时排除标题含有这些屏蔽词的商品。',
    '示例：/add バンドリ exclude バンドリエール、バンドリング',
    '',
    '/remove 关键词',
    '功能：移除当前会话的指定关键词，不影响其他用户或群聊。',
    '示例：/remove 相机',
    '',
    '/list',
    '功能：查看当前会话已订阅的关键词和屏蔽词。',
    '',
    '/clear',
    '功能：请求清除当前会话的全部关键词；按提示发送 /clear confirm 才会执行。',
    '',
    '/help',
    '功能：显示本帮助。',
    '',
    '提示：未绑定时仅可使用 /bind 和 /help；屏蔽词仅作用于当前私聊或群聊。'
  ].join('\n')
}
