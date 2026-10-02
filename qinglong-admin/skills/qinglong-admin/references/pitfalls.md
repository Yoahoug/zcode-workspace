# 交叉坑与判据（最容易做错的地方）

> 这些是"文档里散落各处、但每次都容易踩"的点。逐条都可在官方文档中对应原文。

## 成功/失败的判据

1. **`accepted: true` ≠ 跑成功。** `task run` 只是提交请求；脚本失败不会让 `run` 失败。要看**实例**与**日志内容**。
2. **最新日志可能属于上一次运行**；`logStatus: completed` **也不代表成功**。
3. **HTTP 200 也可能是业务错误。** 统一信封是 `{code:200,data:…}`；**必须同时检查 HTTP 状态与业务 code**。
4. **依赖创建/重装成功 ≠ 已安装完成**：看 `status` 与安装日志。
5. **订阅拉取成功 ≠ 脚本可用**：要确认脚本目录出现了目标文件。

## 请求形状（最常见的 400）

| 资源 | 规则 |
|---|---|
| `task update` | **必须**带 `command` + `schedule`；**不读旧值合并** ⇒ 先 `get`，整份提交 |
| `subscription update` | **必须**带 `type` + `url` + `alias`；`schedule_type` 可选 |
| `subscription create` | 必填 `type`/`url`/`alias`/`schedule_type`；`interval_schedule.value ≥ 1` |
| `env update` | **必须**同时给 `id`/`name`/`value`（不能只提交要改的标签） |
| `env create` | 请求体是**对象数组**；`name` 必须以字母或下划线开头，只能含字母/数字/下划线 |
| `dependency create` | 请求体是**数组**，`type` 用**数字**（0 Node / 1 Python3 / 2 Linux） |
| `dependency list` 筛选 | `type` 用**枚举名称** `nodejs`/`python3`/`linux`（和请求体的数字**不一样**） |
| 批量操作 | `task run/stop`、`subscription run/stop/enable/disable` 命名命令**一次一个 ID**；批量用 `ql api request … --data '[1,2]'` |
| 位置 ID | `task update 12 --data '…'` 会把位置 ID 注入请求体；**别在 --data 里重复给** |
| 同名冲突 | `--data` 与 `--query` **不要同时读标准输入**；同一字段**不要**同时用 `--data` 和命名选项 |

## 日志读取

- `GET /open/logs/detail` 的偏移是**字节**，不是字符；续读用返回的 **`nextOffset`**。
- `limit` 默认 **262144**、最大 **1048576** 字节；`tail:true` 读尾部（未给 offset 时默认也是尾部）。
- 响应可能带 `truncated`，要按需继续读。
- **删除/下载**接口的请求体字段是 **`filename`**（不是查询参数里的 `file`），另带 `path`。
- 只能操作**面板日志目录内**的路径，越权返回业务码 **403**。

## 已下线接口（返回业务码 **410**）

- `GET /open/configs/:file` → 改用 `GET /open/configs/detail?path=config.sh`（`ql config get`）
- `GET /open/scripts/:file` → 改用 `GET /open/scripts/detail`（`ql script get`）
- `GET /open/logs/:file` → 改用 `GET /open/logs/detail`（`ql log get`）

## 脚本相关

- `PUT /open/scripts/run` 是**调试**用途：传 `content` 会生成并执行同目录**临时文件**（如 `demo.js` → `demo.swap.js`）；**省略 `content` 会写入空内容**，不会读取原脚本。
- 要执行**已保存的定时任务**，用 `PUT /open/crons/run`（`ql task run <id>`）。
- 脚本列表**排除黑名单目录**（`node_modules`、`.git` 等），目录优先排序。

## 系统 / 数据 / 通知

- `PUT /open/system/command-run` 返回的是**持续输出的流**（`Content-type: application/octet-stream`，带响应头 `QL-Task-Pid`、`QL-Task-Log`），**不是 JSON**；结束即关流。停止用 `/open/system/command-stop`（`command` 或 `pid`）。
- **数据导出** `PUT /open/system/data/export`：省略 `type` 或传空数组时**只导出 `db` 和 `upload`**，**不含**脚本/配置/日志；要带上得传 `{"type":["scripts","config","log"]}`。`base` 表示基础数据，不是额外目录。
- **数据导入** `PUT /open/system/data/import` 只是**解压到临时目录**；必须再 `PUT /open/system/reload` + `{"type":"data"}` 才会替换并重启，**且会清空现有数据目录**（备份里没有的目录不会保留）。导入前先备份。
- **通知枚举**：HTTP 接口与脚本内置 gRPC API 的枚举**不同**（例如 Chronocat 在 HTTP 里是 `Chronocat`）。别混用。
- **日志保留/清理**（`storage-retention/*`）：`cleanup` 是**破坏性**的，先 `preview`。

## 用户与凭据

- 登录接口限速：**每 15 分钟最多 100 次**；两步验证登录 **每 15 分钟最多 20 次**。
- 应用 token：有效期 **30 天**，每应用最多保留 **5 个**；**重置密钥会清空已有 token**（不可逆）。
- `ql auth logout` **只删本机配置**，不撤销服务端 token。
- IP 黑名单只接受**单个 IPv4/IPv6 地址**，**不支持 CIDR**。
- 应用名**不能用保留字 `system`**。

## 单位与时间

- 仪表盘：`avgTime`/`maxTime` 单位**毫秒**；运行中实例 `elapsed` 单位**秒**。
- 任务统计 `POST /open/dashboard/record`：`ref_id`=任务 ID，`code`=脚本退出码（**0 表示成功**），`elapsed`=**秒**；它是**写接口**，会累加当天统计。
- Cron 规则按**面板时区**解释（本机 Asia/Shanghai）。
- 任务已删除但统计保留时，仪表盘成功/失败列表里 `deleted: true`。

## 权限（scope）速查

| 模块 | 需要的应用权限 |
|---|---|
| 定时任务 | `crons` |
| 订阅 | `subscriptions` |
| 环境变量 | `envs` |
| 脚本 | `scripts` |
| 配置文件 | `configs` |
| 日志 | `logs` |
| 依赖 | `dependencies` |
| 系统 | `system` |
| 仪表盘 | `dashboard` |
| 应用管理 | `apps`（或有效授权面板会话） |
| 用户 | `user` |

**路由存在 ≠ 已授权**。`ql auth status --scope X` 只检查该模块的代表性**读**接口，不代表写操作都可用。
