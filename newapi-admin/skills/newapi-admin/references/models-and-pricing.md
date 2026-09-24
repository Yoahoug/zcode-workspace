# 模型元数据与定价

这是最容易出错、也最需要说清楚的一块。「模型更新」和「定价」在本系统里是**两个独立的东西**：

| | 模型元数据 | 定价 |
| --- | --- | --- |
| 存什么 | 描述、图标、标签、供应商、端点、可见性 | 倍率、按次固定价、缓存倍率 |
| 表/键 | `models` 表 | `options` 表里的倍率映射 |
| 关联方式 | 按 `model_name` 字符串 | 按 `model_name` 字符串 |
| 接口前缀 | `/api/models/` | `/api/option/model_pricing` |
| 权限 | 管理员 | **Root** |

两者**只靠模型名字符串对齐**，没有外键。改了一个不会影响另一个。

---

# 第一部分：定价

## 四个量纲

| 量 | 单位 | 含义 |
| --- | --- | --- |
| `ModelRatio` | 倍率 | **1 倍率 = $0.002 / 1K tokens = $2 / 1M tokens** |
| `ModelPrice` | USD | **按次固定价**。一旦设置，该模型完全忽略所有倍率 |
| `CompletionRatio` | 倍率 | 输出 token 相对输入 token 的倍数 |
| `GroupRatio` | 倍率 | 分组系数，乘在整个请求上 |
| `quota` | 内部单位 | 最终计费量，1 USD = `QuotaPerUnit` 个 quota（默认 500000） |

换算：

```
ratio = USD_per_1M / 2          $2.5/1M → ratio 1.25
USD_per_1M = ratio × 2          ratio 1.25 → $2.5/1M
quota = USD × QuotaPerUnit
```

CLI 的 `pricing set --usd-per-1m 2.5` 和 `--ratio 1.25` 等价，`--price 0.04` 是设置按次固定价。

## 计费公式

文本请求（`service/text_quota.go`），按倍率计费时：

```
ratio = ModelRatio × GroupRatio

输入部分：
  baseTokens      = promptTokens - cacheTokens - createCacheTokens - imageTokens
  C  = cacheTokens       × CacheRatio
  W  = createCacheTokens × CreateCacheRatio
  I  = imageTokens       × ImageRatio
  promptQuota     = max(baseTokens, 0) + C + W + I

输出部分：
  completionQuota = completionTokens × CompletionRatio

quota = (promptQuota + completionQuota) × ratio
      + 音频输入额度            # Gemini 音频输入按 USD/1M 单独算
      + 工具调用附加费
```

按次固定价（该模型在 `ModelPrice` 里有条目）时：

```
quota = ModelPrice × QuotaPerUnit × GroupRatio
```

**`ModelPrice` 存在就完全绕过倍率**，`ModelRatio` 对该模型不再有任何作用。想让一个模型回到按倍率计费，必须把它的 `ModelPrice` 条目删掉（用 `reset: true` 或整表替换 `ModelPrice`）。

`pricing cost` 子命令在本地复现了上面这套公式，可以在改价前估算：

```bash
newapi-admin pricing cost --model gpt-4o --prompt-tokens 1000 --completion-tokens 500 --group vip
```

> 注意这是 CLI 自己的算术，不是服务端的。它**不覆盖** tiered 表达式计费（`billing_expr`）、工具调用附加费、以及各厂商特有的音频计价。用它做改动前的合理性检查，不要当账单。

## 分组系数

- `GroupRatio`：`{"default":1,"vip":0.9}`，按请求使用的分组取系数。
- `GroupGroupRatio`：`{"vip":{"edit_this":0.9}}`，外层是**用户所属分组**，内层是**实际使用的分组**。命中时**整体替换** `GroupRatio`，而不是相乘。

```bash
newapi-admin groups ratios          # 查看 GroupRatio 映射
```

## 改价的三种接口

### 1. 按模型改（推荐）：`PATCH /api/option/model_pricing`

带**乐观锁**，每次改动必须回传当前版本号，并发修改会失败而不是互相覆盖。

```bash
# 读
newapi-admin pricing get --model gpt-4o

# 写（CLI 自动完成「读版本 → 回传」）
newapi-admin pricing set --model gpt-4o --usd-per-1m 2.5 --completion-ratio 4
newapi-admin pricing set --model dall-e-3 --price 0.04          # 改为按次固定价
newapi-admin pricing set --model old-model --reset               # 恢复内置默认
```

请求体形状：

