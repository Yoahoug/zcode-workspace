---
name: newapi-admin
description: Administer a New API (new-api) instance through its management API — channels, model metadata, model pricing and ratios, users, tokens, redemption codes, logs, statistics, groups, vendors, and root system options. Use when the user asks to inspect or change anything on their New API deployment: add/edit/test/disable an upstream channel, sync upstream model metadata, set or bulk-edit model prices (ModelRatio/ModelPrice), adjust a user's balance or group, generate or revoke redemption codes, read logs and usage, clean up logs, or change system configuration. Also use when a request mentions New API, newapi, one-api-compatible gateways, channel balance, model 倍率/定价, 兑换码, or 渠道管理.
---

# New API 管理员运维

通过管理接口对 New API 实例做完整的管理员操作。核心事实：**几乎所有失败都返回 HTTP 200 加 `success: false`**，判成败要看响应体里的信封，不是状态码。

## 两种使用方式

**优先用 MCP 工具**（如果 `newapi-admin` 插件的 MCP 服务已启用）：

- `newapi_request` — 通用请求，能到达**全部 295 条**管理路由。探索未知接口、或类型化工具没覆盖的子系统都用它。
- `newapi_routes` — 搜索路由索引（方法、路径、权限层级、用途），用来找「该调哪个接口」。
- `newapi_reference` — 读本插件的参考文档，改动前先读。
- 类型化工具：`newapi_status`、`newapi_channels_list`、`newapi_channel_test`、`newapi_models_list`、`newapi_models_sync_preview`、`newapi_models_sync_apply`、`newapi_pricing_get`、`newapi_pricing_set`、`newapi_pricing_cost`、`newapi_users_list`、`newapi_user_quota`、`newapi_logs`。

**没有 MCP 时用 CLI**（Bash）：

```bash
node <插件根>/scripts/newapi-admin.mjs <命令组> <子命令> [参数] [选项]
```

本文件位于 `<插件根>/skills/newapi-admin/SKILL.md`，所以 CLI 就在**本文件往上两层**的 `scripts/newapi-admin.mjs`：

```bash
node "$(dirname <本文件路径>)/../../scripts/newapi-admin.mjs" --help
```

CLI 和 MCP 是同一个核心（`lib/core.mjs`）的两个外壳，命令与工具一一对应，行为一致。

## 配置

连接信息按以下优先级解析（高到低）：

1. 命令行选项 `--base-url` / `--token` / `--user-id`
2. 环境变量（**与官方 `newapi` skill 同名，一套配置两边通用**）：
   - `NEWAPI_BASE_URL` — 实例地址，如 `https://api.example.com`
   - `NEWAPI_ACCESS_TOKEN` — **管理员或 Root 的访问令牌**
   - `NEWAPI_USER_ID` — 可选，用于已废弃的 `New-Api-User` 头
   - `NEWAPI_SECURITY_PROOF` — 可选，高危接口的二次验证证明
3. 配置文件 `~/.config/newapi-admin/config.json`（`{"baseUrl":"...","token":"..."}`），请 `chmod 600`

令牌在面板「个人设置 → 账户管理 → 安全设置 → 系统访问令牌」生成。

**先验证连通性**，再动手：

```bash
newapi-admin ping                       # 版本 + QuotaPerUnit + 数据库连通性
newapi-admin config                     # 看解析到的配置（令牌已掩码）
```

## 先读参考文档

改动前读对应的参考。这些文档记录了源码里才能看到的确切字段名、单位和权限层级——凭直觉写会静默失效或直接报错。

| 文档 | 何时读 |
| --- | --- |
| `references/conventions.md` | **第一次用时必读**。鉴权、信封、分页、额度换算、权限层级、危险操作 |
| `references/models-and-pricing.md` | 改模型价格、倍率、同步模型元数据 |
| `references/channels.md` | 增删改渠道、测试、标签、多密钥、上游模型 |
| `references/users.md` | 用户增删改、额度、角色、绑定 |
| `references/tokens-and-redemptions.md` | 令牌与兑换码 |
| `references/logs-and-stats.md` | 日志、统计、用量聚合、审计 |
| `references/system-and-options.md` | 系统选项、请求策略、分组、供应商、系统任务 |
| `references/endpoints.md` | 全量 295 条路由索引（含权限层级） |

## 三个必须记住的换算

```bash
newapi-admin pricing cost --model gpt-4o --prompt-tokens 1000 --completion-tokens 500
```

| 量 | 规则 |
| --- | --- |
| **quota** | `1 USD = QuotaPerUnit 个 quota`，默认 500000，Root 可改 |
| **ModelRatio** | `1 倍率 = $2 / 1M tokens`，所以 `ratio = USD_per_1M ÷ 2` |
| **ModelPrice** | **按次固定价（USD）**。一旦设置，该模型完全忽略所有倍率 |

CLI 的 `--usd` / `--usd-per-1m` 会按实例真实设置换算，**优先用它们而不是自己算 quota**。

## 高频操作

### 盘点与排查

