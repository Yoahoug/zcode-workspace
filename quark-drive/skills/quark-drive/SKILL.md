---
name: quark-drive
description: Use when the user wants to upload large files (too big for GitHub, e.g. models, datasets, videos, installers, archives) to Quark Drive (夸克网盘) for multi-device sync, download/sync them back on another machine, search or browse the cloud drive, or re-login when authorization has expired. Uploads always land in the standardized cloud folder 来自ZCode/ so files stay findable and organized; nothing is ever uploaded to a random location. Also use when the user mentions 夸克网盘, 夸克, 大文件同步, 网盘上传/下载.
---

# Quark Drive（夸克网盘）大文件同步

通过夸克官方 CLI（官方 Open API + OAuth 授权）上传/下载文件，用于 GitHub 放不下的大文件多端同步。

## 一、先记住三条铁律

1. **统一入口**：所有命令都通过本插件的包装器执行。SKILL.md 位于 `<插件根>/skills/quark-drive/SKILL.md`，包装器在其上两层的 `scripts/quark.cjs`：
   ```bash
   node "<插件根>/scripts/quark.cjs" <command> [options]
   ```
   首次调用会自动把官方 CLI 安装到 `~/.zcode-quark/cli/` 并注入渠道标识，之后直接复用。不要绕过包装器直接调用 `quark-drive.cjs`（会因 agent 渠道识别失败被拒绝）。
2. **规范放置**：用户文件只允许放在网盘的 **`来自ZCode/`** 目录树下（见第三节）。除非用户明确指定其它 FID/目录，`--parent-fid` 一律使用 `ensure-dir` / `ensure-base` 返回的 FID（幂等，已存在直接返回旧 FID）。
3. **一切以 FID 为准**：网盘操作只认 FID 字符串（`"0"` = 根目录）。路径名只是回显。禁止臆造 FID——先 search/browse 拿到真实 FID 再操作。

## 二、无感上传（AI 自行判断，不用用户催）

用户的目标是"无感"：该传的时候 AI 自己传，不该传的时候不打扰。**每次任务收尾时（或产出大文件的步骤后）按下面清单自查一遍**，命中任何一条就默认上传，无需请示；一条都不中就不传。

**触发上传（默认执行，事后告知即可）：**
- 产出了 ≥50MB 的单文件（模型、数据集、录屏、安装包、导出产物、压缩包），且不是明确的临时产物。
- 用户说了"存网盘 / 备份 / 同步 / 换设备要用 / 发给别人 / 跑不进 git"等意思。
- 大文件因为体积被 git 拒收、被 .gitignore 排除，或用户提到"github 放不下"。
- 真实仓库根目录存在 `.quark-manifest` 清单且本次产出/更新的文件出现在清单里（见第四节）。

**不传（保持安静）：**
- 明确的临时产物：会话中间态、可一键重生的小文件、缓存、日志、测试残留。
- 小于 50MB 且能正常进 git 的文件（git 能管的不劳烦网盘）。
- 涉及隐私/密钥/凭据的文件（`~/.zcode-quark/`、`.env`、token、证书私钥）——**永远禁止**，除非用户当次明确点名。

**执行方式（一次任务只打扰一次）：**
1. 首次命中触发条件时直接开始上传（后台跑，不阻塞当前任务收尾）。
2. 结束后一句话汇报：传了什么、多大、放到 `来自ZCode/...` 哪个目录、是否秒传。
3. 同一任务里后续同类文件继续静默追加上传，最后合并汇报。
4. **登录态检查前置**：上传前先跑 `quark whoami`；未登录则走第六节登录流程（这时才需要用户参与一次）。用户明确拒绝上传某文件时，直接不传不记，用户改主意会再说。

## 三、网盘目录规范（多端同步的约定）

所有 ZCode 上传的文件都规范地放在统一目录树下，任何一端都能按同样规则找回，**不需要用户记住具体文件名或路径**：

