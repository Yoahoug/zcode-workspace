# Qinglong Admin — ZCode 插件

青龙（Qinglong 2.x）定时任务面板的管理插件：把面板的**远程 OpenAPI 全量面**（143 条已收录路由）、**逐资源字段参考**、**处方集**、**交叉坑清单**和**本机部署事实**做成了可执行的工具——**零依赖 CLI + MCP 服务 + 技能**三件套，而不只是文档。

## 包含什么

| 组件 | 说明 |
| --- | --- |
| **MCP 服务** | stdio JSON-RPC，22 个工具（1 个覆盖全部路由的通用工具 + 21 个类型化工具）。`qinglong_request` 能到达每一条路由；任务/环境变量/订阅/依赖/日志/仪表盘有类型化工具，把「整表提交」「accepted≠success」「字节偏移」「数字 vs 枚举」这些坑固化进参数与返回 |
| **CLI** | `scripts/qinglong-admin.mjs`，零依赖、纯 Node 内置模块（≥18)。能力与 MCP 相同，可独立使用、可进 CI；`--dry-run` 打印将要发送的请求，破坏性路由必须 `--yes` |
| **Skill** | `skills/qinglong-admin/SKILL.md` + 16 篇参考文档：路由全表、逐资源 OpenAPI、处方集、交叉坑、面板本机部署与运维 |
| **契约测试** | 80 项 CLI 检查 + 61 项 MCP 检查，全部跑在按面板契约实现的 mock 服务上；另有文档漂移守卫（路由表/工具表/版本四处一致性） |

## 为什么不是直接包装 `ql` CLI

官方 `@whyour/qinglong-cli` 要求 Node ≥ 22.12 且需全局安装，凭据保存在它自己的 `~/.config/qinglong/cli.json`。本插件：

- **零依赖**：Node 18+ 原生 `fetch`，`npx` 都不需要，装进 ZCode 即用；
- **同一套凭据**：复用官方 CLI 的环境变量名（`QL_URL` / `QL_ACCESS_TOKEN` / `QL_CLIENT_ID` / `QL_CLIENT_SECRET`），一处配置两边通用；
- **把坑做成行为**：整体提交校验（缺 `command`/`schedule` 直接拒绝并说明）、日志按字节偏移带 `nextOffset` 续读、410 下线接口自动改写为替代路由、403 解释到 scope、依赖类型名↔数字自动转换；
- **补上 CLI 未收录**：`/open/dashboard/successes|failures` 通过通用请求与 dashboard 工具直达。

## 安装

本插件属于 [zcode-workspace](../README.md) 市场，位于该仓库根目录的 `qinglong-admin/`。

在 ZCode 里打开 **插件市场 → 添加 → 添加插件市场**，二选一：

- **直接粘贴仓库地址**（推荐）：

```
https://github.com/Yoahoug/zcode-workspace
```

- **本地目录**：克隆本仓库后选择**仓库根目录**

然后在 **个人 → zcode-workspace → 青龙面板管理员 → 安装**。已经装过该市场里其他插件的话，刷新一下市场就能看到本插件。

## 配置连接

安装后可在插件设置里填，或用环境变量（与官方 `ql` CLI 同名，一套配置两边通用）：

| 设置 | 环境变量 | 说明 |
| --- | --- | --- |
| `panel_url` | `QL_URL` | 面板根地址，**不要**带 `/open`；从运行插件的机器必须可达 |
| `access_token` | `QL_ACCESS_TOKEN` | 应用或会话 token；有效期 30 天，此模式**不自动刷新** |
| `client_id` | `QL_CLIENT_ID` | 应用凭证；`access_token` 为空时使用，换取 token 并按需刷新（401 自动重取一次） |
| `client_secret` | `QL_CLIENT_SECRET` | 应用密钥，视同机密处理 |
| `timeout_ms` | `QL_TIMEOUT_MS` | 单请求超时，默认 30000 |

应用在面板「**系统设置 → 应用设置**」创建，勾选所需模块 scope：`crons`、`subscriptions`、`envs`、`scripts`、`configs`、`logs`、`dependencies`、`system`、`dashboard`、`apps`、`user`。**路由存在 ≠ 已授权**：缺 scope 时面板返回业务码 403，`qinglong-admin status --scope <模块>` 可逐项探测。

CLI 也可用配置文件 `~/.config/qinglong-admin/config.json`（建议 `chmod 600`）：

