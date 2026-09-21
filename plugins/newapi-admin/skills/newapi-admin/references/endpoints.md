# 管理接口全量路由索引

本文件由 `node tools/generate-endpoints.mjs` 从 `lib/routes.mjs` 生成，请勿手工编辑。

共 **295** 条路由，分 **20** 组，其中会改动数据的 **43** 条。

## 权限层级

| 标记 | 含义 | 判定 |
| --- | --- | --- |
| 公开 | 无需鉴权 | — |
| 用户 | 任意已登录用户或访问令牌 | `UserAuth` |
| 管理员 | 站点管理员 | `AdminAuth`，角色 `role >= 10` |
| Root | 超级管理员 | `RootAuth`，角色 `role >= 100` |
| `admin+channel:write` | 管理员且持有该细粒度权限 | `AdminAuth` + `RequirePermission` |

按层级统计：公开 37、管理员 131、用户 74、Root 53。

渠道路由在管理员之上还叠加了细粒度权限，可对单个用户授予或撤销：

| 权限 | 覆盖的写操作 | 默认角色 |
| --- | --- | --- |
| `channel:read` | 列表、详情、模型目录、默认 base_url | admin |
| `channel:operate` | 启停、测试、余额、拉取模型、修能力、多密钥 | admin |
| `channel:write` | 更新渠道、标签编辑与批量打标 | admin |
| `channel:sensitive_write` | 新增、删除、复制、密钥相关、上游模型更新 | **无**（默认仅 Root） |

> 默认情况下普通管理员**没有** `channel:sensitive_write`，因此新增或删除渠道会返回「权限不足」。
> 需要时由 Root 通过权限管理单独授权，或直接用 Root 令牌。

标记 `[destructive]` 的路由会改动或删除数据；CLI 中必须加 `--yes`（MCP 中必须 `confirm:true`）。

## 系统状态

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/setup` | 公开 | 初始化状态（是否已创建 root、数据库类型） |
| POST | `/api/setup` | 公开 | 初始化系统并创建 root 账号（仅在未初始化时可用） **[destructive]** |
| GET | `/api/status` | 公开 | 公开系统状态：版本、启动时间、QuotaPerUnit、汇率、主题与功能开关 |
| GET | `/api/status/test` | 管理员 | 测试系统状态：数据库连通性、HTTP 统计 |
| GET | `/api/uptime/status` | 公开 | Uptime Kuma 状态 |
| GET | `/api/notice` | 公开 | 公告内容 |
| GET | `/api/about` | 公开 | 关于信息 |
| GET | `/api/home_page_content` | 公开 | 首页内容 |
| GET | `/api/user-agreement` | 公开 | 用户协议 |
| GET | `/api/privacy-policy` | 公开 | 隐私政策 |
| GET | `/api/models` | 用户 | 看板可用模型列表（用户视角，注意与 /api/models/ 不同） |
| GET | `/api/pricing` | 公开 | 公开定价信息（受模块开关控制） |
| GET | `/api/ratio_config` | 公开 | 公开倍率配置；仅在 ExposeRatioEnabled 打开时可用，否则拒绝 |
| GET | `/api/perf-metrics` | 公开 | 性能指标列表 |
| GET | `/api/perf-metrics/summary` | 公开 | 性能指标汇总 |
| GET | `/api/rankings` | 公开 | 排行榜 |

## 认证与登录

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/user/login` | 公开 | 用户登录，返回会话（Session 方式）与 JWT |
| POST | `/api/user/login/2fa` | 公开 | 两步验证登录 |
| POST | `/api/user/login/verify` | 公开 | 登录二次校验 |
| GET | `/api/user/login/encryption-key` | 公开 | 获取密码传输加密公钥 |
| POST | `/api/user/register` | 公开 | 用户注册 |
| POST | `/api/user/reset` | 公开 | 通过邮件令牌重置密码 **[destructive]** |
| GET | `/api/verification` | 公开 | 发送邮箱验证码 |
| GET | `/api/reset_password` | 公开 | 发送密码重置邮件 |
| POST | `/api/user/auth/refresh` | 公开 | 刷新面板登录会话（使用 refresh cookie） |
| POST | `/api/user/auth/logout` | 公开 | 撤销当前登录会话 |
| GET | `/api/user/sessions` | 用户 | 查看自己的登录会话列表 |
| DELETE | `/api/user/sessions/{sid}` | 用户 | 撤销指定登录会话 **[destructive]** |
| POST | `/api/user/sessions/revoke-others` | 用户 | 撤销除当前以外的所有会话 **[destructive]** |
| POST | `/api/user/login/passkey/begin` | 公开 | Passkey 登录开始 |
| POST | `/api/user/login/passkey/finish` | 公开 | Passkey 登录完成 |
| POST | `/api/user/passkey/login/begin` | 公开 | Passkey 登录开始（旧路径） |
| POST | `/api/user/passkey/login/finish` | 公开 | Passkey 登录完成（旧路径） |
| GET | `/api/user/groups` | 用户 | 当前用户可用分组及倍率 |
| POST | `/api/oauth/state` | 公开 | 生成 OAuth State |
| GET | `/api/oauth/{provider}` | 公开 | OAuth 登录（github/discord/oidc/linuxdo/telegram） |
| POST | `/api/oauth/email/bind/start` | 用户 | 绑定邮箱：发送验证码 |
| POST | `/api/oauth/email/bind/resend` | 用户 | 绑定邮箱：重发验证码 |
| POST | `/api/oauth/email/bind` | 用户 | 绑定邮箱：提交验证码 |
| GET | `/api/oauth/wechat` | 公开 | 微信 OAuth 登录 |
| POST | `/api/oauth/wechat/bind` | 用户 | 绑定微信 |
| GET | `/api/oauth/telegram/login` | 公开 | Telegram 登录 |
| POST | `/api/oauth/telegram/bind/start` | 用户 | 创建 Telegram 绑定流程 |
| GET | `/api/oauth/telegram/bind/{flow_token}` | 用户 | 完成 Telegram 绑定 |