```
来自ZCode/                    ← 插件专用根目录（唯一入口）
├── 文件/                     ← 默认上传落点（单文件/零散文件）
│   └── 2026-01/              ← 按年月自动归类（上传时自动建）
├── 项目/<项目名>/            ← 在某仓库/项目里工作时用（项目名取仓库目录名）
└── 共享/                     ← 专门用于创建分享链接的文件
```

- **默认落点**：用户没说放哪 → `来自ZCode/文件/<当前年月>/`。
- **归类上传**：用户说了类别/项目名，或当前在某个真实仓库里工作 → `来自ZCode/项目/<项目名>/` 或 `来自ZCode/文件/<类别>/`。用 `ensure-dir --path "项目/xxx"` 拿 FID。
- **禁止**：把文件传到根目录、平台默认目录，或自造"来自ZCode"之外的顶层目录。
- **文件名冲突**：网盘同名不覆盖（自动加后缀）。重传前先 `search` 确认是否已存在同名同大小文件（秒传会命中）。

## 四、仓库留痕与资源补齐（.quark-manifest + restore）

多端同步的关键是**真实仓库里留提示，让任何一端的 AI 都知道该干什么**：

### 4.1 真实仓库的留痕文件（AI 首次在某仓库上传后自动创建/维护）

在仓库根创建/维护 `AGENTS-quark.md`（无感留痕：首次上传时顺手写入，之后不再重复解释）：

```markdown
# Quark 大文件同步（本仓库约定）

本仓库用 ZCode quark-drive 插件管理 GitHub 放不下的大文件（模型/数据集/录屏等）。

- 新设备或未安装插件时：先在 ZCode 插件市场安装 quark-drive（本地开发市场路径见插件 README），
  然后 `node <插件根>/scripts/quark.cjs whoami` 检查登录；未登录就跑 `quark login`，
  用夸克网盘 App 扫码授权（每台设备一次）。
- 声明式资源清单：`.quark-manifest` 列出"本仓库依赖的、存放在夸克网盘的文件名"，
  每行一个文件名（支持 # 注释）。云端统一放在 来自ZCode/项目/<本仓库目录名>/ 下。
- 资源补齐（缺文件/跑不通时执行）：
  node <插件根>/scripts/quark.cjs restore --manifest .quark-manifest \
    --path "项目/<本仓库目录名>" --download --output-dir ./bigfiles
- 上传约定：≥50MB 的产出文件自动上传到上述项目目录，并把文件名追加进 .quark-manifest
  提交到 git；小文件照常走 git；bigfiles/ 加入 .gitignore。
```

同时维护 `.quark-manifest`（纯文本清单，进 git）并把大文件本体目录（如 `bigfiles/`）加入 `.gitignore`。

### 4.2 restore —— 资源补齐（新机器/新克隆一键对齐）

```bash
# 清点：云端项目目录 vs 本机台账，报告缺失文件（不下载）
quark restore --path "项目/<项目名>"
# 声明式：只核对 .quark-manifest 里列出的文件
quark restore --manifest .quark-manifest --path "项目/<项目名>"
# 补齐：缺失的直接下载到 ./bigfiles
quark restore --manifest .quark-manifest --path "项目/<项目名>" --download --output-dir ./bigfiles
```

- 判定"本机已有"的依据：台账里有同名且同字节数的记录（离线、快）；没有台账的新机器自然全部判缺。
- 输出 `data.files[]` 是缺失清单（name/fid/size），`--download` 后逐个下载，最后输出总结行（`data.missing/checked/downloadFailures`）。
- AI 在新仓库遇到"缺文件/跑不通"时，先看有没有 `.quark-manifest`，有就跑 restore。

## 五、找回机制（本插件不存在"指定死一个文件"的问题）

分三层，按序使用，全部不需要用户报出具体路径：