```json
{ "changes": [
  { "model_name": "gpt-4o", "expected_version": "<GET 得到的 version>", "pricing": { "ModelRatio": 1.25, "CompletionRatio": 4 } }
] }
```

- `expected_version` **必填**，缺失或过期返回 HTTP 409 / `MODEL_PRICING_CONFLICT`。
- 新模型用响应里的 `empty_version`。
- `pricing` 的键被限制在白名单内：`ModelRatio`、`ModelPrice`、`CompletionRatio`、`CacheRatio`、`CreateCacheRatio`、`ImageRatio`、`AudioRatio`、`AudioCompletionRatio`、`billing_setting.billing_mode`、`billing_setting.billing_expr`、`billing_setting.plugin_billing_expr`。传别的键报「unsupported pricing field」。
- 数值必须有限且 ≥ 0。
- 成功返回 `{"data":{"updated_models":["gpt-4o"]}}`。

**批量改价**用 `pricing bulk --file changes.json`，文件里是 `[{model_name, pricing}]` 数组；CLI 会先一次性读取所有相关模型的当前版本再提交，所以批量操作同样受并发保护。

### 2. 整表替换：`PUT /api/option/`

`{key, value}` 单键接口，`value` 必须是**字符串**（写 JSON 对象要传 JSON 字符串）。

```bash
# 先备份！
newapi-admin pricing options-get --key ModelRatio --json > modelratio.backup.json

# 整表替换
newapi-admin pricing model-ratio-map --file new-ratios.json
```

`new-ratios.json` 形如 `{"gpt-4o":1.25,"gpt-4o-mini":0.075}`。这个操作是**覆盖整个映射**，不在文件里的模型会失去自定义倍率。

也可以只读回来看：

```bash
newapi-admin pricing options-get --key ModelRatio
newapi-admin pricing options-get --key GroupRatio
```

`GET /api/option/` 会**省略所有名字以 `Token`/`Secret`/`Key`/`secret`/`api_key` 结尾的键**，所以密钥类配置读不到（不是权限问题，是有意屏蔽）。

### 3. 重置：`POST /api/option/rest_model_ratio`

```bash
newapi-admin pricing reset-model-ratio --yes     # 需 --yes，不可撤销
```

**只重置 `ModelRatio`**，覆盖为源码内置的默认倍率表。`ModelPrice`、`CompletionRatio`、`CacheRatio` 等**不受影响**。自定义倍率会全部丢失，执行前务必备份。

## 预览与转换

```bash
# 预览某组定价的生效值（写入前看效果，不落库）
newapi-admin pricing preview --model gpt-4o --ratio 1.5

# 把倍率定价渲染成 tiered 表达式（只读）
newapi-admin pricing convert --model gpt-4o --ratio 1.5
```

`convert` 对任务类/视频类模型会返回 `unsupported_reason`，因为这类模型走不同的计费路径。

## 从上游同步倍率

流程是「先取可同步源 → 抓取并比较 → 自己决定应用哪些」。**抓取接口只读，不落库**。

```bash
newapi-admin pricing sync-channels
# 输出里有两个内置预设：id -100「官方倍率预设」、id -101「models.dev 价格预设」

newapi-admin pricing sync-fetch --channel-ids 1,2
newapi-admin pricing sync-fetch --upstream https://basellm.github.io --endpoint /api/pricing
```

返回 `differences`（模型 → 字段 → `{current, upstreams, confidence}`）、`prices` 和 `test_results`。识别 4 种上游格式：OpenRouter `/v1/models`、models.dev `/api.json`、`/api/ratio_config` 映射、`/api/pricing` 列表。

**没有「一键应用」接口**——比较完由你决定，用 `pricing set` 或 `pricing options-set` 落地。

## 其他相关倍率键

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `CacheRatio` | 1.0 | 缓存命中输入 token 的倍率 |
| `CreateCacheRatio` | 1.25 | 缓存写入 token 的倍率（Claude 1 小时写缓存另有 ×1.6） |
| `ImageRatio` | 1.0 | 图像输入 token 倍率 |
| `AudioRatio` / `AudioCompletionRatio` | 1 | 音频输入/输出倍率 |
| `GroupRatio` / `GroupGroupRatio` | — | 分组系数，见上 |
| `QuotaPerUnit` | 500000 | 1 USD 对应多少 quota。改了会同时改变所有金额换算 |
| `billing_setting.billing_mode` | `ratio` | 按模型选计费引擎：`ratio` 或 `tiered_expr` |
| `billing_setting.billing_expr` | — | tiered 表达式，形如 `u("prompt_tokens") * 1.25 / 1000000` |
| `billing_setting.plugin_billing_expr` | — | 插件级覆盖，键是 `插件key::模型名` |

