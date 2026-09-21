# 约定与安全边界

先读这一篇。字段名可以在别处查，但这一篇里的规则决定了请求能不能成功。

## 鉴权

管理接口有两条鉴权路径，**推荐 access token**：

```
Authorization: Bearer <token>
```

- **Access Token**：在面板「个人设置 → 账户管理 → 安全设置 → 系统访问令牌」生成。长期的 Personal Access Token（PAT）或面板签发的短期 JWT 都可以。
- **Session**：`POST /api/user/login` 拿到的会话 Cookie。适合浏览器场景，脚本里不推荐。
- **`New-Api-User` 请求头**：**已废弃且不再参与鉴权**。老文档和部分旧版本仍要求它，带上无害（CLI 在设置了 `NEWAPI_USER_ID` 时会带），但不需要依赖它。
- **`X-Security-Proof` 请求头**：少数高危接口额外要求的二次验证证明，见下。

## 响应信封

**几乎所有失败都是 HTTP 200 加 `success: false`**。不要用状态码判断成败：

```json
{ "success": true,  "message": "",        "data": { } }
{ "success": false, "message": "参数错误", "data": null }
```

判读规则：

| 情况 | 表现 |
| --- | --- |
| 普通成功 | HTTP 200，`success: true` |
| 普通失败（权限、参数、业务） | **HTTP 200**，`success: false`，原因在 `message` |
| `/api/usage/token/` | 用 `code` 而非 `success` 表示成功 |
| 供应商接口 | 校验失败返回 HTTP 400；版本冲突返回 HTTP 409 且带 `code` |
| 上游模型元数据同步冲突 | HTTP 409 |
| 渠道测试任务已在运行 | HTTP 409 |
| 请求体不是合法 JSON | HTTP 400，`message: "Invalid request"` |

CLI 已经把这条规则封好了：它看信封而不是状态码，失败时把 `message` 原样报给你。

## 分页

参数名固定为 `p`（页码，从 1 开始）和 `page_size`。**`page_size` 服务端硬上限 100**，传再大也只返回 100。

`page_size` 还有两个历史别名 `ps`、`size`，仅在 `page_size` 缺失时生效。**默认值不统一**：

| 接口 | 默认 page_size |
| --- | --- |
| 大多数列表 | 10 |
| `GET /api/channel/search` | 20 |
| `GET /api/log/self` 等日志接口 | 10，且计数上限 10000 |

分页响应的形状也不统一：

- `/api/channel/`、`/api/user/`、`/api/token/`、`/api/log/`、`/api/redemption/`、`/api/vendors/`、`/api/models/` 返回 `{items, total, page, page_size}`。
- `/api/channel/search` 只返回 `{items, total}`，**没有** `page` / `page_size`。
- `/api/prefill_group/`、`/api/group/`、`/api/data/` 直接返回**数组**，不套分页。
- `/api/models/missing`、`/api/channel/models_enabled` 直接返回字符串数组。

CLI 的 `--all` 会按 `page_size=100` 翻页取全量，并对上述差异做归一化。

## 额度与金额换算

这是最容易算错的地方，四个量纲必须分清：

| 量 | 单位 | 说明 |
| --- | --- | --- |
| `quota` | 内部额度单位 | 用户余额、令牌余额、日志消耗都用它 |
| `QuotaPerUnit` | quota / USD | **1 USD = QuotaPerUnit 个 quota**，默认 `500000` |
| `ModelRatio` | 倍率 | **1 倍率 = $0.002 / 1K tokens = $2 / 1M tokens** |
| `ModelPrice` | USD | **按次固定价**，一旦设置，该模型忽略所有倍率 |

换算公式：

```
quota  = USD × QuotaPerUnit                        例：$10 → 5,000,000 quota
ratio  = USD_per_1M / 2                            例：$2.5/1M → ratio 1.25
USD    = quota / QuotaPerUnit
```

`QuotaPerUnit` 会被 Root 改，**不要硬编码 500000**。CLI 每次都从公开的 `GET /api/status` 读 `quota_per_unit`，所以 `--usd` 参数总是按实例真实设置换算。

余额上限 `MaxWalletQuota = 2^53-1 = 9007199254740991`（JS 安全整数上限），超过会被拒。

## 角色与状态

**角色 `role`**（`common/constants.go`）：

| 值 | 含义 | 能做什么 |
| --- | --- | --- |
| 0 | 游客 | 未登录残留值，不要主动设置 |
| 1 | 普通用户 | 自己的令牌、余额、日志 |
| 10 | 管理员 | 用户、渠道、日志、兑换码、模型管理 |
| 100 | Root | 系统选项、倍率定价、系统任务、渠道密钥 |

权限判定的通则是 **`我的角色 > 目标角色`** 才能操作目标；Root 例外。所以管理员不能操作另一个管理员，也不能创建高于自己角色的用户。

**用户状态 `status`**：`1` 启用，`2` 禁用。**没有 3**。删除是软删除（`deleted_at`），搜索时用 `status=-1` 查已删除用户。

**渠道状态 `status`**：`1` 启用，`2` 手动禁用，`3` 自动禁用。`0` 是未设置，永远不要写。**客户端只能设置 1 或 2**，3 由系统自动封禁写入。

**渠道类型 `type`** 是数字码，常用值：`1` OpenAI、`3` Azure、`14` Anthropic、`24` Gemini、`43` DeepSeek、`20` OpenRouter、`33` AWS、`41` VertexAI、`57` Codex、`58` AdvancedCustom、`60` NewAPI、`61` TaskPlugin、`62` vLLM、`63` SGLang。完整表见 [channels.md](channels.md)。CLI 接受 `--type 14` 也接受 `--type Anthropic`。

