## Why

应用允许用户使用逗号、顿号或换行录入多个排除词，但当前会把展示用的顿号拼接字符串原样传给 Mercari。Mercari 搜索接口只会把空格识别为多个排除词的分隔符，导致多个排除词全部失效，错误商品仍被识别为上新。

## What Changes

- 将持久化的多个排除词解析为独立词项，并在 Mercari 请求中使用空格拼接。
- 在监控引擎接收搜索结果后执行本地标题过滤，避免上游接口行为变化或漏过滤时产生错误提醒。
- 已有关键词新增排除词后，立即移除该关键词商品动态中命中排除词的历史记录。
- 保留界面使用顿号展示多个排除词的现有体验，不改变存量数据格式。

## Capabilities

### New Capabilities

- `exclude-keyword-filtering`: 定义多个排除词的解析、Mercari 请求格式、本地兜底过滤及历史动态清理行为。

### Modified Capabilities

无。

## Impact

- 影响 `MercariClient` 搜索请求体与搜索结果处理。
- 影响 `MonitorEngine` 的订阅更新和商品动态保存逻辑。
- 新增共享的排除词解析与匹配工具，以及对应单元测试。
- 不修改 `Subscription.excludeKeyword` 的持久化字段类型，不需要用户迁移配置。
