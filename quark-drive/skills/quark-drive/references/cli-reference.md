# 命令手册（官方 CLI 透传部分）

官方 CLI（`quark-drive.cjs`）通过包装器（`scripts/quark.cjs`）调用，全部输出为 NDJSON：每行一个 JSON
`{code, msg, action, type, data}`，`type` ∈ `result|progress|list|artifact`；`code:0` 成功，负数为错误码；命令失败时进程退出码 1。登录态失效的特征：`code` 非零负数且 `msg` 含"未登录/未授权/认证/token"。

本文只收录与本插件场景（上传大文件做多端同步 + 找回）直接相关的命令与字段；分享/转存/相册整理/AI 问答等完整能力见官方文档：https://github.com/quark-clouddrive/quarkclouddrive_offical

## 公共参数（所有子命令）

| 参数 | 说明 |
| --- | --- |
| `--session-input <text>` | 用户原始提问文本，仅服务质量追踪用；拿不到可省略 |
| `--session-id <id>` | 会话唯一标识，格式 `{Unix秒}-{6位随机}`，同一对话复用；可省略 |
| `--verbose` | 详细日志输出到 stderr（login 授权链接也在这里） |

## login — 登录授权

```bash
quark login              # 阻塞式 OAuth：申请授权页 → 轮询等待用户在浏览器确认 → 自动完成
quark login --token <授权码>   # 手动兜底：用户从授权后跳转 URL 复制 code 参数
```

- `login` 阻塞等待（agent 调用请设 5–10 分钟超时）。授权链接可用 `--verbose` 从 stderr 抓取（`https://pan.quark.cn/open/v1/oauth/agent?...`）。
- `code:-118`：当前账号授权仍有效（重复登录），停止登录流程。
- `code:0`：成功。凭据写入 `~/.zcode-quark/cli/openclaw/config.json`。
- 登录失败禁止自动重试 `login`；等用户提供授权码或明确要求再试。

## unauthorize / logout — 解绑与卸载

- `quark unauthorize`：返回解绑二维码/H5 链接（`data.qrImagePath` / `data.revokeUrl`），需用户在**夸克网盘 App**（我的 → 登录授权管理）里确认；不清本地凭据。
- `quark logout`：静默撤销授权并删除配置目录。仅用于卸载，调用前必须二次确认。

## get-user-info — 账号信息（包装器别名 `whoami`）

```bash
quark whoami
```

返回昵称、会员类型、容量等。常用作登录探活。失败时 `msg` 直接转述给用户。

## upload — 上传（核心）

```bash
quark upload <本地路径...> [--parent-fid <目录FID>]
quark upload --file-path <本地路径> [--parent-fid <目录FID>]
```

- 支持多路径与文件夹递归；服务端 hash 判重秒传；Ctrl+C/进程中断自动保存断点。
- **本插件约定**：`--parent-fid` 来自 `ensure-dir`/`ensure-base`；禁止传到根目录或平台默认目录。

**进度行** `type:"progress"`：`data.current` / `data.total` / `data.percent`（汇总字节）。

**单任务完成行** `type:"list"`：成功 `code:0`，`data.recordId/fileId/fileName/fileSize/instantUpload`；失败 `code:SDK错误码`，仅 `data.recordId`。

**汇总行** `type:"result"`：全部成功 `code:0`，`data.fileNames[]/fileCount/totalSize/fids[]/successCount/instantUpload/instantUploadCount/fullPath`；有失败 `code:-204`，`msg` 附失败数量。

**主要错误码**：`-201` 缺路径、`-202` 本地文件不存在、`-203` 上传管理器初始化失败、`-204` 存在失败任务。

### 上传任务管理（断点续传）

```bash
quark upload list [--state pending|hashing|uploading|paused|success|failed|cancelled|post_hashing]
quark upload resume --record-id <ID>
quark upload delete --record-id <ID>   # 只删任务记录，不删网盘文件
```

- `resume` 错误码：`-205` 任务不存在、`-208` 恢复失败、`-210` 缺 `--record-id`。
- `list` 行字段：`recordId/fileName/fileSize/state/createdAt`（毫秒时间戳）。

## download — 下载（同步回本端）

```bash
quark download --fid <FID> [--output-dir <目录>] [--overwrite]
```

- 默认输出 `./downloads`；同名默认自动重命名，`--overwrite` 才覆盖。
- 任务管理与上传对称：`download list [--state pending|paused|failed|completed]` / `download resume --record-id <ID>` / `download delete --record-id <ID>`。

## search — 搜索（找回的主途径）

