# quark-drive（夸克网盘大文件同步）

把 GitHub 放不下的大文件（模型、数据集、视频、安装包、归档等）上传到夸克网盘做多端同步。核心体验是**无感**：AI 按策略自行判断何时上传（≥50MB 的产出、用户提到同步/备份/git 放不下），不需要用户催。

- **后端**：夸克官方 Agent CLI（`quark-drive.cjs`，来自官方 skill 发布通道，走官方 Open API + OAuth 授权）。首次调用自动安装到 `~/.zcode-quark/cli/`，**凭据也在那里**，更新/重装插件不影响登录态。
- **规范放置**：所有文件统一放在网盘 `来自ZCode/` 目录树下（`文件/<年月>`、`项目/<名>`、`共享`），不污染用户网盘。
- **可找回**：本机台账（`~/.zcode-quark/ledger.jsonl`）+ 云端 search/browse 双途径，配合统一目录树，任何一端都能找回，无需记住具体文件。
- **仓库留痕与资源补齐**：真实仓库里用 `AGENTS-quark.md`（安装/登录/补齐提示）+ `.quark-manifest`（声明式资源清单）留痕；新机器一条 `restore` 命令把缺失文件下载补齐。

## 组件

- `skills/quark-drive/SKILL.md` — 使用规范：无感上传判断策略、目录约定、仓库留痕（`.quark-manifest` + `restore`）、找回三层机制、登录流程、常用任务。
- `skills/quark-drive/references/cli-reference.md` — 命令手册（upload/download/search/browse/login/restore 及错误码）。
- `skills/quark-drive/references/find-back.md` — 找回机制详解。
- `scripts/quark.cjs` — 包装器：自动安装官方 CLI（Node ≥16，零 npm 依赖；Windows 用 PowerShell 解压）、注入 `OPENCLAW_CLI=1` 渠道标识、透传命令；附加 `ensure-base` / `ensure-dir` / `whoami` / `restore` 便捷命令。
- `scripts/quark-ledger.cjs` — 上传台账查询工具。

## 登录

每台设备首次使用需授权一次：`node scripts/quark.cjs login`，用夸克网盘 App 扫码/确认（详见 SKILL.md 第六节）。凭据存于 `~/.zcode-quark/cli/openclaw/config.json`。

## 卸载

1. 撤销授权：`node scripts/quark.cjs logout`（或 `unauthorize` 走 App 内解绑）。
2. 删除本插件目录与 `~/.zcode-quark/`。

## 来源与许可

官方 skill 仓库：https://github.com/quark-clouddrive/quarkclouddrive_offical （Apache-2.0）。本插件不包含、不分发官方 CLI 二进制，仅在使用时从夸克官方服务端拉取安装。