## 两个 sentinel 值不一样

最容易踩的坑：

| 实体 | 「永不过期」怎么表示 |
| --- | --- |
| 令牌 `expired_time` | **`-1`** |
| 兑换码 `expired_time` | **`0`** |

写反了不会报错，只会得到一个立刻过期或永不过期的对象。

## 哪些接口不能改哪些字段

接口静默忽略未列出的字段——**不报错，但也没生效**。这些是最容易「以为改了其实没改」的地方：

| 接口 | 真正生效的字段 | 被忽略的 |
| --- | --- | --- |
| `PUT /api/user/` | `username`、`display_name`、`group`、`remark`、`password` | `role`、`status`、`quota`、`email` |
| `POST /api/user/` | `username`、`password`、`display_name`、`role` | `email`、`quota`、`group` |
| `PUT /api/channel/` | 见 [channels.md](channels.md) | `status`（**会整个请求报错**）、`created_time`、`test_time`、`response_time`、`balance`、`used_quota`、`channel_info` |

所以：

- 改角色/状态/额度 → 用 `POST /api/user/manage`
- 改分组 → 用 `PUT /api/user/`（生效，并且会踢掉该用户全部登录会话）
- 启停渠道 → 用 `POST /api/channel/{id}/status`

## 写 JSON 对象时 value 必须是字符串

`PUT /api/option/` 的请求体是**单个** `{key, value}`，没有批量形式。`value` 会被强制转成字符串：`bool` → `"true"`，数字 → 十进制字符串，**对象/数组 → `fmt.Sprintf("%v", ...)`，也就是被破坏**。

所以倍率表要这样写：

```json
{ "key": "ModelRatio", "value": "{\"gpt-4o\":1.25}" }
```

而不是 `"value": {"gpt-4o": 1.25}`。CLI 的 `pricing options-set` 已经按正确形式发送。

## 乐观锁（并发保护）

三处需要**先读版本号再回传**，否则 409：

| 场景 | 版本字段 | 取法 |
| --- | --- | --- |
| 按模型改定价 | `expected_version` | `GET /api/option/model_pricing` 的 `entries[].version`；新模型用 `empty_version` |
| 应用上游模型元数据同步 | `source_version` + 每条 `record_version` | `GET /api/models/sync_upstream/preview` |
| 供应商合并/删除/改派 | `expected_version` | `POST /api/vendors/operations/preview` 的 `version` |

这是**确认机制**：preview 之后上游若被改动，apply 会失败而不是覆盖别人的修改。CLI 已把「读取版本 → 回传」串成一步（`pricing set`、`models sync-apply`、`vendors merge`），你不需要手工搬运。

## 危险操作清单

以下操作不可逆或影响面大，CLI 要求 `--yes`，MCP 要求 `confirm: true`：

| 操作 | 后果 |
| --- | --- |
| `DELETE /api/user/{id}` | **物理删除**，行直接消失；软删除是 `manage --action delete` |
| `DELETE /api/redemption/invalid` | 一次删掉所有已用 + 已禁用 + 已过期的兑换码 |
| `DELETE /api/channel/disabled` | 一次删掉所有禁用渠道 |
| `POST /api/option/rest_model_ratio` | 整表 `ModelRatio` 覆盖为内置默认，自定义倍率全丢（`ModelPrice` 等不受影响） |
| `POST /api/system-task/log-cleanup` | 按时间点清理日志 |
| `channels key`、`POST /api/channel/{id}/key` | 读取渠道明文密钥 |

**改价前先备份**：`pricing options-get --key ModelRatio --json > modelratio.json`。`rest_model_ratio` 没有撤销。

## 磁盘上会留下什么

- **访问令牌**：CLI 读 `NEWAPI_ACCESS_TOKEN` 或 `~/.config/newapi-admin/config.json`。配置文件请 `chmod 600`，并确保加入 `.gitignore`。
- CLI 输出中令牌**永远只显示掩码**（前 4 位 + 10 个 `*` + 后 4 位）。
- 渠道密钥、令牌密钥本身由 API 返回（`channel key`、`tokens key`），一旦打印就会进入终端历史和上下文，别写进日志或提交到仓库。

## 权限不足的典型表现

返回 HTTP 200 且 `success: false`，`message` 形如「无权进行此操作，权限不足」或「无权进行此操作，未登录且未提供 access token」。区分：

| message | 原因 |
| --- | --- |
| `未登录且未提供 access token` | 令牌缺失、错误，或请求头格式不对 |
| `权限不足` | 令牌有效但角色不够（例如拿管理员令牌调 Root 接口） |
| 渠道相关「权限不足」而角色已是管理员 | 缺 `channel:sensitive_write`，默认只有 Root 有 |

## 时间格式

接口一律使用 **Unix 秒**（字符串或数字）。CLI 的 `--start` / `--end` / `--before` 同时接受 Unix 秒和 `2024-01-01`、`2024-01-01T08:00:00Z` 这类可解析时间。

`data flow` 系列接口**必须**同时给起止时间，且 `end >= start`；用户自助接口跨度上限 30 天。

## 用 CLI 还是直接用 HTTP

- 日常运维、需要换算（USD ↔ quota ↔ ratio）、需要串多步（读版本再写）→ 用 CLI 子命令。
- 没有类型化封装的子系统（任务插件、模型部署、订阅）→ 用 `newapi-admin api <METHOD> <PATH>`。
- 只要一条命令覆盖不到的路由，`api` 都能到；它不是兜底，是设计的一部分。
