## ADDED Requirements

### Requirement: Bark 手机推送必须独立配置并兼容旧状态

系统必须（MUST）提供独立于桌面通知和 QQ 推送的 Bark 全局开关、Server 地址、通知等级、图片开关和设备列表；旧状态缺少这些字段时，必须默认关闭 Bark、使用 `https://api.day.app`、使用普通等级、默认开启图片且设备列表为空。

#### Scenario: 旧用户首次升级

- **WHEN** 应用加载不含任何 Bark 字段的旧 `state.json`
- **THEN** 原有订阅、动态、收藏、桌面设置和 QQ 配置必须保持不变，且 Bark 不得自动发送通知

#### Scenario: 桌面通知与 Bark 分别启停

- **WHEN** 用户关闭桌面系统通知但开启 Bark，或者开启桌面系统通知但关闭 Bark
- **THEN** 两个通道必须分别遵循各自开关，不能相互覆盖

#### Scenario: 关键词关闭 Windows 弹窗

- **WHEN** 某个关键词关闭 Windows 弹窗，但全局 Bark 和 Bark 设备处于启用状态
- **THEN** 该关键词的新商品和旧商品更新仍必须发送 Bark，关键词级 Windows 设置不得关闭手机推送

### Requirement: 系统必须管理多个 Bark 设备并执行最小校验

系统必须（MUST）允许用户在同一个 Bark Server 下配置多个设备，每台设备具有稳定 ID、显示名称、启用状态和独立 `deviceKey`，所有启用设备接收相同的 Bark 消息。

#### Scenario: 添加多个有效设备

- **WHEN** 用户为多台 iPhone 分别添加不同的非空 `deviceKey` 并启用设备
- **THEN** 系统必须保留每台设备的独立元数据和密钥，并将正式 Bark 通知广播给全部启用设备

#### Scenario: 设备名称为空

- **WHEN** 用户添加设备时未填写名称
- **THEN** 系统必须生成不为空的顺序名称，不得仅因缺少名称而拒绝设备

#### Scenario: Server 地址无效

- **WHEN** Server 为空、不是完整地址或使用 HTTP/HTTPS 之外的协议
- **THEN** 系统必须拒绝保存并说明只接受完整的 HTTP 或 HTTPS 地址

#### Scenario: 设备 Key 为空或重复

- **WHEN** 用户添加空 `deviceKey`，或同一 Server 下已经存在相同的规范化 Key
- **THEN** 系统必须拒绝保存，且不得通过猜测长度或字符格式拒绝其他非空 Key

#### Scenario: 开启时没有可用设备

- **WHEN** 用户尝试开启全局 Bark，但不存在已启用且已配置 Key 的设备
- **THEN** 系统必须拒绝开启并给出可操作提示

### Requirement: Bark 设备密钥必须安全存储

系统必须（MUST）通过 Electron `safeStorage`/Windows DPAPI 将每台设备的 `deviceKey` 加密保存到普通应用设置之外，并以稳定设备 ID 关联密钥。

#### Scenario: 渲染进程读取 Bark 配置

- **WHEN** 设置界面读取已经保存的 Bark 设备
- **THEN** 渲染进程只能获得设备元数据和 `keyConfigured`，不得获得明文 Key、密文或可还原 Key 的完整推送 URL

#### Scenario: 留空更新已配置设备

- **WHEN** 用户编辑已配置设备但没有输入新 Key
- **THEN** 系统必须保留原有加密 Key

#### Scenario: 删除 Bark 设备

- **WHEN** 用户删除一个 Bark 设备
- **THEN** 系统必须同时删除该设备对应的加密 Key，且不得影响其他设备密钥

#### Scenario: 安全存储不可用

- **WHEN** Electron 安全存储无法加密或解密 Bark Key
- **THEN** 系统必须拒绝保存、测试或正式发送，并提供不包含 Key 的错误信息

### Requirement: Bark 必须覆盖已确认的商品事件

系统必须（MUST）在 Bark 全局开启时，对商品上新、旧商品更新以及收藏商品降价或售出变化生成手机推送，并且不得为基线商品或没有状态变化的收藏检查发送 Bark。

#### Scenario: 发现新商品

- **WHEN** 监控引擎在基线建立后发出新商品事件
- **THEN** 所有已启用 Bark 设备必须接收“发现上新”通知

#### Scenario: 识别旧商品更新

- **WHEN** 监控引擎发出 `discoveryType=updated` 且包含变化摘要的商品事件
- **THEN** 所有已启用 Bark 设备必须接收“旧商品更新”通知及变化摘要

#### Scenario: 收藏商品发生变化

