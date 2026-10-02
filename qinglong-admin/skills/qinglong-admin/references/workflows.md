# 处方集（照着做就行）

> 所有示例的 URL 用本机面板 `http://127.0.0.1:15700`；ID 一律**先查后用**。
> 通用纪律：**变前先 `get`，变后回读 `get`/`list` 验证**；`accepted` 只代表"请求被接受"。

## 0. 一次性准备（登录）

```bash
ql login --url http://127.0.0.1:15700        # 输入 Client ID / Client Secret（不落命令行）
ql auth status --scope crons --json          # 确认已登录且 crons 可用
ql env list --json                           # 再验证一条实际读取
```
按模块逐个确认权限：`--scope envs|subscriptions|scripts|configs|logs|dependencies|dashboard|system|apps|user`。

## 1. 新建一个定时任务，并确认它真的能跑

```bash
# 1) 先确认脚本已在面板里（没有就先建）
ql script list --query '{"path":""}' --json
ql script get --query '{"file":"hello.js","path":""}' --json

# 2) 建任务（command 用面板执行器语法：task <相对路径>）
ql task create --name 'hello 测试' --command 'task hello.js' --schedule '0 9 * * *' --json

# 3) 回读确认字段（拿到真实 ID）
ql task list --search hello --json

# 4) 手动跑一次（run 只提交请求）
ql task run <ID> --json

# 5) 等它跑完，再看实例与日志（关键：看内容与退出码，不看 accepted）
ql task instances <ID> --json
ql task logs <ID> --tail 200 --json
```
**判成功**：日志里有本次运行的输出、没有报错、实例状态结束；`logStatus`/`accepted` 都不算证据。

## 2. 批量运行 / 批量启停

```bash
# 命名命令一次只接受一个 ID；批量走原样请求体
ql api request PUT /open/crons/run --data '[12,13,14]' --json
ql task enable 12 13 14 --json
ql task disable 12 13 14 --json     # 这几个命令支持多 ID
```
批量前先报**数量与对象**给 owner（属于有影响操作）。

## 3. 看任务最近情况（排障入口）

```bash
ql task list --json                       # 总览：状态、上次运行时间
ql task instances <ID> --json             # 运行中/排队中的实例（elapsed 单位秒）
ql task log-files <ID> --json             # 该任务的日志文件列表
ql log get --query '{"path":"<日志目录>","file":"<文件>","tail":true}' --json
```
大日志用**字节偏移**续读：先拿到 `nextOffset`，再 `--query '{"file":"…","path":"…","offset":<nextOffset>}'`。

## 4. 环境变量：查 / 增 / 改 / 批量改名 / 文件导入

```bash
ql env list --query '{"searchValue":"JD_"}' --json
# 新增（请求体是数组！）
cat > /tmp/envs.json <<'JSON'
[{"name":"EXAMPLE_KEY","value":"demo","remarks":"示例"}]
JSON
ql env create --data @/tmp/envs.json --json

# 改一条：必须同时给 id/name/value（不是补丁）
ql env update <ID> --data '{"id":<ID>,"name":"EXAMPLE_KEY","value":"new-value","remarks":"改了值"}' --json

# 批量改名 / 启停 / 置顶
ql env rename --data '{"ids":[1,2],"name":"NEW_NAME"}' --json
ql env disable 1 2 --json ; ql env enable 1 2 --json
ql env pin 1 --json ; ql env unpin 1 --json

# 文件导入（multipart，字段名 env）
printf '[{"name":"IMPORTED","value":"1"}]' > /tmp/imp.json
ql env upload --file /tmp/imp.json --json
```
注意：**导入只新建，不按 id 更新**；变量名必须以字母/下划线开头。

## 5. 订阅（仓库脚本）新增并拉取