```bash
quark search --keyword "<关键词≤50字>" [--parent-fid <FID>] [--size 1-100] \
  [--search-type mix|video|album|doc|audio|dir|package|other|app] [--stdout-only]
```

- 自动分页；`--size` 是单页大小不是总量上限。
- 结果以 artifact 落盘：`type:"artifact"` 行 `data.file_path` 指向 JSONL，每行一个 BrowseFileItem。**后续操作必须读该文件拿全量 FID**，stdout 预览（≤5 条）不作数。
- 找文件夹用 `--search-type dir`；限定规范树传 `--parent-fid <来自ZCode 的 FID>`。
- 搜索无结果不是失败；不要自行换词重搜。

## browse — 浏览目录直接子项

```bash
quark browse [--parent-fid <FID>] [--page-size 1-100] [--all] [--task-dir <目录>]
```

- 不递归。`--all` 取全部直接子项；单页时 `result.data.hasMore` 表示还有下一页。
- 结果同样落 artifact JSONL（`data.file_path`）。

### BrowseFileItem 常用字段

| 字段 | 说明 |
| --- | --- |
| `fid` / `parent_fid` | 文件 ID / 父目录 ID（操作一律用完整 fid） |
| `filename` / `size` | 名称 / 字节数 |
| `file_type` | `"0"` 目录，`"1"` 文件 |
| `category` | 0 文件夹、1 视频、2 音频、3 图片、4 文档、5 种子、6 其他、7 压缩包、8 应用 |
| `created_at` / `updated_at` | 上传/修改时间，毫秒 |
| `content_hash` | 云端哈希（勿用于身份判断；FID 才是身份） |

## create-folder — 创建目录（ensure-dir 的底层）

```bash
quark create-folder --dir-path <名称> [--parent-fid <FID>]
```

- 同名幂等（返回已有 FID）。**不传 `--parent-fid` 会建到平台默认目录而非根目录**——本插件始终显式传 FID。
- 成功 `data.fid` + `data.full_path`（如 `夸克网盘/来自ZCode/文件`）。

## move — 移动文件

```bash
quark move <FID...> --target-fid <目录FID>   # 最多 100 个/批
```

用于把用户散落在网盘别处的文件归整进 `来自ZCode/` 树。成功 `data.move_path` 是目标目录回显。

## 目录 FID 约定

- `"0"` = 根目录。一切入参只认 FID；路径名只是回显。
- 规范树的 FID 通过 `ensure-base` / `ensure-dir` 现取（幂等、无缓存失效问题）：

```bash
quark ensure-base
# → {"code":0,"action":"ensure-base","type":"result","data":{"baseFid":"...","path":"来自ZCode","文件Fid":"...","共享Fid":"..."}}
quark ensure-dir --path "项目/demo"
# → {"code":0,"action":"ensure-dir","type":"result","data":{"baseFid":"...","fid":"...","path":"来自ZCode/项目/demo"}}
```

## restore — 资源补齐（包装器附加命令，非官方 CLI）

新设备/新克隆把云端规范目录与本机对齐。判定"本机已有"：台账里有同名且同字节数的记录；没有台账的新机器自然全部判缺。

```bash
quark restore [--path <相对路径>] [--manifest <清单文件>] [--download] [--output-dir <目录>]
```

| 参数 | 说明 |
| --- | --- |
| `--path <rel>` | 只核对 `来自ZCode/<rel>` 子树（如 `项目/demo`）；缺省核对整棵规范树 |
| `--manifest <file>` | 声明式清单（每行一个文件名，支持 `#` 注释）；只核对清单内文件 |
| `--download` | 把缺失文件直接下载到 `--output-dir`（默认 `./quark-restored`） |
| `--output-dir <dir>` | 下载目标目录 |

输出 `type:"result"`：`data.root`（核对范围）、`data.cloudFiles`（云端文件数）、`data.checked`、`data.missing`、`data.files[]`（缺失清单 name/fid/size）、`data.downloadFailures`（仅 --download 时可能出现）。

典型用法（配合仓库 `.quark-manifest`）：

```bash
quark restore --manifest .quark-manifest --path "项目/<项目名>" --download --output-dir ./bigfiles
```

## 未授权错误处理

任何命令返回未授权（如 `{"code":-1408,"msg":"未完成授权认证","action":"not_authenticated"}` 或 `code:-103` 未登录）：

1. 先把 `msg` 展示给用户；
2. 走 SKILL.md 第四节登录流程；
3. 登录成功后重试原命令**一次**。禁止不打招呼反复重试。