## 用户管理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/user/self` | 用户 | 当前用户信息与余额 |
| PUT | `/api/user/self` | 用户 | 更新自己的资料（含密码） |
| DELETE | `/api/user/self` | 用户 | 注销当前用户 **[destructive]** |
| GET | `/api/user/self/groups` | 用户 | 当前用户分组 |
| GET | `/api/user/models` | 用户 | 当前用户可用模型 |
| GET | `/api/user/token` | 用户 | 生成系统访问令牌（PAT） |
| GET | `/api/user/token/status` | 用户 | 查询访问令牌状态 |
| POST | `/api/user/token` | 用户 | 生成系统访问令牌（POST 形式） |
| DELETE | `/api/user/token` | 用户 | 撤销系统访问令牌 **[destructive]** |
| PUT | `/api/user/setting` | 用户 | 更新用户设置（通知等） |
| GET | `/api/user/aff` | 用户 | 获取邀请码 |
| POST | `/api/user/aff_transfer` | 用户 | 邀请额度转换为余额 |
| GET | `/api/user/passkey` | 用户 | Passkey 状态 |
| DELETE | `/api/user/passkey` | 用户 | 删除自己的 Passkey **[destructive]** |
| POST | `/api/user/passkey/register/begin` | 用户 | 注册 Passkey 开始 |
| POST | `/api/user/passkey/register/finish` | 用户 | 注册 Passkey 完成 |
| POST | `/api/user/passkey/verify/begin` | 用户 | 验证 Passkey 开始 |
| POST | `/api/user/passkey/verify/finish` | 用户 | 验证 Passkey 完成 |
| GET | `/api/user/` | 管理员 | 用户列表（分页；注意：不支持 group/status 过滤） |
| GET | `/api/user/search` | 管理员 | 搜索用户（keyword/group/role/status），支持 status=-1 查已删除 |
| GET | `/api/user/{id}` | 管理员 | 用户详情（含 admin_permissions） |
| POST | `/api/user/` | 管理员 | 创建用户（仅 username/password/display_name/role 生效） |
| PUT | `/api/user/` | 管理员 | 更新用户（仅 username/display_name/group/remark/password 生效） |
| POST | `/api/user/manage` | 管理员 | 用户操作：enable/disable/delete/promote/demote/add_quota **[destructive]** |
| DELETE | `/api/user/{id}` | 管理员 | 物理删除用户（不可恢复） **[destructive]** |
| DELETE | `/api/user/{id}/reset_passkey` | 管理员 | 重置用户 Passkey **[destructive]** |
| DELETE | `/api/user/{id}/2fa` | 管理员 | 管理员禁用用户两步验证 **[destructive]** |
| GET | `/api/user/2fa/stats` | 管理员 | 两步验证使用统计 |
| GET | `/api/user/{id}/oauth/bindings` | 管理员 | 查看用户第三方绑定 |
| DELETE | `/api/user/{id}/oauth/bindings/{provider_id}` | 管理员 | 解绑用户第三方账号 **[destructive]** |
| DELETE | `/api/user/{id}/bindings/{binding_type}` | 管理员 | 清除用户某类绑定（email/github/discord/oidc/wechat/telegram/linuxdo） **[destructive]** |
| GET | `/api/user/topup` | 管理员 | 全部充值记录 |
| POST | `/api/user/topup/complete` | 管理员 | 人工补单：将 pending 订单置为成功并发放额度 |
| GET | `/api/user/topup/info` | 用户 | 充值页信息（支付方式、单价、最低充值） |
| GET | `/api/user/topup/self` | 用户 | 自己的充值记录（限 30 天） |

