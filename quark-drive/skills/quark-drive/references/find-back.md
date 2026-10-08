# 找回机制详解：任何一端都能找回文件

设计目标：**使用时永远不需要在插件里指定某个"记死的文件"**。文件放得规范、找得回来，靠的是三层机制 + 网盘侧统一目录约定。

## 1. 网盘侧：统一目录树（找回的根基）

```
来自ZCode/                    ← 插件专用根目录，云端唯一入口
├── 文件/                     ← 默认落点
│   └── 2026-01/              ← 按年月自动归类
├── 项目/<项目名>/            ← 有明确归属的文件
└── 共享/                     ← 需要创建分享链接的文件
```

- 该树由 `ensure-base` / `ensure-dir` 幂等创建，**FID 现取现用**，不依赖任何本地缓存——换设备、重装插件、云端目录被手动挪动都不会失效。
- 在任何一端找文件，先 `ensure-base` 拿 baseFid，再 search/browse。

## 2. 三层找回流程（按序使用）

### 第 1 层：本机台账（离线、毫秒级）

```bash
node "<插件根>/scripts/quark-ledger.cjs" --keyword <关键词>
```

- 位置：`~/.zcode-quark/ledger.jsonl`（可用 `QUARK_DRIVE_HOME` 重定向）。
- 每次上传成功后由 agent 追加一行（见 SKILL.md 第八节格式），含 `name/fid/size/path/uploadedAt/host`。
- 匹配逻辑：keyword 与 `name`、`path` 做大小写不敏感子串匹配；结果按 `uploadedAt` 倒序；默认显示前 20 条，`--all` 全量，`--limit N` 调整。
- **同文件多端上传会产生多条记录（不同 fid 也正常，网盘同名不覆盖自动加后缀）**：取最新一条；需要精确时用第 2 层核对。

### 第 2 层：云端检索（权威）

```bash
# A. 直接在规范树内搜
node "<插件根>/scripts/quark.cjs" ensure-base        # 拿 baseFid
node "<插件根>/scripts/quark.cjs" search --keyword "<名字或扩展名>" --parent-fid <baseFid>

# B. 或逐级浏览（知道大致目录时更直观）
node "<插件根>/scripts/quark.cjs" browse --parent-fid <baseFid> --all
node "<插件根>/scripts/quark.cjs" browse --parent-fid <文件/项目目录FID> --all
```

- 命令成功会输出 `type:"artifact"` 行：`data.file_path` 指向完整结果 JSONL。**读这个文件**拿全量 `fid/size/updated_at`，stdout 预览（≤5 条）只用于向用户展示。
- 搜不到时：扩大关键词（文件名片段、扩展名），或逐级 browse；仍无 → 第 3 层。

### 第 3 层：兜底

- 检查是否登录了**同一夸克账号**（`whoami` 对比昵称）——多端同步的大坑是两端登了不同账号。
- 检查文件是否真的上传成功（本端台账有没有记录、上传命令当时是否 `code:0`）。
- 都没有 → 如实告知用户，建议到夸克网盘 App 的"最近/回收站"里人工确认，或本端重新上传。

## 3. 上传后的记录动作（agent 必做）

上传成功后，从 `type:"result"` 行提取 `fids[]`，结合本地文件名与 ensure-dir 的目录路径，追加台账行：

```bash
echo '{"name":"big-model.bin","fid":"<fids[0]>","size":<totalSize 或本地字节数>,"path":"来自ZCode/文件/2026-10","uploadedAt":<Date.now()>,"host":"<hostname>"}' >> ~/.zcode-quark/ledger.jsonl
```

多文件上传时逐个追加。**忘记写台账不会导致文件丢失**——第 2 层云端检索不依赖台账。

## 4. 台账的维护

- 台账是**缓存**：可随时 `rm ~/.zcode-quark/ledger.jsonl`，之后正常上传会重建；云端文件不受影响。
- 跨设备不共享台账（它是每台机器的本地缓存）；换新机器时直接用第 2 层云端检索，把需要的历史文件 download 下来即可。
- 不要把台账提交进 git 或上传到网盘（无必要，且含本机路径信息）。

## 5. 与"多端同步"的配合

- 上传端：按 SKILL.md 第二节放置 + 写台账。
- 下载端：`search/browse` 拿 fid → `download --fid <fid> --output-dir <本地目录>` → 完成。
- 两端**各自登录一次**（授权绑定设备）；目录规范保证两端看到同样的网盘结构。
- 若用户需要"整目录镜像"级别的同步，按需 browse + download 组合实现；CLI 无删除命令，云端目录只增不减，天然防误删。
