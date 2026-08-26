import { describe, expect, it } from 'vitest'
import { parseQQKeywordCommand } from './qq-keyword-command'

describe('parseQQKeywordCommand', () => {
  it('parses add, remove, and list commands', () => {
    expect(parseQQKeywordCommand('添加关键词 胶片相机')).toEqual({ type: 'add', keyword: '胶片相机', excludeKeywords: [] })
    expect(parseQQKeywordCommand('/添加关键词 bangdream')).toEqual({ type: 'add', keyword: 'bangdream', excludeKeywords: [] })
    expect(parseQQKeywordCommand('添加关键词 バンドリ 屏蔽 バンドリエール、バンドリング,バンドリーノ')).toEqual({ type: 'add', keyword: 'バンドリ', excludeKeywords: ['バンドリエール', 'バンドリング', 'バンドリーノ'] })
    expect(parseQQKeywordCommand('バンドリ 添加屏蔽词 バンドリエール、バンドリング')).toEqual({ type: 'add-exclude', keyword: 'バンドリ', excludeKeywords: ['バンドリエール', 'バンドリング'] })
    expect(parseQQKeywordCommand('/移除 Switch')).toEqual({ type: 'remove', keyword: 'Switch' })
    expect(parseQQKeywordCommand('关键词列表')).toEqual({ type: 'list' })
    expect(parseQQKeywordCommand('绑定昵称 Azusa')).toEqual({ type: 'bind', name: 'Azusa' })
    expect(parseQQKeywordCommand('/绑定群名 Ras 监控群')).toEqual({ type: 'bind', name: 'Ras 监控群' })
    expect(parseQQKeywordCommand('清除所有关键词')).toEqual({ type: 'clear', confirmed: false })
    expect(parseQQKeywordCommand('/清除所有关键词 确认')).toEqual({ type: 'clear', confirmed: true })
  })
})
