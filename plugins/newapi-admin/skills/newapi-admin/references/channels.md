# 渠道管理

上游渠道是本系统里字段最多、权限分层最细的实体。这一篇给出完整的字段表、类型码表，以及几个「看起来能用其实不行」的坑。

## 权限分层

所有渠道路由先过 `AdminAuth`（`role >= 10`），再叠加细粒度权限：

| 权限 | 覆盖 | 默认授予 |
| --- | --- | --- |
| `channel:read` | 列表、详情、模型目录、默认 base_url、vLLM/SGLang/Codex 状态 | 管理员 |
| `channel:operate` | 启停、测试、余额、拉取上游模型、修能力、多密钥 | 管理员 |
| `channel:write` | 更新渠道、标签编辑、批量打标、上游模型更新应用 | 管理员 |
| `channel:sensitive_write` | **新增、删除、复制、读密钥、密钥刷新、上游模型检测** | **无，默认仅 Root** |

**默认情况下普通管理员不能新增或删除渠道**，会返回「权限不足」。这不是 bug。要么用 Root 令牌，要么由 Root 在权限管理里单独授予 `channel:sensitive_write`。

`POST /api/channel/{id}/key` 是另一条路径：它要求 **Root**，并且还要求请求头带 `X-Security-Proof`（通过 `POST /api/verify` 取得的短期二次验证证明）。缺这个头会返回 `SECURITY_PROOF_REQUIRED`。

## 渠道对象字段表

`add` / `update` 的请求体就是这个对象（`add` 外面还要套一层，见下）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | 更新时必填；新增时忽略 |
| `name` | string | 渠道名，有索引 |
| `type` | int | 渠道类型码，见下方类型表 |
| `key` | string | 密钥。多密钥用 `\n` 分隔；Vertex/AWS 可能是 JSON 数组或 JSON 对象字符串。**读取时永远返回空串**，见下 |
| `base_url` | string | 上游地址；部分类型（`60`/`62`/`63`）必填 |
| `models` | string | **逗号分隔**的模型名，如 `"gpt-4o,gpt-4o-mini"` |
| `group` | string | **单数**，逗号分隔的可用分组，如 `"default,vip"`。DB 默认 `'default'` |
| `priority` | int64 | 优先级，调度的主排序键（默认按它降序） |
| `weight` | uint | 同优先级内的加权随机权重 |
| `status` | int | 1/2/3，见状态表。**更新时不能带这个字段** |
| `test_model` | string | 测试渠道时用的模型 |
| `auto_ban` | int | `1` = 允许错误率过高时自动封禁，`0` = 关闭 |
| `openai_organization` | string | OpenAI / Azure 组织 |
| `tag` | string | 标签，可按标签批量操作 |
| `remark` | string | 备注，最长 255 |
| `model_mapping` | string | **JSON 字符串**，`{"客户端模型名":"上游模型名"}`，支持链式跟随 |
| `status_code_mapping` | string | **JSON 字符串**，`{"429":500}`，把上游状态码改写成别的 |
| `setting` | string | **JSON 字符串**，渠道设置，见下 |
| `settings` | string | **JSON 字符串**，其他设置（Azure 版本、Vertex 密钥类型等）。注意字段名是 `settings`，**不是** `other_settings` |
| `param_override` | string | **JSON 字符串**，请求参数覆盖规则 |
| `header_override` | string | **JSON 字符串**，请求头覆盖规则 |
| `other` | string | 原始字符串；VertexAI 用 JSON 存部署区域 |
| `other_info` | string | **JSON 字符串**，系统写入的封禁原因/时间 |
| `channel_info` | object | **结构化对象**（不是字符串），多密钥状态。更新时被忽略，由服务端保留原值 |
| 只读 | — | `created_time`、`test_time`、`response_time`、`balance`、`balance_updated_time`、`used_quota`、`key`（读） |

### `setting` 里放什么

`setting` 是 JSON 字符串，键都是可选的（`proxy` 除外）：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `proxy` | string | `http`/`https`/`socks5`/`socks5h` 代理地址，有严格校验 |
| `force_format` | bool | 强制以 OpenAI 格式输出 |
| `thinking_to_content` | bool | 把推理内容转成 `<think>` |
| `pass_through_body_enabled` | bool | 透传请求体 |
| `responses_websocket_enabled` | bool | 启用 Responses WebSocket |
| `system_prompt` / `system_prompt_override` | string / bool | 注入系统提示词及是否覆盖原有 |
| `http_protocol` | string | `""`/`"auto"`/`"http1"` |
| `http2_connection_shards` | int | 1–8；`http1` 时必须为 1 |
| `task_plugin_key` | string | 类型 61 绑定的任务插件 |
| `task_extend_plugin_keys` | []string | 类型 60 的扩展插件绑定（最多 32） |