`billing_expr` 里的系数单位是 **$/1M tokens**，与 `ModelRatio` 的「倍率」不同。切到 `tiered_expr` 后上面那套倍率公式**不再适用**。

---

# 第二部分：模型元数据

元数据决定模型**在模型广场/定价页里长什么样、是否可见**，不决定价格。

## 字段表

`models` 表（`model/model_meta.go`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | |
| `model_name` | string | **唯一**（未删除记录之间），最长 128 |
| `description` | string | 描述 |
| `icon` | string | 图标名（`@lobehub/icons` 风格），最长 128 |
| `tags` | string | 标签，最长 255 |
| `vendor_id` | int | 供应商 id。`0` = 不关联；负数会被拒绝 |
| `endpoints` | string | **JSON 字符串**：端点对象映射或字符串数组 |
| `status` | int | `1` 在目录中可见，`0` 隐藏 |
| `sync_official` | int | `1` 允许官方元数据同步，`0` 锁定不参与同步 |
| `name_rule` | int | 匹配规则，见下 |
| `created_time` / `updated_time` | int64 | 秒 |
| 只读派生 | — | `has_metadata`、`bound_channels`、`enable_groups`、`supported_endpoints`、`quota_types`、`configured_channel_count`、`square_state`、`matched_models`、`matched_count` |

### `name_rule` 匹配规则

`0` exact（相等）、`1` prefix（前缀）、`2` contains（包含）、`3` suffix（后缀）。

非 exact 的规则让**一条元数据覆盖一批模型名**——例如 `model_name: "claude"` + `name_rule: 1` 会匹配所有 `claude*` 的模型。匹配优先级是 **exact → prefix → suffix → contains**，同类规则中第一条记录胜出。

`status != 1` 的元数据记录会被**从公开定价列表里完全剔除**，不只是标注隐藏。

## 列表与搜索

`GET /api/models/` 与 `GET /api/models/search` 参数相同：

| 参数 | 说明 |
| --- | --- |
| `p` / `page_size` | 分页，默认 10，上限 100 |
| `keyword` | 匹配 `model_name`、`description`、`tags` |
| `vendor` | 数字则按 `vendor_id` 匹配，否则按供应商**名称模糊**匹配 |
| `status` | `enabled`/`1`、`disabled`/`0`、`all`/`""` |
| `sync_official` | `yes`/`1`、`no`/`0`、`all`/`""` |
| `square_state` | `visible`/`unavailable`/`hidden`/`partial`，在内存里过滤后再分页 |
| `include_channel_models` | `true` 时额外把「渠道已配置但无元数据」的模型名合成进结果（这些合成行只有 `model_name` 和 `name_rule=0`） |

响应带 `vendor_counts`（`vendor_id` → 数量）。

## 创建与更新

```bash
newapi-admin models create --model-name gpt-4o --vendor-id 1 --tags vision --name-rule 0
newapi-admin models update 11 --description "旗舰模型" --tags "vision,audio"
newapi-admin models update 11 --status 0 --status-only      # 只改可见性
```

`POST /api/models/` 的 `model_name` 必填且不能重复。`PUT /api/models/` 必填 `id`；带 `?status_only=true` 时**只写 status**。

`Update` 实际持久化的列：`model_name`、`description`、`icon`、`tags`、`vendor_id`、`endpoints`、`status`、`sync_official`、`name_rule`、`updated_time`。

**这里没有版本号/乐观锁**——`models` 的更新是后写覆盖。三处乐观锁分别在定价、元数据同步、供应商运维，不包括元数据 CRUD。

`endpoints` 必须是合法 JSON 对象或数组；对象里的路径要以 `/` 开头，方法限制在 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS。

## 删除

```bash
newapi-admin models delete 11 --yes
newapi-admin models delete 11 --remove-from-channels --yes
newapi-admin models delete 11 --remove-pricing --yes
newapi-admin models batch-delete --model-ids 11,12 --yes
```

| 参数 | 作用 |
| --- | --- |
| `remove_from_channels` | 把该模型名从**所有渠道**的 `models` 字段里删掉并重建 abilities。**只对 exact 规则的记录有效**，非 exact 会报错 |
| `remove_pricing` | 从所有倍率映射里删掉该模型名。**需要 Root**，否则 HTTP 403 |

响应是 `{"deleted_count": n, "updated_channels": m}`。

删除会重新读取并比对记录集，如果期间有人改动会中止并提示重新加载。

## 缺失模型

```bash
newapi-admin models missing
```

