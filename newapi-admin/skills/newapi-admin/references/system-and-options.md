# 系统选项、分组、供应商与运维

## 系统选项

系统选项存在 `options` 表的键值对里，**全部是 Root only**。定价相关的倍率表也在这里，已在 [models-and-pricing.md](models-and-pricing.md) 详述。

### 读取

```bash
newapi-admin options get                       # 全部键（值被截断显示）
newapi-admin options get --key ModelRatio      # 只看某个键
newapi-admin options get --key QuotaPerUnit --json
```

`GET /api/option/` 会**跳过所有名字以 `Token`、`Secret`、`Key`、`secret`、`api_key` 结尾的键**，并跳过 `theme.frontend`。这是有意的密钥屏蔽，读不到不是权限问题。

响应里还会额外合成 `billing_setting.billing_mode`、`billing_setting.billing_expr` 和 `CompletionRatioMeta`（含硬编码默认值的有效完成倍率）。

### 写入

```bash
newapi-admin options set --key QuotaPerUnit --value 500000
newapi-admin options set --key ModelRatio --value '{"gpt-4o":1.25}'
```

`PUT /api/option/` 的请求体是**单个** `{key, value}`，没有批量形式。`value` 必须传**字符串**——传嵌套对象会被 `%v` 转成不可用的文本。

规则与限制：

- `payment_setting.compliance_*` 开头的键被拒绝（合规确认字段不允许走通用接口）
- `theme.frontend` 只接受 `"default"`，其他值被拒
- 部分键有校验：`GroupRatio` 必须非负，`ImageRatio`、`CreateCacheRatio`、`AudioRatio`、`AudioCompletionRatio`、`billing_expr` 系列、`console_setting.*`、OAuth 开关等
- 倍率类键会被路由到带版本的定价引擎，不走通用路径

### 常用键速查

| 键 | 类型 | 含义 |
| --- | --- | --- |
| `QuotaPerUnit` | number | **1 USD = 多少 quota**，默认 500000 |
| `ModelRatio` / `ModelPrice` | JSON | 倍率 / 按次固定价映射 |
| `CompletionRatio` / `CacheRatio` / `CreateCacheRatio` / `ImageRatio` | JSON | 各类倍率 |
| `GroupRatio` / `GroupGroupRatio` | JSON | 分组系数 |
| `UserUsableGroups` | JSON | 用户可见分组 |
| `TopupGroupRatio` | JSON | 充值分组系数 |
| `QuotaForNewUser` / `QuotaForInviter` / `QuotaForInvitee` | int | 注册与邀请赠送额度（正值需先确认支付合规） |
| `SelfUseModeEnabled` | bool | 自用模式，未配置价格的模型走兜底倍率 |
| `DisplayInCurrencyEnabled` | bool | 以货币而非额度显示 |
| `ExposeRatioEnabled` | bool | 是否允许公开访问 `GET /api/ratio_config` |
| `Price` / `USDExchangeRate` / `MinTopUp` | mixed | 充值页价格与汇率 |
| `StripeUnitPrice` / `StripeMinTopUp` 等 | mixed | 各支付通道单价与最低充值 |
| `billing_setting.billing_mode` / `.billing_expr` | JSON | 按模型的计费引擎选择 |

改 `QuotaPerUnit` 会**同时改变全站所有金额换算**，包括你自己脚本里的换算，改前务必确认。

## 请求策略

请求策略控制重试、自动禁用、敏感词、渠道亲和等运行时行为。**值都是字符串。**

```bash
newapi-admin options request-policy-get
newapi-admin options request-policy-set --set RetryTimes=3 --set AutomaticDisableChannelEnabled=true
```

允许的键（白名单）：任何 `channel_affinity_setting.*`、`monitor_setting.*`，以及：

`CheckSensitiveEnabled`、`CheckSensitiveOnPromptEnabled`、`SensitiveWords`、`AutomaticEnableChannelEnabled`、`ChannelDisableThreshold`、`monitor_setting.auto_test_channel_enabled`、`monitor_setting.auto_test_channel_minutes`、`monitor_setting.channel_test_concurrency`、`monitor_setting.channel_test_mode`、`RetryTimes`、`AutomaticRetryStatusCodes`、`AutomaticDisableChannelEnabled`、`AutomaticDisableStatusCodes`、`AutomaticDisableKeywords`。

白名单外的键会被 PATCH 忽略。

调这几个键的典型场景：

- 渠道被误自动禁用 → `AutomaticDisableChannelEnabled=false`
- 上游 429 太多想重试 → `RetryTimes=3`、`AutomaticRetryStatusCodes=429,500`
- 自动测试渠道 → `monitor_setting.auto_test_channel_enabled=true` 加 `channel_test_minutes`

## 分组

```bash
newapi-admin groups list          # 全部组名（纯数组，无序）
newapi-admin groups ratios        # GroupRatio 映射（CLI 读 option 得到，带系数）
```

注意两者的差别：

- `GET /api/group/`（管理员）返回**纯组名数组**，是 map 键的乱序转储，**不含倍率**。
- `GET /api/user/groups`（用户级）返回 `{"组名": {"ratio": 1, "desc": "..."}}`，只含该用户**可用**的分组，`auto` 分组的 ratio 是字符串 `"自动"`。