## 两步验证与安全验证

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/user/2fa/status` | 用户 | 自己的 2FA 状态 |
| POST | `/api/user/2fa/setup` | 用户 | 生成 2FA 密钥与二维码 |
| POST | `/api/user/2fa/enable` | 用户 | 启用 2FA |
| POST | `/api/user/2fa/disable` | 用户 | 禁用 2FA |
| POST | `/api/user/2fa/backup_codes` | 用户 | 重新生成备用码 |
| GET | `/api/verify/methods` | 用户 | 可用的安全验证方式 |
| POST | `/api/verify` | 用户 | 通用安全验证，换取 X-Security-Proof |

## 渠道管理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/channel/` | admin+channel:read | 渠道列表（p/page_size/group/status/type/sort_by/tag_mode）；返回的 key 恒为空串 |
| GET | `/api/channel/search` | admin+channel:read | 搜索渠道（keyword/model/group/status/type），默认 page_size 为 20 |
| GET | `/api/channel/{id}` | admin+channel:read | 渠道详情（key 为空串） |
| GET | `/api/channel/models` | admin+channel:read | 内置模型目录（静态表，非本实例配置） |
| GET | `/api/channel/models_enabled` | admin+channel:read | 本实例已启用的模型名列表（来自 abilities 表） |
| GET | `/api/channel/default_base_urls` | admin+channel:read | 各渠道类型的默认 base_url |
| GET | `/api/channel/ops` | admin+channel:read | 渠道运维信息（含自动封禁状态） |
| GET | `/api/channel/tag/models` | admin+channel:read | 标签下模型并集（取模型最多的渠道） |
| GET | `/api/channel/{id}/vllm/status` | admin+channel:read | vLLM 渠道状态 |
| GET | `/api/channel/{id}/sglang/status` | admin+channel:read | SGLang 渠道状态 |
| GET | `/api/channel/{id}/codex/usage` | admin+channel:read | Codex 渠道用量 |
| GET | `/api/channel/{id}/codex/usage/reset-credits` | admin+channel:read | Codex 重置积分信息 |
| POST | `/api/channel/` | admin+channel:sensitive_write | 添加渠道（mode=single|batch|multi_to_single） |
| PUT | `/api/channel/` | admin+channel:write | 更新渠道（扁平 Channel 对象；不得携带 status） |
| PUT | `/api/channel/tag` | admin+channel:write | 按标签批量编辑渠道（注意此处字段名是 groups 复数） |
| POST | `/api/channel/batch/tag` | admin+channel:write | 按 id 批量设置标签 |
| POST | `/api/channel/upstream_updates/apply` | admin+channel:write | 应用单个渠道的上游模型更新 |
| POST | `/api/channel/upstream_updates/apply_all` | admin+channel:write | 应用全部渠道的上游模型更新 |
| POST | `/api/channel/status/batch` | admin+channel:operate | 批量启用/禁用渠道（status 只接受 1 或 2） |
| POST | `/api/channel/{id}/status` | admin+channel:operate | 启用/禁用单个渠道（status 只接受 1 或 2） |
| GET | `/api/channel/test` | admin+channel:operate | 发起全渠道测试任务（异步，返回 task_id；已有任务时返回 409） |
| GET | `/api/channel/test/{id}` | admin+channel:operate | 测试指定渠道，返回耗时秒数 |
| GET | `/api/channel/update_balance` | admin+channel:operate | 更新所有渠道余额（同步逐个查询，无明细返回） |
| GET | `/api/channel/update_balance/{id}` | admin+channel:operate | 更新指定渠道余额（balance 不在 data 里，在顶层） |
| GET | `/api/channel/fetch_models/{id}` | admin+channel:operate | 拉取已保存渠道的上游模型列表 |
| POST | `/api/channel/fetch_models` | admin+channel:sensitive_write | 用未保存的 key/base_url 试探上游模型列表 |
| POST | `/api/channel/fix` | admin+channel:operate | 重建 abilities 表（修复渠道-模型能力缓存） |
| POST | `/api/channel/tag/enabled` | admin+channel:operate | 按标签批量启用渠道 |
| POST | `/api/channel/tag/disabled` | admin+channel:operate | 按标签批量禁用渠道 |
| POST | `/api/channel/multi_key/manage` | admin+channel:operate | 多密钥管理：查询/启用/禁用/删除密钥 **[destructive]** |
| POST | `/api/channel/{id}/codex/usage/reset` | admin+channel:operate | 重置 Codex 渠道用量 |
| POST | `/api/channel/upstream_updates/detect` | admin+channel:operate | 检测单个渠道的上游模型变化 |
| POST | `/api/channel/upstream_updates/detect_all` | admin+channel:operate | 检测全部渠道的上游模型变化 |
| POST | `/api/channel/{id}/key` | Root | 读取渠道明文密钥；还需 X-Security-Proof 请求头 |
| POST | `/api/channel/copy/{id}` | admin+channel:sensitive_write | 复制渠道（suffix/reset_balance） |
| POST | `/api/channel/batch` | admin+channel:sensitive_write | 批量删除渠道 **[destructive]** |
| DELETE | `/api/channel/{id}` | admin+channel:sensitive_write | 删除渠道 **[destructive]** |
| DELETE | `/api/channel/disabled` | admin+channel:sensitive_write | 删除所有已禁用渠道（status 2/3） **[destructive]** |
| POST | `/api/channel/{id}/codex/refresh` | admin+channel:sensitive_write | 刷新 Codex 渠道凭据 |
| POST | `/api/channel/ollama/pull` | admin+channel:sensitive_write | Ollama 拉取模型 |
| POST | `/api/channel/ollama/pull/stream` | admin+channel:sensitive_write | Ollama 拉取模型（流式） |
| DELETE | `/api/channel/ollama/delete` | admin+channel:sensitive_write | Ollama 删除模型 **[destructive]** |
| GET | `/api/channel/ollama/version/{id}` | admin+channel:sensitive_write | Ollama 版本 |