「缺失」= 已启用渠道的 abilities 里有这个模型名，但 `models` 表里**没有对应记录**。返回纯字符串数组。这是排查「模型能用但广场里看不到」的入口。

## 上游官方元数据同步

**同步的是官方元数据目录**（描述、图标、标签、供应商、端点、`name_rule`、`status`），来源由环境变量 `SYNC_UPSTREAM_BASE` 指定，默认 `https://basellm.github.io/llm-metadata`。

它**不碰渠道模型列表**，也**不碰价格**。

### 三步流程

```bash
# 1. 预览（只读）
newapi-admin models sync-preview --locale zh --save preview.json

# 2. 查看候选（可加 --json）
#    kind = create | update | unchanged | missing_upstream | missing_vendor | blocked

# 3. 应用（CLI 自动回传 source_version 与每条 record_version）
newapi-admin models sync-apply --from-preview preview.json --kinds create,update
newapi-admin models sync-apply --from-preview preview.json --models gpt-4o,o3-mini
```

### 确认机制

`preview` 返回 `source.version`（上游目录的哈希）。`apply` 会**重新拉取上游并比对**，版本不一致就返回 **HTTP 409「Upstream metadata changed; preview again」**。每个候选项还有自己的 `record_version`，服务端逐条校验。

所以「先预览再应用」不是流程建议，是接口强制的：没有 `source_version` 直接 400，版本过期直接 409。

### 各 kind 的含义

| `kind` | 含义 | 能否选择 |
| --- | --- | --- |
| `create` | 本地没有、上游有 | 可以，`create: true` |
| `update` | 本地有且所选字段有差异 | 可以，`create: false` + `fields: [...]` |
| `unchanged` | 本地有且无差异 | 无意义 |
| `missing_upstream` | 本地有、上游没有 | **不能删除**，同步永不做删除 |
| `missing_vendor` | 上游引用的供应商本地和上游供应商源里都没有 | 不能 |
| `blocked` | 本地记录 `sync_official=0`，明确锁定 | 不能，会报「metadata sync is disabled for ...」 |

`update` 可选字段固定为 7 个：`description`、`icon`、`tags`、`vendor`、`endpoints`、`name_rule`、`status`。

`vendor` 字段指向的供应商如果本地不存在，会从上游供应商源**自动创建**，并在响应的 `created_vendors` 里列出。

响应：

```json
{ "created_models": ["o3-mini"],
  "updated_models": [{"model_name":"gpt-4o","record_version":"...","create":false,"fields":["tags"]}],
  "created_vendors": [] }
```

### 一个必须知道的后果

同步**不会给新模型设价格**。新发现的模型在倍率表里没有条目，于是：

- 若开了「自用模式」（`SelfUseModeEnabled`），走一个兜底倍率；
- 否则中继会直接拒绝，报「价格未配置」。

所以 `sync-apply` 之后要接着配价格：

```bash
newapi-admin pricing get --model o3-mini          # 确认有没有价格
newapi-admin pricing set --model o3-mini --usd-per-1m 4
```

---

## 一次完整的「模型更新 + 定价」操作

```bash
# 0. 先看现状
newapi-admin models missing                                  # 有模型没元数据吗
newapi-admin models list --limit 100

# 1. 同步官方元数据
newapi-admin models sync-preview --locale zh --save /tmp/preview.json
newapi-admin models sync-apply --from-preview /tmp/preview.json --kinds create,update

# 2. 备份现有倍率
newapi-admin pricing options-get --key ModelRatio --json > /tmp/modelratio.backup.json
newapi-admin pricing options-get --key ModelPrice  --json > /tmp/modelprice.backup.json

# 3. 参考上游倍率
newapi-admin pricing sync-channels
newapi-admin pricing sync-fetch --channel-ids 1

# 4. 逐个改价（带乐观锁）
newapi-admin pricing set --model gpt-4o --usd-per-1m 2.5 --completion-ratio 4
newapi-admin pricing set --model gpt-4o-mini --usd-per-1m 0.15

# 5. 验证
newapi-admin pricing get --model gpt-4o
newapi-admin pricing cost --model gpt-4o --prompt-tokens 1000 --completion-tokens 500
```

改价失败时常见的两种报错：

| 报错 | 原因 |
| --- | --- |
| `MODEL_PRICING_CONFLICT` / HTTP 409 | 版本号过期（别人刚改过）。重新 `pricing get` 再改 |
| `unsupported pricing field` | `pricing` 里出现了白名单外的键 |
| `无权进行此操作，权限不足` | 定价接口是 **Root only**，管理员令牌不够 |
