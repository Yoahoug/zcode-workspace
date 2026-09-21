# New API Admin — ZCode 插件

对 [New API](https://github.com/QuantumNous/new-api)（new-api）实例做**完整管理员运维**的 ZCode 插件。

New API 官方文档里有一个「开发中」的 `newapi-admin` skill 计划，只列了少数功能预览。这个插件把那份计划做完整了：**覆盖全部 295 条管理路由**，并把接口契约沉淀成可查阅、可验证的参考文档。

## 包含什么

| 组件 | 说明 |
| --- | --- |
| **MCP 服务** | stdio JSON-RPC，15 个工具（1 个覆盖全部路由的通用工具 + 类型化工具）。`newapi_request` 能到达全部路由，另有渠道/模型/定价/用户/日志的类型化工具 |
| **CLI** | `scripts/newapi-admin.mjs`，零依赖，纯 Node 内置模块。同样的能力，可独立使用、可进 CI |
| **Skill** | `skills/newapi-admin/SKILL.md` + 8 篇参考文档，字段级细节来自 New API 源码 |
| **契约测试** | 174 项端到端检查跑在按官方契约实现的 mock 服务上，另有 161 项文档一致性检查 |

## 为什么不是「照着 OpenAPI 生成一遍」

官方文档站的 OpenAPI 文档（161 个操作）和实际代码有出入，直接照抄会写出**能发出去但不生效**的请求。已知几处：

| 项目 | 官方文档 | 源码实际 |
| --- | --- | --- |
| 渠道分组字段 | `groups` | **`group`**（单数，逗号分隔） |
| 标签编辑请求体字段 | `groups`（未说明与上者的关系） | 这里**确实**是 `groups` |
| 渠道列表过滤 | 未记载 `group` / `sort_by` / `sort_order` | 实际支持 |
| 多密钥操作枚举 | 缺 `enable_all_keys` / `disable_all_keys` | 实际支持 |
| 渠道状态含义 | 网页前端注释写成 0/1/2 | 实际是 **1/2/3** |

本插件的路由表取自 `router/` 源码（295 条），字段表逐条对照 `model/` 下的结构体与 `controller/` 下的处理器，并把「静默忽略字段」「顶层 vs data 字段位置」「sentinel 值不一致」这类坑单独列出。

## 安装

### 1. 添加市场并安装

本插件属于 [zcode-workspace](../README.md) 市场，位于该仓库的 `plugins/newapi-admin/`。

在 ZCode 里打开 **插件市场 → 添加 → 添加插件市场**，二选一：

- **直接粘贴仓库地址**（推荐）：

```
https://github.com/Yoahoug/zcode-workspace
```

- **本地目录**：克隆本仓库后选择**仓库根目录**（不是 `plugins/` 子目录）

然后在 **个人 → zcode-workspace → New API Admin → 安装**。已经装过该市场里其他插件的话，
刷新一下市场就能看到本插件。

### 2. 配置连接

安装后在插件设置里填两项，或者用环境变量（与官方 `newapi` skill 同名，一套配置两边通用）：

```bash
export NEWAPI_BASE_URL=https://api.example.com
export NEWAPI_ACCESS_TOKEN=your-access-token
```

| 设置 | 说明 |
| --- | --- |
| `base_url` | 实例地址，如 `https://api.example.com` |
| `access_token` | **管理员或 Root 访问令牌**，在面板「个人设置 → 账户管理 → 安全设置 → 系统访问令牌」生成（只显示一次） |
| `user_id` | 可选，对应已废弃的 `New-Api-User` 头 |
| `timeout_ms` | 单请求超时，默认 30000 |

也可以写配置文件 `~/.config/newapi-admin/config.json`（请 `chmod 600`）：

```json
{ "baseUrl": "https://api.example.com", "token": "..." }
```

> **读渠道密钥是唯一的例外**：那条路由要求 Root + 浏览器**会话凭证** + 一次性的 `X-Security-Proof`，而访问令牌按设计没有会话身份，无论怎么配都会被拒。插件配置里没有这个字段是有意的——会话凭证随登录会话过期，写进配置文件只会制造难以排查的失败。要用就用命令行：`channels key 3 --session-token <会话 JWT> --verify-code <动态码>`，或者直接在面板里看。详见 [references/channels.md](skills/newapi-admin/references/channels.md)。

### 3. 验证

```bash
node <插件目录>/scripts/newapi-admin.mjs ping
```

输出实例版本、`QuotaPerUnit` 和数据库连通性。

## 权限：Root 和普通管理员差别很大

| 能力 | 管理员（role 10） | Root（role 100） |
| --- | --- | --- |
| 查看渠道、测试、余额、日志、用户 | ✅ | ✅ |
| **新增 / 删除 / 复制渠道** | ❌ 默认无 `channel:sensitive_write` | ✅ |
| 读取渠道明文密钥 | ❌ | ✅（还需 `X-Security-Proof`） |
| **定价与倍率** | ❌ Root only | ✅ |
| 系统选项、系统任务、性能 | ❌ | ✅ |
| 用户增删改、额度 | ✅（不能操作同级或更高级） | ✅ |

要完整使用定价和系统配置，**请用 Root 令牌**。

## CLI 用法

```bash
newapi-admin <命令组> <子命令> [参数] [选项]
```

### 核心命令

```bash
newapi-admin ping                                  # 实例健康 + QuotaPerUnit
newapi-admin config                                # 解析到的配置（令牌掩码）
newapi-admin routes pricing                        # 搜索路由索引
newapi-admin api GET /api/subscription/admin/plans # 到达任意路由
```

### 全域覆盖

`api` 子命令能到达**全部 295 条**管理路由，包括没有类型化封装的子系统（任务插件、模型部署、订阅、自定义 OAuth）：

```bash
newapi-admin api GET  /api/plugin/task --json
newapi-admin api POST /api/deployments/ --body '{"name":"x"}'
```

### 常用操作

```bash
# 渠道
newapi-admin channels list --all
newapi-admin channels list --status disabled
newapi-admin channels test 12
newapi-admin channels add --name relay --type Anthropic --key sk-xxx --models claude-sonnet-4
newapi-admin channels disable 12                  # update 不接受 status 字段
newapi-admin channels delete 12 --yes

# 模型元数据 + 定价
newapi-admin models missing
newapi-admin models sync-preview --locale zh --save /tmp/preview.json
newapi-admin models sync-apply --from-preview /tmp/preview.json --kinds create,update
newapi-admin pricing get --model gpt-4o
newapi-admin pricing set --model gpt-4o --usd-per-1m 2.5 --completion-ratio 4
newapi-admin pricing cost --model gpt-4o --prompt-tokens 1000 --completion-tokens 500

# 用户 / 令牌 / 兑换码
newapi-admin users quota 2 --usd 10
newapi-admin users manage 2 --action disable
newapi-admin tokens create --name ci --usd 10
newapi-admin redemptions create --name promo --count 20 --usd 5

# 日志与统计
newapi-admin logs list --type error --start 2024-01-01 --all
newapi-admin logs stat --start 2024-01-01 --end 2024-02-01
newapi-admin data usage --start 2024-01-01 --end 2024-02-01
```

`newapi-admin help <命令组>` 看某一组的全部子命令。

### 全局选项

| 选项 | 作用 |
| --- | --- |
| `--json` | 输出原始响应 `data`，而不是摘要表格 |
| `--dry-run` | 只打印将要发出的请求，不发送 |
| `--yes` | 确认破坏性操作 |
| `--all` | 自动翻页取全量 |
| `--base-url` / `--token` | 覆盖连接配置 |

### 单位换算

CLI 的 `--usd`、`--usd-per-1m` 会**按实例真实的 `QuotaPerUnit` 换算**，而不是硬编码 500000。三个量纲的关系：

```
1 USD        = QuotaPerUnit 个 quota          （默认 500000）
1 ModelRatio = $2 / 1M tokens                 （ratio = USD_per_1M ÷ 2）
ModelPrice   = 按次固定价（USD），设置后完全绕过倍率
```

## MCP 工具

配置好插件后，模型可直接调用：

| 工具 | 用途 |
| --- | --- |
| `newapi_request` | 通用请求，覆盖全部路由；破坏性请求须 `confirm: true` |
| `newapi_routes` | 搜索路由索引（方法、路径、权限层级、用途） |
| `newapi_reference` | 读取内置参考文档（8 个主题） |
| `newapi_status` | 实例健康与换算基准 |
| `newapi_channels_list` / `newapi_channel_test` | 渠道盘点与连通性 |
| `newapi_models_list` | 模型元数据 |
| `newapi_models_sync_preview` / `newapi_models_sync_apply` | 元数据同步（带版本确认） |
| `newapi_pricing_get` / `newapi_pricing_set` / `newapi_pricing_cost` | 定价读写与成本估算 |
| `newapi_users_list` / `newapi_user_quota` | 用户与额度 |
| `newapi_logs` | 请求日志 |

类型化工具会做单位换算和字段名解码（`type: 14` → `Anthropic`，`status: 2` → `manually-disabled`），并把 `--json` 才会看到的原始字段整理成可读结构。要原始响应就用 `newapi_request`。

读渠道密钥不在 MCP 里，也不在插件配置里——它需要浏览器会话凭证和一次性安全验证，见上面的说明。要读就用 CLI 或在面板里看。

## 参考文档

入口是 [references/README.md](skills/newapi-admin/references/README.md)（含「最容易踩的八个坑」与乐观锁速查），
`skills/newapi-admin/references/` 下另有 8 篇专题文档：

| 文档 | 内容 |
| --- | --- |
| `conventions.md` | 鉴权、响应信封、分页、额度换算、权限层级、危险操作、静默忽略字段 |
| `channels.md` | 渠道完整字段表、类型码表（64 种）、状态码、标签、多密钥、上游模型 |
| `models-and-pricing.md` | 计费公式、三种改价接口、乐观锁、模型元数据、官方目录同步 |
| `users.md` | 角色/状态、可写字段、额度调整、补单、绑定、细粒度权限 |
| `tokens-and-redemptions.md` | 令牌（用户级作用域）与兑换码（管理员级） |
| `logs-and-stats.md` | 日志类型与字段、统计的时间语义陷阱、用量聚合、审计 |
| `system-and-options.md` | 系统选项键表、请求策略、分组、供应商两阶段运维、系统任务 |
| `endpoints.md` | **全部 295 条路由**索引，由 `tools/generate-endpoints.mjs` 生成 |

## 开发者

```bash
node test/run-checks.mjs            # CLI 契约检查，121 项
node test/run-mcp-checks.mjs        # MCP 契约检查，53 项
node test/run-doc-checks.mjs        # 文档与实现一致性检查，161 项
node tools/generate-endpoints.mjs   # 重新生成 endpoints.md
node test/mock-server.mjs           # 单独起 mock 服务
```

`npm test` 会依次跑完前三套（共 335 项）。

测试是**契约测试**：每条用例把真实 CLI 作为子进程跑在 mock 服务上，同时断言输出**和它实际发出的 HTTP 请求**（方法、路径、查询、请求体）。所以测试证明的是「CLI 说的是服务端要的话」，而不只是「代码能跑」。

mock 服务（`test/mock-server.mjs`）刻意复刻了那些容易踩的契约细节：失败返回 HTTP 200、渠道读不到 key、`PUT /api/channel/` 拒绝 `status`、余额和测试耗时在顶层而非 `data`、`/api/log/search` 恒失败、定价与元数据同步的乐观锁、`page_size` 上限 100。

### 重新生成路由索引

路由表是**手工维护**的数据（`lib/routes.mjs`），因为上游三处来源不一致，必须以 `router/` 源码为准。修改后重新生成文档：

```bash
node tools/generate-endpoints.mjs
```

### 加一个类型化命令

1. 在 `lib/routes.mjs` 里补路由（如果它是新路由）
2. 在 `scripts/newapi-admin.mjs` 里加子命令分发
3. 在 `help` 文本里补一行
4. 在 `test/run-checks.mjs` 里加一条用例，断言请求体形状
5. 需要在 MCP 里暴露就改 `server/index.mjs` 的 `TOOLS` 与 `callTool`
6. `npm test`

## 安全提示

- 令牌在 CLI 输出里**永远只显示掩码**，但渠道密钥和令牌密钥一旦读取就会进入终端历史和模型上下文——只在确实需要时读。
- 破坏性操作需要 `--yes`（MCP 需 `confirm: true`）。这是范围确认，不是障碍：先 `--dry-run` 看请求，或先查询确认影响面。
- 改价前备份倍率表：`newapi-admin pricing options-get --key ModelRatio --json > backup.json`。`pricing reset-model-ratio` 与整表替换不可撤销。
- 环境变量或配置文件里的令牌请勿提交到仓库。

## 在市场里发布和更新

本插件是 [zcode-workspace](../README.md) 市场的一员：仓库根是市场根，本目录是其中一个插件，
在 `.claude-plugin/marketplace.json` 里的 `source` 为 `./plugins/newapi-admin`。

- **更新版本**：改了功能就递增**两处**版本号并保持描述一致 —— 本目录 `.zcode-plugin/plugin.json`
  与 `.claude-plugin/marketplace.json` 里本插件的条目。推到 GitHub 后使用者刷新市场即可看到新版本。
- **同步 `.mcp.json`**：`plugin.json` 的 `mcpServers` 与同目录 `.mcp.json` 内容必须一致，改一处就改另一处。
- **加进别的市场**：把本目录整个复制到那个仓库的插件目录，在其市场清单里登记一条即可，`source`
  指向复制后的位置。

新增插件的完整约定见仓库根 [README.md](../README.md)。

## 许可

MIT，仓库根另有 [LICENSE](../LICENSE)。