1. **网盘侧检索（主途径）**：
   ```bash
   # 在规范树内搜索（推荐：限定 parent_fid 避免搜到用户自己的网盘文件）
   quark search --keyword "<关键词>" --parent-fid "<来自ZCode的FID>" [--search-type dir]
   # 浏览某目录全部直接子项
   quark browse --parent-fid "<FID>" --all
   ```
   - Search/browse 成功会输出 `type:"artifact"` 行，`data.file_path` 指向完整结果 JSONL——**后续操作必须读该文件拿全量 FID**，stdout 预览最多 5 条不作数。
   - BrowseFileItem 关键字段：`fid`、`parent_fid`、`filename`、`size`、`file_type`（"0"目录/"1"文件）、`updated_at`（毫秒）。
   - 搜索无结果就如实告知，不要自行换词重搜。
2. **本插件内的记录**：每次上传成功后，插件会自动把"文件名 ↔ FID ↔ 大小 ↔ 网盘路径"追加到 `~/.zcode-quark/ledger.jsonl`。要找以前传过的文件，先 `quark-ledger --keyword <关键词>` 查本地台账（毫秒级、离线），命中后再决定是否需要重新核对云端。
3. **兜底**：台账与网盘都找不到时，向用户说明并建议：换关键词、到夸克网盘 App 里人工查找，或重新上传。

**台账是缓存不是权威**：云端为准。台账可随时删除重建（`rm ~/.zcode-quark/ledger.jsonl` 后重传/重扫即可恢复），不承担"唯一凭证"角色。

## 六、登录与授权（用户配合一次即可）

- **检查登录态**：`quark whoami`（内部调 `get-user-info`）。返回 `code:-103`（未登录）或 `code:-1408`（未完成授权认证）时走下述登录流程。
- **任何命令返回未授权**（`code` 非零负数且 msg 含"未登录/未授权/认证/token"）：先向用户展示 CLI 返回的 `msg`，然后调 `quark login`，成功后重试原命令一次。**禁止**不打招呼就反复重试。
- **登录流程**（`quark login` 会阻塞等待，超时设 5–10 分钟）：
  1. 直接运行 `quark login`。它会向夸克服务端申请授权页并轮询等待；用 `--verbose` 可在 stderr 看到形如 `https://pan.quark.cn/open/v1/oauth/agent?...` 的授权链接。
  2. 把授权链接发给用户，让其在浏览器打开并用**夸克网盘 App 扫码/确认**授权。
  3. 用户确认后 `login` 自动返回 `code:0`。若超时/失败：把链接发给用户 → 用户授权完成后从跳转 URL 复制 `code` 参数 → `quark login --token <授权码>`。
- **重复登录**：返回 `code:-118` 表示当前账号授权仍有效——把 msg 原样转告用户并停止，不要反复 login。
- **登录成功后**：跑一次 `quark whoami` 确认昵称/容量，并跑 `quark ensure-base` 把规范目录骨架（`来自ZCode/{文件,共享}`）建好。
- **凭据存放**：`~/.zcode-quark/cli/openclaw/config.json`（含 access_token）。它由官方 CLI 管理，插件不读取不转储。多端同步意味着**每台设备各自登录一次**（授权绑定设备）。
- **取消授权**：用户要解绑时运行 `quark unauthorize`，把返回的二维码/H5 链接展示给用户，需在夸克网盘 App 内确认（我的 → 登录授权管理）。`logout` 是卸载专用（撤销授权+删配置），仅在用户明确要卸载时用，且先二次确认。

## 七、常用任务手册

调用约定：下文 `quark` 均指 `node "<插件根>/scripts/quark.cjs"`；输出为 NDJSON（每行一个 JSON：`code/msg/action/type/data`），`type` ∈ `result|progress|list|artifact`，`code:0` 成功；失败时进程退出码 1。公共参数 `--session-input`（用户原话，拿不到就省略）与 `--session-id`（`{Unix秒}-{6位随机}`，同一对话复用）可选传入。

