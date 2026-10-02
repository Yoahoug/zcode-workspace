---
name: qinglong-admin
description: 管理青龙（Qinglong 2.x）定时任务面板：定时任务、订阅、环境变量、脚本与配置文件、依赖、日志、系统设置、仪表盘、应用与用户。用远程 ql CLI（OpenAPI）操作，含本机面板的部署事实与本机运维处方。当用户要查/建/跑/停定时任务、看任务日志、改环境变量、装依赖、加订阅、做面板备份恢复、或排查面板与任务问题时使用。
---

# 青龙面板管理技能（qinglong-admin）

## 适用与边界

- **适用**：青龙 2.x 面板的一切远程管理（任务/订阅/环境变量/脚本/配置/依赖/日志/系统/仪表盘/应用/用户），以及本机面板的部署侧运维（备份、升级、恢复、排障）。
- **不适用**：写脚本内容本身（那是业务脚本的事）；面板开发与发版。
- **这是「青龙面板管理助手」agent 的主技能**。owner 的通用规矩同样适用：**回复一律中文**；破坏性操作先说明影响、等他确认；**凭据永不打进聊天**。

## 本机环境（这台 ubuntu，2026-10-01 实测）

| 项 | 值 |
|---|---|
| 容器 | `qinglong`（镜像 `whyour/qinglong:debian`，版本 **2.20.0-1**） |
| 面板地址 | `http://127.0.0.1:15700`（容器内 5700，host 映射 15700） |
| 数据目录 | `/data/appdata/qinglong-ubuntu/data` → 容器 `/ql/data`（约 679 MB） |
| Compose 工程 | `qinglong-ubuntu`，配置文件 `/data/appdata/qinglong-ubuntu/docker-compose.yaml` |
| 面板时区 | Asia/Shanghai（CST） |
| 运行用户 | `ql` 的 `QL_USER=qinglong`，`QL_DIR=/ql` |
| 远程 CLI | `ql` → `/data/npm/global/bin/ql`（`@whyour/qinglong-cli` **0.1.1**，需 Node ≥ 22.12；本机 Node **24.21.0**） |
| 未认证访问 | 返回 HTTP 401 + `{"code":401,"message":"No authorization token was found"}` |

更细的部署事实、备份/升级/恢复、内部命令与故障矩阵见 [panel-this-box.md](references/panel-this-box.md)。

## 工具选择顺序（先合适，再强大）

1. **远程 CLI `ql`（首选）** —— 覆盖 143 条路由，`--json` 输出，凭据与 token 自动管理。用法见 [cli.md](references/cli.md)。
2. **直接打 HTTP OpenAPI（`curl`）** —— 只在 CLI 没收录时用，例如 `GET /open/dashboard/successes|failures`；或需要手工控制头部/流式下载时。见 [openapi-*.md](references/routes.md)。
3. **面板内部命令（`docker exec qinglong …`）** —— `task`、`ql repo/raw/update/check/rmlog/resetpwd` 这类**本机**能力，远程 API 不提供。仅在本机维护、仓库拉取、脚本本机执行时使用，见 [panel-this-box.md](references/panel-this-box.md)。

**不要**因为 API 失败就退化成"直接在容器里改文件"：先判断是权限（应用 scope 不够）、凭据（401）、还是路径/版本问题，再决定。

## 连接与凭据（硬规矩）

- **凭据来源**：面板「**系统设置 → 应用设置**」新建应用，勾选模块权限，得到 `client_id` / `client_secret`。`client_secret` 不支持命令行参数。
- **三种接法**：
  1. 交互登录：`ql login --url http://127.0.0.1:15700`（提示输入 Client ID / Secret）；
  2. CI/非交互：环境注入 `QL_CLIENT_ID`、`QL_CLIENT_SECRET` 后再跑同样的 `ql login --url …`；
  3. 直连令牌：同时注入 `QL_URL` + `QL_ACCESS_TOKEN`（**必须成对**；此模式优先于已保存配置、**不落盘、不自动刷新**、失效即需替换）。
- **落盘位置**：`~/.config/qinglong/cli.json`（权限 0600，**含明文凭据**）。可用 `QL_CLI_CONFIG` 改路径。**不要 `cat`、不要打印、不要贴进聊天。**
- **网络要求**：远程必须 HTTPS；**回环地址允许 HTTP**（本机 127.0.0.1 可用 http）。CLI **不跟随重定向**。
- **令牌寿命**：应用 token 有效期 **30 天**；每个应用最多保留 **5 个**有效 token（到上限后复用并延长第 5 个）。**重置应用密钥会清空已有 token，且不可逆。**
- 日志分享前先脱敏：`token`、环境变量值、私有仓库凭据都可能出现在日志里。

## 安全规则（owner 的要求，必须遵守）