```json
{ "url": "http://127.0.0.1:15700", "clientId": "...", "clientSecret": "..." }
```

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `qinglong_request` | 通用请求：任意 METHOD + `/open/...` 路径，覆盖全部 143 条路由与未收录扩展；破坏性请求必须 `confirm:true` |
| `qinglong_routes` | 路由索引检索：方法、路径、scope、用途、是否破坏性 |
| `qinglong_reference` | 读取插件内置参考文档（16 个主题，含坑清单与处方集） |
| `qinglong_status` | 面板健康、版本、认证模式；可对单个 scope 做代表性读取探测 |
| `qinglong_tasks_list` | 任务列表（searchValue 过滤），原样透传面板任务对象 |
| `qinglong_task_get` | 按 ID 取任务；或按名称搜索出 ID 候选 |
| `qinglong_task_create` | 创建任务（command + schedule 必填；命令用 `task x.js` 面板执行器语法） |
| `qinglong_task_update` | 更新任务：整体提交，必须重述 command + schedule |
| `qinglong_task_action` | run / stop / enable / disable / pin / unpin（ID 数组；run 只提交，accepted≠success） |
| `qinglong_task_logs` | 任务日志**按字节**分块读取，返回 `nextOffset`/`truncated` 供续读 |
| `qinglong_task_instances` | 任务实例列表（运行中实例 `elapsed` 为秒）——判断运行成败的证据 |
| `qinglong_envs_list` | 环境变量列表（含值，注意脱敏） |
| `qinglong_env_create` | 创建环境变量（对象数组；只新建不按 id 更新） |
| `qinglong_env_update` | 更新单条：id + name + value 缺一不可 |
| `qinglong_env_delete` | 删除环境变量（需 `confirm:true`） |
| `qinglong_subscriptions_list` | 订阅列表 |
| `qinglong_subscription_create` | 创建订阅（type/url/alias/schedule_type 必填） |
| `qinglong_subscription_action` | run / stop / enable / disable 订阅 |
| `qinglong_dependencies_list` | 依赖列表：筛选用**枚举名**（nodejs/python3/linux），并翻译状态码 |
| `qinglong_dependency_install` | 排队安装依赖：请求体**数字**类型自动转换；排队≠装好 |
| `qinglong_log_read` | 日志文件按字节分块读取 |
| `qinglong_dashboard` | 仪表盘 9 个视图（含 CLI 未收录的 successes/failures；avgTime 毫秒、elapsed 秒） |

## CLI

```bash
# 面板状态与 scope 探测
node scripts/qinglong-admin.mjs status --json
node scripts/qinglong-admin.mjs status --scopes

# 任务：列表 → 建 → 回读 → 跑 → 看实例与日志
node scripts/qinglong-admin.mjs task list --search demo
node scripts/qinglong-admin.mjs task create --name demo --command 'task demo.js' --schedule '0 9 * * *'
node scripts/qinglong-admin.mjs task find demo
node scripts/qinglong-admin.mjs task run 12
node scripts/qinglong-admin.mjs task instances 12 --json
node scripts/qinglong-admin.mjs task logs 12 --tail --limit 65536

# 环境变量（整表提交）、订阅、依赖
node scripts/qinglong-admin.mjs env update 3 --name EXAMPLE_KEY --value new --json
node scripts/qinglong-admin.mjs sub create --type public-repo --url <repo> --alias demo --schedule-type crontab
node scripts/qinglong-admin.mjs dep create --name axios --type nodejs

# 通用请求（批量运行只接受数组体）
node scripts/qinglong-admin.mjs api request PUT /open/crons/run --data '[12,13]'
node scripts/qinglong-admin.mjs api request GET /open/dashboard/failures
```

命令组：`status`、`routes`、`api`、`task`、`env`、`sub`、`log`、`dep`、`script`、`configs`、`system`、`dashboard`、`app`、`user`；`qinglong-admin help <组>` 查看该组全部参数。全局开关：`--json`（原始数据）、`--dry-run`（只看请求）、`--yes`（破坏性操作确认）。

## 安全边界

- **凭据**永不打印：`config` 命令输出脱敏；MCP 服务不把 token 写进日志。
- **破坏性路由**（删除/重置/导入/清理/重载/更新，见路由表的 `[destructive]` 标记）在 CLI 里必须 `--yes`、在 MCP 里必须 `confirm:true`。
- **数据导入是两步**：`system data-import` 只解压到临时目录；`system reload --type data` 才会替换并**清空**当前数据目录——导入前先备份。
- **日志与环境变量值可能含机密**（token、cookie、私有仓库凭据），转发前先脱敏。

## 使用位置

技能记录的「本机环境」与 `references/panel-this-box.md` 指的是**面板所在主机**（这台 ubuntu：容器 `qinglong`、`http://127.0.0.1:15700`、数据目录 `/data/appdata/qinglong-ubuntu`）。在别的机器上用本插件时，把 `panel_url` 指向面板真实可达地址（或先 SSH 到面板主机再操作）；`panel-this-box.md` 里的路径与容器命令只在面板主机上成立。

## 验证

三套检查都不需要真实面板与凭据（对 mock 服务跑）：

```bash
cd qinglong-admin && npm test
# = node test/run-checks.mjs && node test/run-mcp-checks.mjs && node test/run-doc-checks.mjs
```

- `run-checks.mjs`：80 项，CLI 的请求形状与输出（信封、整表提交、单测、410、字节偏移、破坏性确认……）；
- `run-mcp-checks.mjs`：61 项，MCP 握手、工具面与行为；
- `run-doc-checks.mjs`：路由表 ↔ `references/routes.md` 逐条一致、文档中的每条 `qinglong-admin` 命令可被分发、README 工具表与服务一致、四处版本号一致。

另有 `scripts/verify.sh`（只读自检：Node、ql CLI、面板可达性、登录状态、路由数量、容器状态，不打印凭据），在面板主机上运行最佳。

## 来源与版本

- 事实来源：青龙官方文档 <https://qinglong.online/>（2026-10-01 抓取，面板 2.20.0-1），以及面板主机实测。
- 路由快照：`ql api routes --json` 实测 143 条；另有 2 条 CLI 未收录、面板直接提供（dashboard successes/failures）。
- 上游权威附录（随 npm 包分发）：`/data/npm/global/lib/node_modules/@whyour/qinglong-cli/skills/qinglong-cli/`。
- 升级 CLI 或面板后请复核本插件快照：`node scripts/qinglong-admin.mjs routes --json` 与 `ql api routes --json` 对比。