- **WHEN** 收藏商品价格变化、变为已售或两者同时发生
- **THEN** 所有已启用 Bark 设备必须接收收藏变化通知，并包含当前价格及可识别的变化

#### Scenario: Bark 发送失败

- **WHEN** 任意 Bark 设备发送失败
- **THEN** 商品动态、收藏状态、监控轮询、桌面通知、QQ 推送和其他 Bark 设备发送必须继续执行

### Requirement: Bark 通知必须提供完整且可行动的内容

系统必须（MUST）为商品通知提供事件类型、关键词或收藏语境、商品名称、当前价格、可用的变化摘要和经过现有规则构造的 Mercari 商品链接。

#### Scenario: 用户点击商品通知

- **WHEN** 用户点击上新、旧商品更新或收藏变化的 Bark 通知
- **THEN** 系统必须请求打开该通知对应的 Mercari 商品链接

#### Scenario: 商品图片已开启且受支持

- **WHEN** Bark 图片开关开启，并且商品缩略图符合现有 Mercari 图片 URL 支持规则
- **THEN** 请求必须把缩略图作为 Bark `image` 媒体附件，且图片失败不得影响文字和链接送达

#### Scenario: 商品图片关闭或不可用

- **WHEN** Bark 图片开关关闭，或者缩略图缺失或不受支持
- **THEN** 请求必须省略 `image`，仍然发送完整文字和链接

#### Scenario: 普通与时效性等级

- **WHEN** 全局等级分别配置为普通或时效性
- **THEN** Bark 请求的 `level` 必须分别为 `active` 或 `timeSensitive`

#### Scenario: 首版负载边界

- **WHEN** 系统构造任意 Bark 正式或测试请求
- **THEN** 请求不得指定 `critical`、`call`、自定义 `sound` 或 `ciphertext`

### Requirement: Bark 必须逐设备发送并执行有限重试

系统必须（MUST）通过 Electron `net.fetch` 向当前 Bark Server 的 V2 `/push` 端点逐设备发送 JSON POST，并对各设备结果进行独立处理。

#### Scenario: 多台设备全部成功

- **WHEN** 多台启用设备的 Bark Server 请求均成功
- **THEN** 每台设备必须各收到一次对应通知，且请求不得把 `deviceKey` 放入 URL

#### Scenario: 网络错误、超时或服务器错误

- **WHEN** 某台设备发生网络错误、请求超时或 HTTP 5xx
- **THEN** 系统必须等待两秒后只重试一次，第二次结束后不得继续自动重试

#### Scenario: 客户端错误

- **WHEN** 某台设备收到 HTTP 4xx
- **THEN** 系统不得重试该请求，且必须记录该设备的脱敏失败诊断

#### Scenario: 部分设备失败

- **WHEN** 一台设备最终失败而其他设备成功
- **THEN** 成功设备不得被回滚或重复补发，失败结果必须按设备独立记录

#### Scenario: 应用在等待重试时退出

- **WHEN** 应用在两秒等待期间退出或发送结果未持久化
- **THEN** 下次启动不得从持久化队列补发该通知

#### Scenario: 记录 Bark 错误

- **WHEN** Bark 请求、密钥读取或响应处理失败
- **THEN** 日志可以包含设备名称、稳定 ID、错误类别和脱敏 Server，但不得包含 `deviceKey`、完整请求体或含 Key 的 URL

### Requirement: 设置界面必须支持自建 Server 风险提示和设备测试

系统必须（MUST）在偏好设置中提供 Bark 全局配置和设备管理，并允许用户对单台已经配置 Key 的设备发送测试通知。

#### Scenario: 使用 HTTP Server

- **WHEN** 用户填写有效的 `http://` Bark Server
- **THEN** 设置界面必须提示 Key 与通知内容会明文传输，但不得因此阻止保存、测试或正式发送

#### Scenario: 测试停用设备

- **WHEN** 设备已经配置 Key，但全局 Bark 或该设备当前处于关闭状态
- **THEN** 用户仍可主动测试该设备，且测试不得向其他设备发送

#### Scenario: 使用最近商品测试

- **WHEN** 应用存在最近商品且用户测试某台设备
- **THEN** 系统必须使用与正式通知一致的字段生成带测试标识的商品预览

#### Scenario: 没有商品时测试

- **WHEN** 应用没有最近商品且用户测试某台设备
- **THEN** 系统必须发送不包含虚构商品链接或图片的通用 Bark 测试通知

#### Scenario: 测试结果反馈

- **WHEN** 设备测试完成
- **THEN** 设置界面必须明确显示目标设备成功或失败，不得仅以请求已发起作为成功