## 模型元数据

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/models/` | 管理员 | 模型元数据列表（keyword/vendor/status/sync_official/square_state/include_channel_models） |
| GET | `/api/models/search` | 管理员 | 搜索模型元数据（同列表参数） |
| GET | `/api/models/{id}` | 管理员 | 模型元数据详情 |
| POST | `/api/models/` | 管理员 | 创建模型元数据 |
| PUT | `/api/models/` | 管理员 | 更新模型元数据（需 id；?status_only 只改状态） |
| GET | `/api/models/missing` | 管理员 | 已启用但缺少元数据的模型名列表 |
| GET | `/api/models/sync_upstream/preview` | 管理员 | 预览官方元数据同步（?locale=zh|en|ja），返回候选与 source_version |
| POST | `/api/models/sync_upstream` | 管理员 | 应用元数据同步；必须回传 source_version 与每个候选项的 record_version |
| DELETE | `/api/models/{id}` | 管理员 | 删除模型元数据（remove_from_channels/remove_pricing 可选） **[destructive]** |
| POST | `/api/models/delete` | 管理员 | 批量删除模型元数据 **[destructive]** |

## 定价与倍率

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/option/` | Root | 读取系统选项（敏感键被省略；含 ModelRatio/ModelPrice 等全部倍率表） |
| PUT | `/api/option/` | Root | 更新单个系统选项 {key,value}；value 为字符串，写 JSON 对象需传 JSON 字符串 |
| GET | `/api/option/model_pricing` | Root | 按模型读取定价快照（configured/effective/version），?model= 可重复 |
| PATCH | `/api/option/model_pricing` | Root | 按模型改写定价（changes[]，每项必须带 expected_version 做乐观锁） |
| POST | `/api/option/model_pricing/preview` | Root | 预览某模型定价的生效值，不写入 |
| POST | `/api/option/model_pricing/convert` | Root | 把倍率定价转换为 tiered_expr 表达式，不写入 |
| POST | `/api/option/rest_model_ratio` | Root | 把 ModelRatio 整体重置为内置默认值（只影响 ModelRatio） **[destructive]** |
| GET | `/api/ratio_sync/channels` | Root | 可用于同步倍率的渠道列表（含两个内置预设 id=-100/-101） |
| POST | `/api/ratio_sync/fetch` | Root | 抓取上游倍率并与本地比较（只读，不落库） |