```bash
ql subscription create --type public-repo --url <repo-url> --alias demo \
  --schedule-type crontab --schedule '0 0 * * *' --json
ql subscription run <ID> --json          # 触发拉取
ql subscription logs <ID> --tail 200 --json
```
- 复杂字段（白名单/黑名单/分支/依赖/hook/间隔计划）用 `--data @sub.json`；创建必填 `type/url/alias/schedule_type`。
- **私有仓库凭据**用受保护文件或标准输入，不要写进命令行、不要贴聊天。

## 6. 依赖安装与判断

```bash
ql dependency list --query '{"type":"nodejs"}' --json      # 查询用枚举名称
ql dependency create --data '[{"name":"axios","type":0}]' --json   # 请求体用数字：0=Node 1=Python3 2=Linux
ql dependency reinstall <ID> --json
ql dependency cancel <ID> --json
```
**创建/重装成功 ≠ 安装完成**：继续看 `status`（0 安装中 / 1 已安装 / 2 失败 / 3 删除中 / 4 已删除 / 5 删除失败 / 6 排队 / 7 已取消）与安装日志。

## 7. 发一条通知（测试推送）

```bash
curl -sS -X PUT 'http://127.0.0.1:15700/open/system/notify' \
  -H "Authorization: Bearer $QL_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"测试","content":"来自青龙管理助手的测试消息"}' | head -c 300
```
或：`ql system notify --data '{"title":"测试","content":"…"}' --json`。
不传 `notificationInfo` 就用面板默认推送渠道；要临时指定渠道见 [openapi-system.md](openapi-system.md)（22 种枚举）。

## 8. 面板级备份 / 升级 / 恢复（本机运维）

```bash
D=/data/appdata/qinglong-ubuntu
docker compose -f $D/docker-compose.yaml stop qinglong
tar -czf "$D/backup/qinglong-data-$(date +%Y%m%d-%H%M%S).tar.gz" -C $D data
docker compose -f $D/docker-compose.yaml start qinglong
```
- **先停再打包**，避免复制正在写入的数据库。备份**含账号、应用密钥、环境变量值** ⇒ 存到受控位置。
- 升级：`docker compose -f … pull qinglong && docker compose -f … up -d qinglong`，然后看 `logs --tail 100`，验证登录/脚本/任务/日志。
- **不要**把降级当作完整回滚；回滚要用与备份匹配的镜像+数据。
- 面板自带的 **数据导入导出**（`system data-export` / `data-import`）**不是**完整备份：导入后要 `ql system reload --data '{"type":"data"}'`，而且会**清空**数据目录。

## 9. 巡检（日常自查）

```bash
ql dashboard overview --json          # 总数/启用/今日运行/成功率/平均耗时
ql dashboard runtime --json           # 运行中实例、排队、近期未执行
ql dashboard top-time --json          # 耗时榜
curl -sS 'http://127.0.0.1:15700/open/dashboard/failures' -H "Authorization: Bearer $QL_ACCESS_TOKEN"   # CLI 未收录，直连 HTTP
ql system info --json                 # 版本/更新信息
```
巡检结论要落到"哪个任务、何时、什么错"，别只报数字。

## 10. 出问题时（先判层，再动手）

| 现象 | 先查 |
|---|---|
| CLI 报 401 | `ql auth status`；是否被 `QL_URL/QL_ACCESS_TOKEN` 环境变量覆盖；token 是否过期 |
| CLI 报 403 | 该应用**没有对应模块 scope**；或访问了受限路径（配置/日志黑名单） |
| 任务不触发 | 任务是否启用、cron 是否正确、面板时区、是否在排队 |
| 任务跑了但没结果 | 看实例与**本次**日志（不是上一个）；脚本自身报错/依赖缺失 |
| 找不到脚本 | `ql script list` 看路径；子目录要写 `task folder/hello.js` |
| 缺 Node/Python 模块 | 依赖管理里装；再看安装日志与 `status` |
| 面板打不开 | 本机：`docker ps`/`docker logs --tail 100 qinglong`；见 panel-this-box.md |