所以要看分组的实际倍率，用 `groups ratios` 或 `options get --key GroupRatio`。

新增分组的方式是**在 `GroupRatio` 里加键**，没有独立的建组接口。用户归属分组通过 `users update --group`。

## 预填分组

预填分组是管理表单的默认值集合，按 `type` 归类（约定用 `model`、`tag`、`endpoint`）。

```bash
newapi-admin prefill list
newapi-admin prefill list --type model
newapi-admin prefill create --name "GPT-4 系列" --type model --items '["gpt-4o","gpt-4-turbo"]' --description "旗舰"
newapi-admin prefill update 41 --name "GPT-4 系列" --type model --items '["gpt-4o"]'
newapi-admin prefill delete 41 --yes
```

**`update` 是整条记录覆盖**（服务端用 `Save`），省略的字段会被写成零值。所以每次更新都要把 `--name`、`--type`、`--items` 都带上。CLI 会在缺 `--name`/`--type` 时直接报错提醒。

`GET /api/prefill_group/` 返回**数组**，不套分页。

## 供应商

供应商是模型元数据的分组维度，只影响展示，**不影响计费**。

```bash
newapi-admin vendors list --association linked        # 有模型关联的
newapi-admin vendors list --association unlinked      # 没有模型关联的
newapi-admin vendors create --name "OpenAI" --description "First party" --icon OpenAI
newapi-admin vendors update 1 --description "官方"
newapi-admin vendors get 1
newapi-admin vendors delete 1 --yes
```

`status` 在创建和更新时都被强制为 `1`，不可通过接口设置。`version` 是记录的 SHA-256 哈希，可作乐观锁：`update` 时传不一致的 `version` 会返回 HTTP 409 / `VENDOR_CONFLICT`。

删除被模型引用的供应商会返回 **HTTP 409 / `VENDOR_REFERENCED`**，并带上各供应商的引用数量。要删就先改派模型。

### 批量运维：两阶段 + 乐观锁

`assign`（改派）、`merge`（合并）、`delete`（批量删除）统一走「预览 → 应用」：

```bash
newapi-admin vendors assign --model-ids 11,12 --target-vendor-id 3    # 改派（target 传 0 = 清空）
newapi-admin vendors merge --vendor-ids 3,4 --target-vendor-id 1      # 合并到 1，然后删掉 3、4
newapi-admin vendors delete-many --vendor-ids 3,4 --yes
```

CLI 自动完成两阶段：先 `POST /api/vendors/operations/preview` 拿 `version`，再带 `expected_version` 调 `POST /api/vendors/operations`。**应用时缺 `expected_version` 会被拒（409）**——这是防止并发覆盖的确认机制。

约束：

- `assign` 用 `model_ids`（1–1000 个，去重，均 > 0），`target_vendor_id` 可为 0（清空关联）
- `merge`/`delete` 用 `vendor_ids`；`merge` 的目标不能同时出现在 `vendor_ids` 里，且目标不能为 0
- `delete` 时若有模型仍引用该供应商，预览就会失败
- 应用成功后返回 `{"updated_models":[...], "deleted_vendors":[...]}`

这些是破坏性操作，CLI 要求 `--yes`。

## 系统任务

```bash
newapi-admin system tasks                       # 任务列表
newapi-admin system current                     # 当前运行中的任务
newapi-admin system current --type channel_test
newapi-admin system task st1                    # 指定任务详情
newapi-admin system task-history-delete --yes   # 清空任务历史
```

系统任务由异步操作产生：全渠道测试（`GET /api/channel/test`）、日志清理（`logs cleanup`）等。**全渠道测试是异步的**，只会返回 `task_id`；要看结果得回来查任务。

## 多节点实例

```bash
newapi-admin system instances
newapi-admin system stale-instances-delete --yes
newapi-admin system instance-delete node-1 --yes
```

多节点部署时列出各节点及最后心跳时间。清理失效实例用于节点下线后回收。

## 性能与缓存

```bash
newapi-admin system perf                # goroutine 数、内存等
newapi-admin system log-files           # 日志文件列表
newapi-admin system gc                  # 触发 GC
newapi-admin system cache-clear --yes   # 清磁盘缓存
newapi-admin system log-files-clean --yes
newapi-admin options affinity-cache            # 渠道亲和缓存统计
newapi-admin options affinity-cache-clear --yes
```

渠道亲和缓存用于把同一会话固定到同一渠道。清空会让后续请求重新分配渠道。

## 权限目录

```bash
newapi-admin system permissions
```

`GET /api/authz/catalog` 返回权限资源、动作和角色基线，是「某个管理员到底能做什么」的权威来源。渠道的 `channel:sensitive_write` 默认不对任何角色授予，只在这里能看清。

## CLI 速查

```bash
newapi-admin options get --key QuotaPerUnit
newapi-admin options set --key RetryTimes --value 3
newapi-admin options request-policy-get
newapi-admin options request-policy-set --set AutomaticDisableChannelEnabled=false
newapi-admin options payment-compliance
newapi-admin groups list
newapi-admin groups ratios
newapi-admin prefill list --type model
newapi-admin vendors assign --model-ids 11 --target-vendor-id 3 --yes
newapi-admin system tasks
newapi-admin system perf
newapi-admin system permissions
```
