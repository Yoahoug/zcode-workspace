# 日志与统计

## 日志类型

`type` 是数字码（`model/log.go`）：

| 值 | 名称 | 含义 |
| --- | --- | --- |
| 0 | all | **查询时的「不过滤」**，不是一种日志类型 |
| 1 | topup | 充值 |
| 2 | consume | 消费 |
| 3 | manage | 管理操作 |
| 4 | system | 系统 |
| 5 | error | 错误 |
| 6 | refund | 退款 |
| 7 | login | 登录 |

CLI 的 `--type` 接受名称也接受数字：`--type error` 等价于 `--type 5`。

## 日志字段

| 字段 | 说明 |
| --- | --- |
| `id` | 自增（ClickHouse 后端下是合成的显示序号） |
| `created_at` | Unix 秒 |
| `type` | 见上表 |
| `user_id` / `username` | 归属 |
| `token_id` / `token_name` | 使用的令牌 |
| `model_name` | 模型 |
| `channel` / `channel_name` | 渠道 id / 名称 |
| `quota` | 消耗额度 |
| `prompt_tokens` / `completion_tokens` | token 数 |
| `use_time` | 耗时秒数 |
| `is_stream` | 是否流式 |
| `group` | 使用的分组 |
| `ip` | 来源 IP |
| `request_id` / `upstream_request_id` | 请求 id |
| `content` | 摘要内容 |
| `other` | JSON 附加信息，**按调用者角色过滤**，非 Root 管理员看不到 Root 专属诊断字段 |

**`channel_name` 在对用户作用域的查询里会被清空**（`/api/log/self` 不返回渠道名，避免泄露上游信息）。

## 查询日志

```bash
newapi-admin logs list --type consume --start 2024-01-01 --end 2024-01-31
newapi-admin logs list --username alice --model gpt-4o
newapi-admin logs list --channel 1 --request-id abc123
newapi-admin logs list --all                       # 全量翻页
newapi-admin logs self --start 2024-01-01          # 自己的日志
```

`GET /api/log/`（全部）支持的过滤：

| 参数 | 匹配方式 |
| --- | --- |
| `type` | `0` = 全部类型，否则精确匹配 |
| `start_timestamp` / `end_timestamp` | `created_at` 闭区间；`0` 表示不限 |
| `username` | **含 `%` 则模糊，否则精确** |
| `model_name` | **含 `%` 则模糊，否则精确** |
| `token_name` | 恒为精确 |
| `request_id` / `upstream_request_id` | 恒为精确 |
| `channel` | 渠道 id，`0` = 不过滤 |
| `group` | 精确 |
| `p` / `page_size` | 分页，默认 10，上限 100 |

`GET /api/log/self` 参数相同，但**没有 `username` 和 `channel`**（强制限定为调用者自己），且计数上限 10000。

### 已废弃的两个接口

`GET /api/log/search` 和 `GET /api/log/self/search` **已经废弃**，调用恒返回：

```json
{ "success": false, "message": "该接口已废弃" }
```

它们仍然挂在路由上，所以不会 404，但没有任何作用。**用 `GET /api/log/` 加过滤参数代替。**

## 日志统计

```bash
newapi-admin logs stat --start 2024-01-01 --end 2024-01-31
newapi-admin logs self-stat
```

返回 `{"quota": 125000, "rpm": 4, "tpm": 8123}`。

**这三个字段的时间语义不一样，非常重要：**

| 字段 | 语义 |
| --- | --- |
| `quota` | 统计 `type = consume`（消费）的额度之和，**受 `--start`/`--end` 约束** |
| `rpm` | 每分钟请求数，**恒为最近 60 秒**，完全忽略传入的时间区间 |
| `tpm` | 每分钟 token 数（prompt + completion），**同样是最近 60 秒** |

所以想「查上个月的 RPM」是做不到的——这个接口只给实时速率。传 `type` 参数也没有意义，SQL 里恒定为消费类型。

## 聚合用量数据

`/api/data/*` 系列按模型/用户聚合，字段比日志更适合做报表：

| 接口 | 权限 | 参数 |
| --- | --- | --- |
| `GET /api/data/` | 管理员 | `start_timestamp`、`end_timestamp`、`username` |
| `GET /api/data/users` | 管理员 | `start_timestamp`、`end_timestamp` |
| `GET /api/data/flow` | 管理员 | **起止时间必填且 `end >= start`**，`username` 可选 |
| `GET /api/data/self` | 用户 | 起止时间；**跨度上限 30 天** |
| `GET /api/data/flow/self` | 用户 | 起止时间；跨度上限 30 天 |

```bash
newapi-admin data usage --start 2024-01-01 --end 2024-02-01
newapi-admin data by-user --start 2024-01-01 --end 2024-02-01
newapi-admin data flow --start 2024-01-01 --end 2024-01-31
```

`/api/data/flow` 不给时间会报 `invalid start_timestamp`，这不是可选参数。CLI 会在本地先拦住并提示。

聚合数据字段：`user_id`、`username`、`model_name`、`use_group`、`token_id`、`channel_id`、`node_name`、`token_used`、`count`、`quota`、`created_at`。

流水（flow）字段更细，还带 `token_name`、`channel_name`。注意管理员调用时 `username`、`node_name`、`user_id`、`token_name` 会被省略或清空。

## 审计日志

```bash
newapi-admin audit --start 2024-01-01 --username root
newapi-admin audit self
```

`GET /api/audit` 记录管理操作（改渠道、改用户、改配置等），需要 `audit:read` 权限。`/api/audit/self` 是用户级的，返回自己的操作记录。

排查「谁改了定价」这类问题用审计日志，不是请求日志。

## 日志清理

```bash
newapi-admin logs cleanup --before 2024-01-01 --yes
```

对应 `POST /api/system-task/log-cleanup?target_timestamp=<Unix秒>`，**Root only**，会创建一个系统任务异步删除该时间点之前的日志。

`--before` 接受日期或 Unix 秒。这是不可逆操作，执行前先用 `logs list --end <时间>` 确认范围。

查看任务进度：

```bash
newapi-admin system tasks
newapi-admin system current --type log_cleanup
```

## CLI 速查

```bash
newapi-admin logs list --type error --start 2024-01-01 --all
newapi-admin logs list --model gpt-4o --username alice
newapi-admin logs stat --start 2024-01-01 --end 2024-01-31
newapi-admin data usage --start 2024-01-01 --end 2024-02-01
newapi-admin data flow --start 2024-01-01 --end 2024-01-31
newapi-admin audit --start 2024-01-01
newapi-admin logs cleanup --before 2024-01-01 --yes
```

`--start` / `--end` 同时接受 Unix 秒和 `2024-01-01`、`2024-01-01T08:00:00Z` 形式。