### 上传大文件（核心场景）
```bash
# 默认：传到 来自ZCode/文件/<年月>/
quark ensure-dir --path "文件/<年月>"    # 输出 data.fid（首次先跑 quark ensure-base 建好骨架）
quark upload <本地路径...> --parent-fid <data.fid>   # 支持多路径、文件夹递归、秒传、断点续传
# 归类：项目目录同理
quark ensure-dir --path "项目/<项目名>"   # 输出 data.fid
quark upload <本地路径> --parent-fid <FID>
```
- 上传中输出 `type:"progress"`（`data.current/total/percent`）；结束时 `type:"result"`，`data.fids[]` 是文件 FID，`data.fullPath` 是网盘目录回显，`data.instantUploadCount>0` 表示秒传。
- **Ctrl+C 中断自动存断点**；恢复：`quark upload list` → `quark upload resume --record-id <ID>`；清记录：`quark upload delete --record-id <ID>`。
- 大文件耗时较长：用 run_in_background 跑，定期看进度行；失败任务会逐行输出 `type:"list"`（code≠0）。
- 成功后：把台账行写入 `~/.zcode-quark/ledger.jsonl`（字段见下），并向用户报告"已传到 来自ZCode/...、FID、大小、是否秒传"。

### 下载/同步到本端
```bash
quark search --keyword "<名字>" --parent-fid "<来自ZCode FID>"   # 或查台账拿 fid
quark download --fid <FID> --output-dir <本地目录> [--overwrite]
```
- 下载也有任务管理：`download list` / `download resume --record-id <ID>` / `download delete --record-id <ID>`。
- 多端同步 = 一端 upload、另一端 download，目录结构由用户在两端约定（本插件只管文件本身）。

### 其它
- `quark whoami`：账号/会员/容量。
- `quark browse --parent-fid "<FID>" --all`：列目录（在 来自ZCode 里翻找）。
- `quark move <FID...> --target-fid <FID>`：把用户网盘里的散文件移进规范树（最多 100/批）。
- `quark create-folder --dir-path <名称> --parent-fid <FID>`：手工建目录（同名幂等）。日常请用 `ensure-dir`。
- 分享/转存/AI 整理等能力 CLI 同样支持（`share`、`saveas`、`search` 全局搜索等），按需使用，注意用户文件的管理边界仍是 来自ZCode/。

## 八、台账格式（ledger.jsonl）

每行一个 JSON，由插件在上传成功后追加、由 `quark-ledger` 查询：

```json
{"name":"big-model.bin","fid":"...","size":123456789,"path":"来自ZCode/文件/2026-10","uploadedAt":1760000000000,"host":"这台机器的主机名"}
```

- 查询：`quark-ledger --keyword <关键词>`（大小写不敏感的子串匹配 name/path 字段，输出 JSON 行）。
- 台账只追加不修改；同文件重复上传会留多条记录，检索时取 `uploadedAt` 最新一条。

## 九、边界与注意

- CLI 官方设计**没有删除网盘文件的命令**——这符合"同步不误删"的定位。用户真要删：引导其到夸克网盘 App 操作。
- 不要把 `~/.zcode-quark/`（凭据+台账）提交进 git；也不要把台账里的大文件列表当作敏感信息外发。
- 单文件大小、总容量以账号配额为准（`whoami` 可查）；上传失败先看 NDJSON 的 `msg` 与错误码，再决定续传还是重传。
- CLI 版本升级：`node "<插件根>/scripts/quark.cjs" update` 只更新 CLI 本体；重装插件即整体更新（凭据不受影响，因为配置在 `~/.zcode-quark/` 而不是插件目录）。
- **落盘产物别弄脏仓库**：`browse`/`search` 会把完整结果 JSONL 写到当前工作目录的 `browse/` 子目录（或 artifact 行给出的路径）。在真实仓库里执行时优先 `cd` 到临时目录再跑，或用完即删，并提醒用户把 `browse/` 加入 `.gitignore`。