例：`"setting": "{\"force_format\":true,\"proxy\":\"socks5://proxy.example:1080\"}"`

### `settings` 里放什么

按需要选填：`azure_responses_version`、`vertex_key_type`（`"json"`/`"api_key"`）、`aws_key_type`（`"ak_sk"`/`"api_key"`）、`openrouter_enterprise`、`claude_beta_query`、`allow_service_tier`、`allow_inference_geo`、`allow_speed`、`allow_safety_identifier`、`disable_store`、`allow_include_obfuscation`、`disable_task_polling_sleep`、`ollama_openai_chat`、`tool_loss_policy`（`""`/`"allow"`/`"safe"`/`"strict"`）、`advanced_custom`，以及 `upstream_model_update_*` 系列（上游模型自动检测/同步开关、上次检测时间、忽略列表等）。

## 新增渠道：请求体是套娃的

`POST /api/channel/` 的请求体**不是**渠道对象本身，而是：

```json
{
  "mode": "single",
  "multi_key_mode": "random",
  "batch_add_set_key_prefix_2_name": false,
  "channel": { "name": "openai-main", "type": 1, "key": "sk-xxx", "models": "gpt-4o", "group": "default" }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `mode` | **是** | `single` / `batch` / `multi_to_single`，其他值返回「不支持的添加模式」 |
| `channel` | **是** | 渠道对象 |
| `multi_key_mode` | 否 | `random` / `polling`，仅 `multi_to_single` 时有意义 |
| `batch_add_set_key_prefix_2_name` | 否 | `mode=batch` 且多个 key 时，把 key 前 8 位追加到渠道名，便于区分 |

三种模式的行为：

- **`single`**：一个渠道，`key` 就是密钥。
- **`batch`**：把 `channel.key` 按换行切分，**每个 key 建一个渠道**。空行跳过。VertexAI 非 `api_key` 模式要求 key 是 JSON 数组。
- **`multi_to_single`**：一个渠道装多个 key，`key` 归一化为换行分隔，`channel_info.is_multi_key=true`，`multi_key_size` 为 key 数量。

成功响应**没有 `data`**，只有 `{"success":true,"message":""}`——新建的渠道 id 不会返回，需要事后搜索。

## 更新渠道：扁平对象，且不能带 status

`PUT /api/channel/` 的请求体是**扁平的渠道对象**（不套 `channel`，没有 `mode`），必须带 `id`。两个额外字段：

| 字段 | 说明 |
| --- | --- |
| `key_mode` | `append` / `replace`。仅当渠道已是多密钥模式时生效；`append` 会去重后追加，`replace` 直接替换 |
| `multi_key_mode` | 覆盖 `channel_info.multi_key_mode` |

**带上 `status` 会导致整个请求失败**（`参数错误`）。启停请用：

- 单渠道：`POST /api/channel/{id}/status`，体 `{"status": 1}` 或 `{"status": 2}`
- 批量：`POST /api/channel/status/batch`，体 `{"ids":[1,2],"status":1}`
- 只接受 `1` 和 `2`；`3`（自动禁用）不能由客户端写入

改敏感字段（`type`、`key`、`base_url`、`setting`、`settings`、`param_override`、`header_override`、`other`、`openai_organization`、`key_mode`）额外需要 `channel:sensitive_write`。判定是**失败关闭**的：请求体里出现任何未在白名单内的键，也算敏感改动。

响应返回更新后的渠道（`key` 为空串）。

## 密钥为什么读不到

`GET /api/channel/`、`/api/channel/{id}`、`/api/channel/search` 返回的 `key` **恒为空字符串**——服务端在查询时 `Omit("key")`。

要拿明文密钥只有一条路：`POST /api/channel/{id}/key`，要求 Root + `X-Security-Proof`，响应 `{"key":"sk-..."}`。这是有意的设计，不是权限没配好。

## 渠道类型码

来源 `constant/channel.go`。CLI 的 `--type` 接受数字码或下表的英文名。

| 码 | 名称 | 码 | 名称 | 码 | 名称 |
| --- | --- | --- | --- | --- | --- |
| 0 | Unknown | 22 | FastGPT | 45 | VolcEngine |
| 1 | OpenAI | 23 | Tencent | 46 | BaiduV2 |
| 2 | Midjourney | 24 | Gemini | 47 | Xinference |
| 3 | Azure | 25 | Moonshot | 48 | xAI |
| 4 | Ollama | 26 | ZhipuV4 | 49 | Coze |
| 5 | MidjourneyPlus | 27 | Perplexity | 50 | Kling |
| 6 | OpenAIMax | 31 | LingYiWanWu | 51 | Jimeng |
| 7 | OhMyGPT | 33 | AWS | 52 | Vidu |
| 8 | Custom | 34 | Cohere | 53 | Submodel |
| 9 | AILS | 35 | MiniMax | 54 | Doubao |
| 10 | AIProxy | 36 | SunoAPI | 55 | Sora |
| 11 | PaLM | 37 | Dify | 56 | Replicate |
| 12 | API2GPT | 38 | Jina | 57 | Codex |
| 13 | AIGC2D | 39 | Cloudflare | 58 | AdvancedCustom |
| 14 | Anthropic | 40 | SiliconFlow | 59 | Sub2API |
| 15 | Baidu | 41 | VertexAI | 60 | NewAPI |
| 16 | Zhipu | 42 | Mistral | 61 | TaskPlugin |
| 17 | Ali | 43 | DeepSeek | 62 | VLLM |
| 18 | Xunfei | 44 | MokaAI | 63 | SGLang |
| 19 | 360 | | | | |
| 20 | OpenRouter | | | | |
| 21 | AIProxyLibrary | | | | |

注意 **28、29、30、32 没有定义**，不要使用。`64` 是哨兵值，只在源码里标记边界。

## 渠道状态

| 值 | 含义 | 能否手动设置 |
| --- | --- | --- |
| 0 | 未设置 | 不可以，永远不要写 |
| 1 | 启用 | 可以 |
| 2 | 手动禁用 | 可以（人工、标签批量操作、余额耗尽、key 全禁用都会落到这里） |
| 3 | 自动禁用 | **不可以**，由错误率/健康检查自动写入 |

列表/搜索的 `status` 查询参数是**字符串**，只认两种写法：`enabled` 或 `1` → 只返回 status 1；`disabled` 或 `0` → 返回 status ≠ 1（含 2 和 3）。传别的值等于不过滤。

## 列表与搜索

`GET /api/channel/` 支持的过滤：

| 参数 | 说明 |
| --- | --- |
| `p` / `page_size` | 分页，默认 `page_size=10`，上限 100 |
| `id_sort` | `true` 且未指定 `sort_by` 时按 id 降序，而非默认的 priority 降序 |
| `sort_by` | `id` / `name` / `priority` / `balance` / `response_time` / `test_time`，其他值被丢弃 |
| `sort_order` | 只有 `asc` 表示升序，其他（含空）都是 `desc` |
| `tag_mode` | `true` 时按标签分组返回 |
| `group` | 分组过滤；`""`/`all`/`null`（忽略大小写）表示不过滤 |
| `status` | 见上 |
| `type` | 精确匹配类型码 |

**没有 `tag` 查询参数**——按标签取渠道用的是 `GET /api/channel/tag/models?tag=x`（拿标签下的模型并集）。

响应额外带 `type_counts`（类型码 → 数量），可用于快速盘点渠道构成。

`GET /api/channel/search` 支持 `keyword`（匹配 id、name、key、base_url）、`model`、`group`、`status`、`type`、`tag_mode`、排序和分页。**默认 `page_size` 是 20**，且响应**不含** `page`/`page_size` 键。

## 测试、余额与能力

| 操作 | 路由 | 注意 |
| --- | --- | --- |
| 测试单个渠道 | `GET /api/channel/test/{id}?model=&stream=` | 成功返回 `{"success":true,"time":1.234}`——**`time` 在顶层，不在 `data` 里**，单位是秒 |
| 测试全部渠道 | `GET /api/channel/test` | **异步**，只入队并返回 `task_id`；已有任务在跑时返回 **HTTP 409** |
| 更新单个余额 | `GET /api/channel/update_balance/{id}` | 余额也在**顶层**：`{"success":true,"balance":12.34}`，不在 `data` 里。多密钥渠道不支持 |
| 更新全部余额 | `GET /api/channel/update_balance` | 同步逐个查，**不返回任何明细**；余额 ≤ 0 的渠道会被禁用 |
| 修能力表 | `POST /api/channel/fix` | 重建 abilities 表（渠道↔模型能力缓存）；并发时会返回「已经有一个修复任务在运行中」 |
| 拉取上游模型 | `GET /api/channel/fetch_models/{id}` | 用已保存渠道的密钥去问上游，返回模型名数组 |
| 试探上游模型 | `POST /api/channel/fetch_models` | 用**未保存**的 key/base_url 试探；需 `channel:sensitive_write`；body 需 `type`，可选 `channel_id`/`key`/`base_url`/`proxy`/`header_override` |
| 已启用模型 | `GET /api/channel/models_enabled` | 本实例实际启用的模型名数组（来自 abilities 表） |
| 内置模型目录 | `GET /api/channel/models` | **静态内置表**，不是你实例里配置的模型。别拿它当「我有什么模型」 |

什么时候该跑 `fix`：手工改了 `models` 字段、批量改标签模型、或渠道能力与实际不符时。`fix` 会清空并重建 abilities，是安全的重建，不是删除渠道。

## 标签批量操作

标签用来把一组渠道当作一个整体管理。

| 操作 | 路由 | 请求体 |
| --- | --- | --- |
| 按 id 打标 | `POST /api/channel/batch/tag` | `{"ids":[1,2,3],"tag":"team-a"}`；`tag` 省略或 `null` 表示清除 |
| 按标签启停 | `POST /api/channel/tag/enabled`、`POST /api/channel/tag/disabled` | `{"tag":"team-a"}` |
| 按标签批量编辑 | `PUT /api/channel/tag` | 见下 |
| 取标签下模型 | `GET /api/channel/tag/models?tag=x` | 返回模型最多的那个渠道的 `models` 字符串 |

**`PUT /api/channel/tag` 的字段名是 `groups`（复数）**，而渠道对象里是 `group`（单数）。这是真实的不一致，写错不会报错、只是不生效：

```json
{ "tag": "team-a", "new_tag": "team-b", "models": "gpt-4o", "groups": "vip", "priority": 10, "weight": 5 }
```

- `tag` 必填，空值报「tag不能为空」
- `new_tag` 重命名标签（会同时迁移 abilities）
- `models` / `groups` 非空时**整体替换**匹配渠道的该字段
- `param_override` / `header_override` 必须是合法 JSON，否则报错
- 带 `param_override` 或 `header_override` 时额外需要 `channel:sensitive_write`

## 多密钥管理

`POST /api/channel/multi_key/manage`：

```json
{ "channel_id": 12, "action": "get_key_status", "page": 1, "page_size": 50, "status": 1 }
```

| `action` | `key_index` | 说明 |
| --- | --- | --- |
| `get_key_status` | 不需要 | 分页列出密钥状态；`page`/`page_size` 默认 1/50，`status` 可过滤 1/2/3 |
| `enable_key` / `disable_key` | **必填** | 启用/禁用指定下标的密钥 |
| `delete_key` | **必填** | 删除指定下标的密钥（不能删到最后一个） |
| `enable_all_keys` / `disable_all_keys` | 不需要 | 全量启用/禁用 |
| `delete_disabled_keys` | 不需要 | 删除所有自动禁用的密钥 |

`delete_key` 和 `delete_disabled_keys` 额外需要 `channel:sensitive_write`（其他 action 只要 `channel:operate`）。

查询响应：

```json
{ "keys": [ {"index":0,"status":1,"key_preview":"sk-abcdefg..."} ],
  "total": 2, "page": 1, "page_size": 50, "total_pages": 1,
  "enabled_count": 1, "manual_disabled_count": 0, "auto_disabled_count": 1 }