## 系统选项与策略

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/option/request_policy` | Root | 读取请求策略（重试、自动禁用、敏感词、渠道亲和等） |
| PATCH | `/api/option/request_policy` | Root | 更新请求策略（值均为字符串） |
| PUT | `/api/option/passkey/domains` | Root | 更新 Passkey 允许域名 |
| POST | `/api/option/payment_compliance` | Root | 确认支付合规声明（创建兑换码等操作的前置条件） |
| GET | `/api/option/channel_affinity_cache` | Root | 渠道亲和缓存统计 |
| DELETE | `/api/option/channel_affinity_cache` | Root | 清空渠道亲和缓存 **[destructive]** |
| GET | `/api/option/waffo-pancake/catalog` | Root | Waffo Pancake 商品目录 |
| POST | `/api/option/waffo-pancake/pair` | Root | Waffo Pancake 配对 |
| POST | `/api/option/waffo-pancake/save` | Root | 保存 Waffo Pancake 配置 |
| POST | `/api/option/waffo-pancake/subscription-product` | Root | 创建 Waffo Pancake 订阅商品 |
| GET | `/api/option/waffo-pancake/subscription-product-options` | Root | Waffo Pancake 订阅商品选项 |

## 令牌管理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/token/` | 用户 | 自己的令牌列表（key 已掩码） |
| GET | `/api/token/search` | 用户 | 搜索自己的令牌（keyword/token） |
| GET | `/api/token/{id}` | 用户 | 自己的令牌详情（掩码） |
| POST | `/api/token/` | 用户 | 创建令牌；响应不返回密钥 |
| PUT | `/api/token/` | 用户 | 更新令牌（?status_only 只改状态） |
| GET | `/api/token/auto-groups` | 用户 | 自动分组可用分组与上限 |
| POST | `/api/token/{id}/key` | 用户 | 读取自己的令牌明文密钥 |
| POST | `/api/token/batch/keys` | 用户 | 批量读取自己的令牌密钥（最多 100） |
| DELETE | `/api/token/{id}` | 用户 | 删除令牌 **[destructive]** |
| POST | `/api/token/batch` | 用户 | 批量删除令牌 **[destructive]** |
| GET | `/api/usage/token/` | 用户 | 用令牌密钥查询该令牌用量（Authorization 传 sk- 密钥） |
| GET | `/api/log/token` | 用户 | 用令牌密钥查询该令牌的日志 |

