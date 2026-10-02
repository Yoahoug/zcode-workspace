# 本机青龙面板：部署事实与本机运维

> 实测日期 2026-10-01（面板 2.20.0-1）。服务器层运维（容器/网络/磁盘）归属 @hermes 的职责范围；本文件只覆盖**青龙自身**的部署事实与它自带的维护手段。

## 1. 部署事实

| 项 | 值 |
|---|---|
| 容器名 | `qinglong` |
| 镜像 | `whyour/qinglong:debian`（alpine 版缺依赖时用 debian 版；非 root 运行须用 debian 镜像 + `--user qinglong`） |
| 面板版本 | **2.20.0-1** |
| 端口 | 宿主 **15700** → 容器 5700（`http://127.0.0.1:15700`） |
| 数据目录 | 宿主 `/data/appdata/qinglong-ubuntu/data` → 容器 `/ql/data`（约 679 MB） |
| Compose 工程 | `qinglong-ubuntu`（v5.3.1），配置文件 `/data/appdata/qinglong-ubuntu/docker-compose.yaml` |
| 重启策略 | `unless-stopped`；网络 `qinglong-ubuntu_default` |
| 容器环境 | `QL_DIR=/ql`，`QL_BRANCH=debian`，`QL_USER=qinglong`，`ENABLE_WEB_PANEL=true`，`ENABLE_HANGUP=true` |
| 时区 | Asia/Shanghai（CST） |
| 数据目录内容 | `db/`（`database.sqlite`、`keyv.sqlite`）、`config/`（`config.sh`、`extra.sh`、`task_before.*`…）、`scripts/`、`log/`、`repo/`、`deps/`、`bak/`、`raw/` |
| 当前资源（2026-10-01） | 定时任务 2、环境变量 8、订阅 0、OpenAPI 应用 2 |
| 远程 CLI | `ql` → `/data/npm/global/bin/ql`（`@whyour/qinglong-cli` 0.1.1；Node 24.21.0） |

**凭据不落本文件**：应用 Client ID / Secret 由 owner 直接交给 agent；CLI 自己存在 `~/.config/qinglong/cli.json`（0600）。

## 2. 面板内置 Shell 命令（本机 / 容器内执行）

`docker exec -it qinglong bash` 进容器后可用（或经内部 TS 工具，见第 3 节）：

### `task` —— 执行脚本

```bash
task <file_path>                       # 依次执行（有随机延迟则先延迟）
task <file_path> now                   # 立即执行，前台输出日志并写入日志文件
task <file_path> conc <env_name> <account_number>   # 并发执行，前台不输出日志
task <file_path> desi <env_name> <account_number>   # 指定账号执行
task -m <max_time> <file_path>         # 设置超时
task <file_path> -- -u whyour -p password           # -- 之后的参数传给脚本
```

### `ql` —— 维护与仓库

```bash
ql update          # 更新并重启青龙
ql extra           # 运行自定义脚本 extra.sh
ql raw <file_url>  # 添加单个脚本文件
ql repo <repo_url> <whitelist> <blacklist> <dependence> <branch> <extensions>   # 拉取仓库
ql rmlog <days>    # 删除旧日志
ql bot             # 启动 tg-bot
ql check           # 检测青龙环境并修复
ql resetlet        # 重置登录错误次数
ql resettfa        # 禁用两步登录
```

`ql repo` 参数含义：白名单/黑名单用 `|` 分割；`dependence` 是仓库里的依赖文件（会拷到 `scripts` 下仓库目录，不受黑名单影响）；`extensions` 是文件后缀（`|` 分割）；`branch` 是分支。

## 3. 面板内部 TypeScript 工具（可选入口）

需要在**面板宿主机/容器内**、且已构建 `cli/dist`（Node ≥ 22.12、Bash）：

