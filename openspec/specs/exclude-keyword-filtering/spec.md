# exclude-keyword-filtering Specification

## Purpose
TBD - created by archiving change fix-multiple-exclude-keywords. Update Purpose after archive.
## Requirements
### Requirement: 多个排除词必须分别传递给 Mercari

系统必须（MUST）把中文逗号、英文逗号、顿号或换行分隔的排除词解析为独立词项，并使用 Mercari 能识别的空格格式构造 `searchCondition.excludeKeyword`。

#### Scenario: 顿号分隔的多个排除词

- **WHEN** 订阅保存的排除词为 `バンドリーノ、スピーディバンドリエール30、バンドリエール`
- **THEN** Mercari 请求中的 `excludeKeyword` 必须为 `バンドリーノ スピーディバンドリエール30 バンドリエール`

#### Scenario: 混合分隔符和重复词

- **WHEN** 排除词使用逗号、顿号或换行混合分隔并包含大小写不同的重复词
- **THEN** 系统必须去除空白项和重复项，并保留每个有效词项

### Requirement: 搜索结果必须执行本地排除兜底

系统必须（MUST）在商品进入基线、上新、旧商品更新和通知判断前，根据当前订阅的每个排除词过滤商品标题。

#### Scenario: Mercari 返回命中排除词的商品

- **WHEN** Mercari 返回的商品标题包含任意一个已配置排除词
- **THEN** 该商品不得进入商品动态、已见商品初始化或通知流程

#### Scenario: 请求期间排除词发生更新

- **WHEN** 搜索请求发出后用户为该订阅新增排除词，且返回商品命中新排除词
- **THEN** 监控引擎必须按最新排除词过滤返回商品

### Requirement: 新增排除词必须清理历史动态

系统必须（MUST）在已有订阅的 `excludeKeyword` 更新后，立即移除该订阅商品动态中命中任意排除词的记录。

#### Scenario: 已有动态命中新排除词

- **WHEN** 用户为已有关键词追加排除词，且商品动态中存在标题命中项
- **THEN** 命中项必须从该关键词的商品动态中移除，其他订阅和未命中项必须保留

#### Scenario: 收藏商品命中新排除词

- **WHEN** 收藏列表中的商品标题命中新排除词
- **THEN** 收藏记录必须保留，因为收藏状态不由关键词排除词管理