## 兑换码

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/redemption/` | 管理员 | 兑换码列表 |
| GET | `/api/redemption/search` | 管理员 | 搜索兑换码（keyword/status，status 支持 expired） |
| GET | `/api/redemption/{id}` | 管理员 | 兑换码详情 |
| POST | `/api/redemption/` | 管理员 | 批量生成兑换码（name/count(1-100)/quota/expired_time），返回码数组 |
| PUT | `/api/redemption/` | 管理员 | 更新兑换码（?status_only 只改状态） |
| DELETE | `/api/redemption/{id}` | 管理员 | 删除兑换码 **[destructive]** |
| DELETE | `/api/redemption/invalid` | 管理员 | 删除全部无效兑换码（已用/禁用/过期） **[destructive]** |
| POST | `/api/redemption/batch` | 管理员 | 批量删除兑换码（最多 1000） **[destructive]** |
| POST | `/api/user/topup` | 用户 | 用户用兑换码充值 |

## 日志与统计

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/log/` | 管理员 | 全部日志（type/时间范围/username/model_name/channel/group/request_id 过滤） |
| GET | `/api/log/stat` | 管理员 | 日志统计 {quota,rpm,tpm}；quota 受时间范围影响，rpm/tpm 恒为最近 60 秒 |
| GET | `/api/log/search` | 管理员 | 已废弃：恒返回「该接口已废弃」，请改用 GET /api/log/ |
| GET | `/api/log/self` | 用户 | 自己的日志 |
| GET | `/api/log/self/stat` | 用户 | 自己的日志统计 |
| GET | `/api/log/self/search` | 用户 | 已废弃：恒返回「该接口已废弃」 |
| GET | `/api/log/channel_affinity_usage_cache` | 管理员 | 渠道亲和用量缓存统计 |
| GET | `/api/data/` | 管理员 | 按模型聚合的额度数据 |
| GET | `/api/data/users` | 管理员 | 按用户聚合的额度数据 |
| GET | `/api/data/flow` | 管理员 | 明细流水（start/end 时间必填且 end>=start） |
| GET | `/api/data/self` | 用户 | 自己的额度数据（跨度上限 30 天） |
| GET | `/api/data/flow/self` | 用户 | 自己的明细流水（跨度上限 30 天） |
| GET | `/api/audit` | 管理员 | 审计日志（需 audit:read 权限） |
| GET | `/api/audit/self` | 用户 | 自己的审计日志 |

## 分组

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/group/` | 管理员 | 全部组名（纯数组，不排序，不含倍率） |
| GET | `/api/prefill_group/` | 管理员 | 预填分组列表（?type= 过滤） |
| POST | `/api/prefill_group/` | 管理员 | 创建预填分组 |
| PUT | `/api/prefill_group/` | 管理员 | 更新预填分组（整体覆盖，需 id） |
| DELETE | `/api/prefill_group/{id}` | 管理员 | 删除预填分组 **[destructive]** |

## 供应商

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/vendors/` | 管理员 | 供应商列表（keyword/association） |
| GET | `/api/vendors/search` | 管理员 | 搜索供应商（同列表参数） |
| GET | `/api/vendors/{id}` | 管理员 | 供应商详情（含 model_count 与 version） |
| POST | `/api/vendors/` | 管理员 | 创建供应商 |
| PUT | `/api/vendors/` | 管理员 | 更新供应商（需 id；version 可作乐观锁） |
| POST | `/api/vendors/operations/preview` | 管理员 | 预览供应商运维操作（assign/merge/delete），返回 version 令牌 |
| POST | `/api/vendors/operations` | 管理员 | 应用供应商运维操作；必须回传 expected_version |
| DELETE | `/api/vendors/{id}` | 管理员 | 删除供应商（被模型引用时返回 409） **[destructive]** |

## 任务与日志任务

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/task/` | 管理员 | 全部任务 |
| GET | `/api/task/self` | 用户 | 自己的任务 |
| GET | `/api/task/{task_id}/artifacts` | 用户 | 任务产物 |
| GET | `/api/mj/` | 管理员 | 全部 Midjourney 任务 |
| GET | `/api/mj/self` | 用户 | 自己的 Midjourney 任务 |

## 系统任务与运维

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/system-task/log-cleanup` | Root | 创建日志清理任务（?target_timestamp=） **[destructive]** |
| GET | `/api/system-task/list` | Root | 系统任务列表 |
| GET | `/api/system-task/current` | Root | 当前运行中的系统任务 |
| GET | `/api/system-task/{task_id}` | Root | 系统任务详情 |
| DELETE | `/api/system-task/history` | Root | 删除系统任务历史 **[destructive]** |
| GET | `/api/system-info/instances` | Root | 多节点实例列表 |
| DELETE | `/api/system-info/stale-instances` | Root | 清理失效实例 **[destructive]** |
| DELETE | `/api/system-info/instances/{node_name}` | Root | 删除指定实例 **[destructive]** |
| GET | `/api/performance/stats` | Root | 性能统计 |
| GET | `/api/performance/logs` | Root | 日志文件列表 |
| DELETE | `/api/performance/logs` | Root | 清理日志文件 **[destructive]** |
| DELETE | `/api/performance/disk_cache` | Root | 清理磁盘缓存 **[destructive]** |
| POST | `/api/performance/reset_stats` | Root | 重置性能统计 **[destructive]** |
| POST | `/api/performance/gc` | Root | 强制 GC |
| GET | `/api/authz/catalog` | 管理员 | 权限目录（资源、动作、角色基线），用于权限编辑器 |