```bash
newapi-admin ping                                          # 实例是否正常
newapi-admin channels list --all                           # 全部渠道与状态
newapi-admin channels list --status disabled               # 谁来着被禁用了
newapi-admin channels search --model gpt-4o                # 哪些渠道供这个模型
newapi-admin channels test 12                              # 单渠道连通性（返回秒数）
newapi-admin channels balance 12                           # 单渠道余额（USD）
newapi-admin models missing                                # 能用但没元数据的模型
newapi-admin logs list --type error --start 2024-01-01 --all
newapi-admin logs stat --start 2024-01-01 --end 2024-02-01
```

### 改模型价格（最常见的需求）

```bash
# 1. 先备份
newapi-admin pricing options-get --key ModelRatio --json > /tmp/modelratio.backup.json

# 2. 看现状
newapi-admin pricing get --model gpt-4o

# 3. 改（CLI 自动完成「读版本 → 回传版本」的乐观锁）
newapi-admin pricing set --model gpt-4o --usd-per-1m 2.5 --completion-ratio 4
newapi-admin pricing set --model dall-e-3 --price 0.04        # 改为按次固定价
newapi-admin pricing set --model old --reset                   # 恢复默认

# 4. 批量
newapi-admin pricing bulk --file changes.json

# 5. 验证
newapi-admin pricing cost --model gpt-4o --prompt-tokens 1000 --completion-tokens 500
```

定价接口是 **Root only**。报「权限不足」就说明令牌角色不够。

### 同步模型元数据

官方目录同步是**两步确认**流程，`source_version` 就是确认令牌：

```bash
newapi-admin models sync-preview --locale zh --save /tmp/preview.json
# 查看 kind：create / update / unchanged / missing_upstream / missing_vendor / blocked
newapi-admin models sync-apply --from-preview /tmp/preview.json --kinds create,update
```

同步**只写元数据**（描述、图标、供应商、端点等），**不设价格、不删记录**。同步完新模型仍然没有价格，需要接着 `pricing set`，否则中继会以「价格未配置」拒绝。

### 加渠道

```bash
newapi-admin channels add --name relay --type Anthropic --key sk-xxx \
  --models claude-sonnet-4 --group default,vip --base-url https://api.anthropic.com

newapi-admin channels test <新id>
newapi-admin channels fix          # 能力表对不上时重建
```

注意：**默认情况下普通管理员没有 `channel:sensitive_write` 权限**，新增和删除渠道会报「权限不足」。这是设计如此，需要 Root 令牌或由 Root 单独授权。

### 用户额度

```bash
newapi-admin users quota 2 --usd 10                    # 加 $10
newapi-admin users quota 2 --mode override --usd 0     # 清零
newapi-admin users manage 2 --action disable
newapi-admin users search --group vip
```

`users delete` 是**物理删除**；软删除用 `users manage <id> --action delete`。

## 安全规则

1. **破坏性操作会要求 `--yes`**（MCP 中要求 `confirm: true`）。这不是障碍，是提示你确认范围：先 `--dry-run` 看请求，或先用查询命令确认影响面。
2. **改价前先备份倍率表**。`pricing reset-model-ratio` 和整表替换没有撤销。
3. **先小范围验证再批量**。`channels test 12` 通过再批量启停；`pricing set` 单个成功再 `pricing bulk`。
4. **不要在输出里泄露密钥**。渠道密钥和令牌密钥一旦打印就进入终端历史与上下文。只在确实需要时读，别写进文件或提交。
5. **不确定影响面就先查**。批量删除类命令（`delete-invalid`、`delete-disabled`、`batch-delete`）执行前一定要先 `list`/`search` 确认范围。

## 权限不够时的判断

| 报错 | 原因 |
| --- | --- |
| `未登录且未提供 access token` | 令牌缺失、错误，或请求头格式不对 |
| `权限不足` | 令牌有效但角色不够（例如管理员令牌调 Root 接口） |
| 渠道操作报「权限不足」而角色已是管理员 | 缺 `channel:sensitive_write`，默认只有 Root 有 |
| 读渠道密钥报 `SECURITY_PROOF_REQUIRED` | 该接口需要 Root + `X-Security-Proof` 头 |
| `MODEL_PRICING_CONFLICT` / HTTP 409 | 版本号过期（有人刚改过），重新读取版本再改 |

## 覆盖不到的地方

下面这些子系统有管理接口，但 CLI 没有做类型化封装，用 `newapi-admin api <METHOD> <PATH>` 直接调（`newapi_routes` 里能查到完整路径）：

- 任务插件管理 `/api/plugin/task/*`
- 模型部署（IoNet）`/api/deployments/*`
- 订阅套餐 `/api/subscription/admin/*`
- 自定义 OAuth 提供商 `/api/custom-oauth-provider/*`
- 支付回调 `/api/*/webhook`

`api` 不是兜底方案，是设计的一部分：

```bash
newapi-admin api GET /api/subscription/admin/plans --json
newapi-admin api PUT /api/custom-oauth-provider/3 --body '{"enabled":true}'
```

## 自检

改完之后验证效果，不要只看「命令没报错」：

```bash
newapi-admin pricing get --model gpt-4o          # 价格真改了吗
newapi-admin channels list --status enabled      # 渠道真启用了吗
newapi-admin users get 2                         # 余额真变了吗
newapi-admin logs list --start 2024-01-01        # 有没有新的报错
```

插件自带契约测试，改插件本身时跑：

```bash
node test/run-checks.mjs        # CLI，121 项
node test/run-mcp-checks.mjs    # MCP，51 项
```