**先问 owner 再做的事**（说清对象、影响、可否回滚）：
- 删除类：删定时任务 / 订阅 / 脚本 / 环境变量 / 日志；`ql dependency force-delete`。
- 面板级：`ql system update`、`ql system reload`、`ql system auth-reset`、`ql system data-import`（**导入会清空数据目录**）、`ql system retention-cleanup`、`ql system config-*` 全局设置。
- 凭据类：创建/更新/删除应用、重置应用密钥、改用户名/密码、两步验证、IP 黑名单。
- 批量启停（`task enable/disable`、`env disable/enable` 一次多个 ID）先报数量与对象。

**不用问的**：只读查询（`list`/`get`/`detail`/`logs`/`dashboard`/`auth status`）、以及他明确要求的单次运行。

**执行纪律**：
1. 先确认真实 ID —— 用 `list`/`--search` 找到目标，不凭猜测的 ID 操作。
2. **变更后回读验证**（`get`/`list`），不要只信接口返回的 `accepted`。
3. 拿不准就先 dry-run（`subscription create --dry-run` 等）或先在低风险对象上验证。

## 最容易踩的判据

- **`accepted: true` ≠ 跑成功**：`task run` 只是"已提交"。要结合**任务状态 / 实例 / 日志**判断结果；脚本失败不会让 run 失败。
- **最新日志可能是上一次运行的**；`logStatus: completed` 也不代表成功。看 `task logs`/`log-files` 的实际内容与退出码。
- **更新是整体提交，不是补丁**：`task update` 必须带 `command` + `schedule`；`subscription update` 必须带 `type` + `url` + `alias`；`env update` 必须带 `id`+`name`+`value`。**先 `get` 再改，改完回读。**
- **成功信封**：`{code: 200, data: …}`。**HTTP 200 也可能是业务错误** —— 两个都要看。
- **已下线接口返回业务码 410**：`GET /open/configs/:file`、`GET /open/scripts/:file`、`GET /open/logs/:file` ⇒ 改用对应的 `/detail`（`ql config get` / `ql script get` / `ql log get`）。
- 更多单位、枚举、权限与速率限制坑见 [pitfalls.md](references/pitfalls.md)。

## 参考文件索引

| 文件 | 内容 |
|---|---|
| [cli.md](references/cli.md) | 远程 CLI 全量用法：安装/入口识别、登录与三种凭据模式、auth 检查、各资源命令、输入约定（`--data/--query/--file/--output`）、输出与错误 |
| [routes.md](references/routes.md) | **143 条 CLI 命令 ↔ HTTP 路由全表**（按模块分组） |
| [openapi-auth.md](references/openapi-auth.md) | 创建应用、获取 token、请求示例 |
| [openapi-crons.md](references/openapi-crons.md) | 定时任务 + 视图 + 标签 + 运行/停止 + 状态 |
| [openapi-subscriptions.md](references/openapi-subscriptions.md) | 订阅（仓库）管理字段与必填项 |
| [openapi-envs.md](references/openapi-envs.md) | 环境变量（含上传文件格式、权限与置顶） |
| [openapi-scripts.md](references/openapi-scripts.md) | 脚本管理（含 `run` 只跑临时文件的陷阱） |
| [openapi-configs.md](references/openapi-configs.md) | 配置文件（`config.sh`、示例文件、保存） |
| [openapi-logs.md](references/openapi-logs.md) | 日志读取（按字节偏移、`nextOffset`）、删除与下载 |
| [openapi-dependencies.md](references/openapi-dependencies.md) | 依赖（type 数字 vs 查询枚举、8 种状态） |
| [openapi-system.md](references/openapi-system.md) | 系统信息/配置/更新/重载/通知（22 种推送枚举）/命令执行/数据导入导出/保留策略 |
| [openapi-dashboard.md](references/openapi-dashboard.md) | 仪表盘统计（含 CLI 未收录的 successes/failures） |
| [openapi-apps-users.md](references/openapi-apps-users.md) | 应用管理与用户/两步验证/登录日志/IP 黑名单 |
| [workflows.md](references/workflows.md) | **处方集**：建任务并验证、批量运行、看日志、环境变量导入导出、订阅新增、依赖安装、发通知、备份/恢复、排障 |
| [panel-this-box.md](references/panel-this-box.md) | 本机部署事实、面板内部命令（`task`/`ql`）、备份/升级/恢复流程、常见问题矩阵 |

**上游权威附录**（CLI 自带，可与本技能相互印证）：`/data/npm/global/lib/node_modules/@whyour/qinglong-cli/skills/qinglong-cli/`（`SKILL.md` + `references/panel.md` + `references/openapi.md`）。CLI 版本升级后以 `ql api routes --json` 与各命令 `--help` 为准。