## 任务插件

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/plugin/task` | Root | 任务插件列表 |
| POST | `/api/plugin/task` | Root | 上传任务插件 |
| PUT | `/api/plugin/task` | Root | 更新任务插件 |
| GET | `/api/plugin/task/{key}` | Root | 任务插件详情 |
| GET | `/api/plugin/task/{key}/versions` | Root | 任务插件版本列表 |
| DELETE | `/api/plugin/task/{key}/versions/{version}` | Root | 删除任务插件版本 **[destructive]** |
| POST | `/api/plugin/task/{key}/activate` | Root | 激活任务插件版本 |
| POST | `/api/plugin/task/{key}/status` | Root | 设置任务插件状态 |
| POST | `/api/plugin/task/{key}/dryrun` | Root | 任务插件试运行 |
| GET | `/api/plugin/task/runtime/status` | Root | 任务插件运行时状态 |
| GET | `/api/plugin/task/marketplace/sources` | Root | 任务插件市场源 |
| PUT | `/api/plugin/task/marketplace/sources` | Root | 更新任务插件市场源 |
| GET | `/api/task_plugin_options` | 管理员 | 任务插件绑定选项（需 task_plugin:bind 权限） |

## 自定义 OAuth 提供商

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/custom-oauth-provider/` | Root | 自定义 OAuth 提供商列表 |
| GET | `/api/custom-oauth-provider/{id}` | Root | 自定义 OAuth 提供商详情 |
| POST | `/api/custom-oauth-provider/` | Root | 创建自定义 OAuth 提供商 |
| PUT | `/api/custom-oauth-provider/{id}` | Root | 更新自定义 OAuth 提供商 |
| DELETE | `/api/custom-oauth-provider/{id}` | Root | 删除自定义 OAuth 提供商 **[destructive]** |
| POST | `/api/custom-oauth-provider/discovery` | Root | 拉取 OIDC discovery 配置 |