```bash
node /ql/cli/dist/ql.js task exec --root /ql demo.js now
node /ql/cli/dist/ql.js reload --root /ql
docker exec qinglong node /ql/cli/dist/ql.js task exec --root /ql demo.js now
```

- 只有挂载 `data` 目录**不构成**本机运行环境；**不能用工作站的 npm CLI 执行这些命令**。
- 想在面板内部启用它：设 `QL_CLI_ROOT=/absolute/path/to/qinglong/cli` 后重启面板（加载器在运行用户 `~/bin` 建 `ql`/`task`/`crontab` 包装器）；路径无效会**报错，不静默降级**；清除该变量并重启即恢复原 Shell 入口。
- 常用：`ql task exec`、`ql repo`、`ql raw`、`ql start`、`ql repair-config`、`ql check`、`ql update [--mirror github|gitee] [--download-only]`、`ql reload [--target services|system|data]`、`ql rmlog <days>`、`ql extra`、`ql bot`、`ql resetlet`、`ql resettfa`、`ql resetpwd -- <值>`、`ql resetname -- <值>`。
- 维护选项 `--root`、`--data-dir`、`--json` 放在 `--` **之前**；`resetpwd` 的密码是位置参数**会出现在进程列表**里，只在可信终端做。
- `ql check` 会**安装依赖、修复并重载服务**（有影响）；`reload` 默认重启服务。

## 4. 备份 / 升级 / 恢复

**备份（先停再打包，避免复制写入中的数据库）**

```bash
D=/data/appdata/qinglong-ubuntu
docker compose -f $D/docker-compose.yaml stop qinglong
sudo tar -czf "$D/backup/qinglong-data-$(date +%Y%m%d-%H%M%S).tar.gz" -C $D data
docker compose -f $D/docker-compose.yaml start qinglong
```

- 备份应覆盖**整个 data 目录**（数据库、脚本、配置、日志）。
- **备份里可能含账号信息、应用密钥和环境变量值** ⇒ 存到受控位置；记录当前镜像版本/摘要，并复制到独立存储。

**升级**

```bash
docker compose -f $D/docker-compose.yaml pull qinglong
docker compose -f $D/docker-compose.yaml up -d qinglong
docker compose -f $D/docker-compose.yaml logs --tail 100 qinglong
```

升级后验证：登录、脚本目录、任务、日志。需要固定版本就把镜像改成指定标签/摘要。

**恢复**

停面板 → 把当前 `data` 移到别处保留 → 解压备份到部署目录（最终结构仍是 `./data/...`）→ 确认属主与权限 → 启动。**不要**直接把备份覆盖到正在运行的数据库上；首次恢复建议在隔离环境验证，并先禁用定时任务/断开外部服务，避免重复执行真实任务。

**回滚提醒**：不要把"降级镜像"当作完整回滚 —— 新版可能改了数据结构；回滚要用与备份匹配的镜像 + 数据。

## 5. 常见问题矩阵

| 现象 | 排查 |
|---|---|
| 无法访问面板 | `docker ps`、`docker logs --tail 100 qinglong`；核对端口映射、代理路径、防火墙 |
| 找不到脚本 | 核对脚本管理里的路径；子目录用 `task folder/hello.js` |
| 缺少 Node/Python 模块 | 依赖管理里装对应语言依赖，看安装日志后再运行 |
| 定时未触发 | 任务是否启用、cron 规则、时区、是否排队/有运行中实例 |
| 挂载目录不可写 | 宿主机目录权限、容器运行用户、SELinux |
| CLI 401/403 | 凭据/token 是否有效；`ql auth status --scope crons --json`；确认环境令牌没有覆盖已保存配置 |
| `ql` 不识别命令 | `command -v ql`、`ql --help` 确认是**远程 CLI** 还是**内部工具** |
| 依赖装不上 | `ql system config-dependence-proxy` / `node-mirror` / `python-mirror`（镜像与代理） |

**分享日志前先移除** token、环境变量值和私有仓库凭据。
