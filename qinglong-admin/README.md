# Qinglong Admin — ZCode 插件

青龙（Qinglong 2.x）定时任务面板的管理插件：把面板的**远程 OpenAPI 全量面**（143 条 CLI 路由）、**逐资源字段参考**、**处方集**、**交叉坑清单**和**本机部署事实**整理成一份可被 ZCode agent 直接使用的技能。

## 内容

| 路径 | 说明 |
|---|---|
| `skills/qinglong-admin/SKILL.md` | 主技能：适用范围、本机环境、工具选择顺序、凭据与安全规则、判据、参考索引 |
| `skills/qinglong-admin/references/cli.md` | 远程 CLI（`@whyour/qinglong-cli`）全量用法：入口识别、三种凭据模式、各资源命令、输入约定、输出与错误 |
| `skills/qinglong-admin/references/routes.md` | 143 条 CLI 命令 ↔ HTTP 路由全表（按模块分组） |
| `skills/qinglong-admin/references/openapi-*.md` | 逐资源 OpenAPI 参考：认证、定时任务（含视图/标签/实例）、订阅、环境变量、脚本、配置文件、日志、依赖、系统（含 22 种推送枚举、数据导入导出）、仪表盘、应用与用户 |
| `skills/qinglong-admin/references/workflows.md` | 处方集：建任务并验证、批量运行、看日志、环境变量导入导出、订阅拉取、依赖安装、发通知、备份/升级/恢复、巡检、排障 |
| `skills/qinglong-admin/references/pitfalls.md` | 交叉坑：成功判据、请求形状、日志偏移、410 下线接口、单位与枚举、权限 scope 速查 |
| `skills/qinglong-admin/references/panel-this-box.md` | 本机部署事实、面板内置命令（`task`/`ql`）、内部 TS 工具、备份/升级/恢复、常见问题矩阵 |
| `scripts/verify.sh` | 只读自检：Node、CLI、面板可达性、登录状态、路由数量、容器状态（不打印凭据） |

## 依赖

- **Node ≥ 22.12**（本机 24.21.0）
- **`@whyour/qinglong-cli`**：`npm install -g @whyour/qinglong-cli`（本机已装，`ql` → `/data/npm/global/bin/ql`）
- 面板凭据：面板「系统设置 → 应用设置」新建应用；`ql login --url <面板地址>`，或环境变量 `QL_URL` + `QL_ACCESS_TOKEN`

## 安装（在 ZCode 里）

本插件属于 [zcode-workspace](../README.md) 市场，位于该仓库根目录的 `qinglong-admin/`。

在 ZCode 里打开 **插件市场 → 添加 → 添加插件市场**，二选一：

- **直接粘贴仓库地址**（推荐）：

```
https://github.com/Yoahoug/zcode-workspace
```

- **本地目录**：克隆本仓库后选择**仓库根目录**

然后在 **个人 → zcode-workspace → 青龙面板管理员 → 安装**。已经装过该市场里其他插件的话，刷新一下市场就能看到本插件。

不想通过市场安装的话，也可以**只当技能用**：把 `skills/qinglong-admin/` 整个目录拷进技能根目录（本机是 `~/.agents/skills/`），或把 `SKILL.md` 与 `references/*.md` 当普通文档喂给其他 agent 读。

## 使用位置

技能记录的「本机环境」与 `references/panel-this-box.md` 指的是**面板所在主机**（这台 ubuntu：容器 `qinglong`、`http://127.0.0.1:15700`、数据目录 `/data/appdata/qinglong-ubuntu`）。请在面板主机上使用本技能，或先 SSH 到该主机再操作；换机器前先核对该文件。

## 自检

```bash
bash scripts/verify.sh
```

只读检查 Node、`ql` CLI、面板可达性（未认证应为 401）、登录状态、路由数量和容器状态，不打印任何凭据。可用 `QL_PANEL_URL` 覆盖面板地址。

## 来源与版本

- 事实来源：青龙官方文档 <https://qinglong.online/>（2026-10-01 抓取，面板 2.20.0-1），以及面板主机实测。
- 上游权威附录（随 npm 包分发）：`/data/npm/global/lib/node_modules/@whyour/qinglong-cli/skills/qinglong-cli/`。
- 路由表与命令以 `ql api routes --json`、各命令 `--help` 为准；升级 CLI 或面板后请复核本插件快照。