## 支付与订阅

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/user/pay` | 用户 | 发起易支付 |
| POST | `/api/user/amount` | 用户 | 计算易支付金额 |
| POST | `/api/user/stripe/pay` | 用户 | 发起 Stripe 支付 |
| POST | `/api/user/stripe/amount` | 用户 | 计算 Stripe 金额 |
| POST | `/api/user/creem/pay` | 用户 | 发起 Creem 支付 |
| POST | `/api/user/waffo/amount` | 用户 | 计算 Waffo 金额 |
| POST | `/api/user/waffo/pay` | 用户 | 发起 Waffo 支付 |
| POST | `/api/user/waffo-pancake/amount` | 用户 | 计算 Waffo Pancake 金额 |
| POST | `/api/user/waffo-pancake/pay` | 用户 | 发起 Waffo Pancake 支付 |
| GET | `/api/user/epay/notify` | 公开 | 易支付回调（由支付方调用） |
| POST | `/api/stripe/webhook` | 公开 | Stripe Webhook |
| POST | `/api/creem/webhook` | 公开 | Creem Webhook |
| POST | `/api/waffo/webhook` | 公开 | Waffo Webhook |
| POST | `/api/waffo-pancake/webhook/{env}` | 公开 | Waffo Pancake Webhook |
| GET | `/api/subscription/plans` | 用户 | 订阅套餐列表 |
| GET | `/api/subscription/self` | 用户 | 自己的订阅 |
| PUT | `/api/subscription/self/preference` | 用户 | 订阅偏好设置 |
| GET | `/api/subscription/admin/plans` | 管理员 | 管理员：订阅套餐列表 |
| POST | `/api/subscription/admin/plans` | 管理员 | 管理员：创建订阅套餐 |
| PUT | `/api/subscription/admin/plans/{id}` | 管理员 | 管理员：更新订阅套餐 |
| PATCH | `/api/subscription/admin/plans/{id}` | 管理员 | 管理员：更新订阅套餐状态 |
| POST | `/api/subscription/admin/bind` | 管理员 | 管理员：为用户绑定订阅 |
| POST | `/api/subscription/admin/plans/{id}/subscriptions/reset` | 管理员 | 管理员：重置套餐下所有订阅 **[destructive]** |
| GET | `/api/subscription/admin/users/{id}/subscriptions` | 管理员 | 管理员：查看用户订阅 |
| POST | `/api/subscription/admin/users/{id}/subscriptions` | 管理员 | 管理员：创建用户订阅 |
| POST | `/api/subscription/admin/users/{id}/subscriptions/reset` | 管理员 | 管理员：重置用户订阅 **[destructive]** |
| POST | `/api/subscription/admin/user_subscriptions/{id}/invalidate` | 管理员 | 管理员：作废用户订阅 **[destructive]** |
| DELETE | `/api/subscription/admin/user_subscriptions/{id}` | 管理员 | 管理员：删除用户订阅 **[destructive]** |

## 模型部署 (IoNet)

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/deployments/` | 管理员 | 部署列表 |
| GET | `/api/deployments/search` | 管理员 | 搜索部署 |
| GET | `/api/deployments/{id}` | 管理员 | 部署详情 |
| GET | `/api/deployments/settings` | 管理员 | 部署设置 |
| POST | `/api/deployments/` | 管理员 | 创建部署 |
| PUT | `/api/deployments/{id}` | 管理员 | 更新部署 |
| PUT | `/api/deployments/{id}/name` | 管理员 | 更新部署名称 |
| POST | `/api/deployments/{id}/extend` | 管理员 | 延长部署 |
| DELETE | `/api/deployments/{id}` | 管理员 | 删除部署 **[destructive]** |
| GET | `/api/deployments/hardware-types` | 管理员 | 可选硬件类型 |
| GET | `/api/deployments/locations` | 管理员 | 可选区域 |
| GET | `/api/deployments/available-replicas` | 管理员 | 可用副本数 |
| POST | `/api/deployments/price-estimation` | 管理员 | 部署价格预估 |
| GET | `/api/deployments/check-name` | 管理员 | 检查集群名可用性 |
| GET | `/api/deployments/{id}/logs` | 管理员 | 部署日志 |
| GET | `/api/deployments/{id}/containers` | 管理员 | 部署容器列表 |
| GET | `/api/deployments/{id}/containers/{container_id}` | 管理员 | 容器详情 |
| POST | `/api/deployments/test-connection` | 管理员 | 测试 IoNet 连接 |
| POST | `/api/deployments/settings/test-connection` | 管理员 | 用给定设置测试 IoNet 连接 |

## 旧版看板计费

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/dashboard/billing/subscription` | 用户 | 旧版订阅信息（用令牌鉴权，非管理面板令牌） |
| GET | `/dashboard/billing/usage` | 用户 | 旧版用量信息（用令牌鉴权） |

## 未覆盖的路由

以下路由挂在同一后端但**不属于管理面板接口**，本索引与 CLI 均不覆盖：

- `/v1/*`、`/v1beta/*`、`/claude/*` 等 **AI 模型调用接口**（用 `sk-` 令牌鉴权，不是面板令牌），见 AI 模型接口文档。
- `/api/usage/token/`、`/api/log/token` 用**令牌密钥**鉴权（`Authorization: Bearer sk-...`），不是面板令牌；CLI 中对应 `tokens usage`。
- `/dashboard/billing/*` 旧版看板接口，用令牌鉴权。
- `/api/plugin/task/*` 任务插件管理与 `/api/deployments/*` 模型部署有管理接口，但属于独立子系统，CLI 未做类型化封装，可用 `newapi-admin api` 直接调用。

## 与官方 OpenAPI 文档的差异

以本表为准（它取自 `router/` 源码）。已知官方 `docs/openapi/api.json` 与源码不一致之处：

| 项目 | 文档写法 | 源码实际 |
| --- | --- | --- |
| 渠道分组字段 | `groups` | `group`（单数，逗号分隔） |
| 渠道列表过滤 | 未记载 `group` / `sort_by` / `sort_order` | 实际支持 |
| 多密钥操作枚举 | 缺 `enable_all_keys` / `disable_all_keys` | 实际支持 |
| 标签编辑请求体 | 未记载 `models` / `groups` / `priority` 等 | 实际支持 |