```

`total` 是**按 `status` 过滤后**的数量；三个 `*_count` 是全量统计。密钥只返回前 10 位加省略号。

## 上游模型变化检测与同步

渠道的 `settings` 里可以打开 `upstream_model_update_auto_sync_enabled`。手动流程：

1. `POST /api/channel/upstream_updates/detect`（单个，body `{"ids":[1,2]}`）或 `detect_all`
2. `POST /api/channel/upstream_updates/apply` 或 `apply_all` 应用

检测需要 `channel:operate`，应用需要 `channel:write`。CLI 对应 `channels upstream detect|detect-all|apply|apply-all`。

注意这与 `models sync_upstream` **不是一回事**：那一个是同步官方模型**元数据**（描述、图标、供应商），不碰渠道。详见 [models-and-pricing.md](models-and-pricing.md)。

## CLI 速查

```bash
newapi-admin channels list --all                      # 全量盘点
newapi-admin channels list --status disabled          # 找禁用渠道
newapi-admin channels search --model gpt-4o           # 哪些渠道供这个模型
newapi-admin channels add --name relay --type Anthropic --key sk-xxx --models claude-sonnet-4 --group default
newapi-admin channels update 12 --models a,b --remark "换上游"
newapi-admin channels disable 12                      # 不能走 update
newapi-admin channels test 12 --model gpt-4o-mini
newapi-admin channels balance 12
newapi-admin channels fetch-models 12
newapi-admin channels tag set --ids 1,2 --tag team-a
newapi-admin channels tag edit --tag team-a --groups vip
newapi-admin channels keys status --channel 12
newapi-admin channels keys disable --channel 12 --index 3
newapi-admin channels fix                             # 能力表对不上时
newapi-admin channels delete 12 --yes
newapi-admin channels batch-delete --ids 3,4 --yes
```

加 `--dry-run` 可以只看请求不发送；加 `--json` 取原始响应。
