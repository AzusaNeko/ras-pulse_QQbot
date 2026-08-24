import { describe, expect, it } from 'vitest'
import { parseQQKeywordCommand } from './qq-keyword-command'

describe('parseQQKeywordCommand', () => {
  it('parses add, remove, and list commands', () => {
    expect(parseQQKeywordCommand('添加关键词 胶片相机')).toEqual({ type: 'add', keyword: '胶片相机' })
    expect(parseQQKeywordCommand('/移除 Switch')).toEqual({ type: 'remove', keyword: 'Switch' })
    expect(parseQQKeywordCommand('关键词列表')).toEqual({ type: 'list' })
  })
})
