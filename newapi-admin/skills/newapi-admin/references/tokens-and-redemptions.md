# 令牌与兑换码

## 令牌管理：注意作用域

**令牌接口全部是「用户级」，不是管理员级。** 路由组用的是 `UserAuth`，每个处理器都按调用者自己的 `user_id` 过滤。**没有任何管理接口能查看或修改别人的令牌。**

用管理员令牌调 `/api/token/`，看到的是**管理员自己的**令牌，不是全站令牌。要排查某个用户的令牌，只能让该用户操作，或直接查数据库。

## 令牌字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | |
| `user_id` | int | 归属用户，只读 |
| `key` | string | 48 位字母数字，**存储时不带 `sk-` 前缀** |
| `name` | string | 名称，最长 50 |
| `status` | int | 1 启用、2 禁用、3 已过期、4 已耗尽 |
| `expired_time` | int64 | Unix 秒；**`-1` 表示永不过期** |
| `remain_quota` | int | 剩余额度，单位 quota |
| `unlimited_quota` | bool | `true` 时跳过额度检查 |
| `model_limits_enabled` | bool | 是否启用模型白名单 |
| `model_limits` | string | 逗号分隔的模型名 |
| `allow_ips` | string | 换行分隔的 IP 白名单 |
| `group` | string | 使用的分组，特殊值 `"auto"` |
| `cross_group_retry` | bool | 仅 `group: "auto"` 时有意义 |
| `auto_groups` | array | `group: "auto"` 时的候选分组，以 JSON 数组暴露 |
| `used_quota` / `created_time` / `accessed_time` | — | 只读，接口不会更新 |

### 密钥永远是掩码的

列表、搜索、详情返回的 `key` 都是**掩码**：≤4 位全星号；≤8 位显示首尾各 2 位；更长则首 4 位 + 10 个 `*` + 末 4 位。

**创建令牌时也不会返回密钥。** 要拿明文：

```bash
newapi-admin tokens key 21                # 单个
newapi-admin tokens keys --ids 21,22      # 批量，最多 100
```

对应 `POST /api/token/{id}/key` 和 `POST /api/token/batch/keys`。

### 两个 sentinel 与上限

- `expired_time = -1` 表示**永不过期**。注意兑换码用的是 `0`，两者不一样。
- `unlimited_quota = false` 时，`remain_quota` 必须在 `0` 到 `1_000_000_000 × QuotaPerUnit` 之间。
- 每用户令牌数量上限由服务端配置（`GetMaxUserTokens`），超了返回「已达到最大令牌数量限制 (N)」。

## 创建与更新

```bash
newapi-admin tokens create --name ci-token --usd 10 --model-limits gpt-4o,gpt-4o-mini --model-limits-enabled
newapi-admin tokens create --name forever --expired-time never --unlimited-quota
newapi-admin tokens create --name auto --group auto --auto-groups default,vip
newapi-admin tokens update 21 --remain-quota 1000000
newapi-admin tokens update 21 --status 2 --status-only
```

`--usd` 会按实例的 `QuotaPerUnit` 换算成 `remain_quota`。

更新白名单：`name`、`status`、`expired_time`、`remain_quota`、`unlimited_quota`、`model_limits_enabled`、`model_limits`、`allow_ips`、`group`、`cross_group_retry`、`auto_groups`。`used_quota`、`created_time`、`accessed_time`、`user_id` **永远不会被更新**。

启用时的两个守卫：

- 已过期（status 3 且 `expired_time <= now` 且不为 `-1`）不能直接启用 → 「令牌已过期，无法启用」
- 已耗尽（status 4 且 `remain_quota <= 0` 且非无限）不能直接启用 → 「令牌已耗尽，无法启用」

`cross_group_retry` 只在 `group == "auto"` 时生效；`group` 不是 `"auto"` 时服务端会强制置为 `false` 并清空 `auto_groups`。

## 列表与搜索

```bash
newapi-admin tokens list --all
newapi-admin tokens search --keyword ci
newapi-admin tokens search --token sk-xxxx        # 匹配密钥（会去掉 sk- 前缀再比）
```

搜索有速率限制（10 次/60 秒）。模糊搜索（含 `%`）要求至少 2 个非通配字符，且结果硬上限 100 条。令牌数量超过服务端上限的用户**只能精确搜索**。

## 用令牌密钥查用量

`GET /api/usage/token/` 用的是**令牌密钥本身**鉴权，不是面板令牌：

```
Authorization: Bearer <48位密钥或 sk- 开头的密钥>
```

```bash
newapi-admin tokens usage --key sk-xxxx
```

响应（注意这个接口用 `code` 而不是 `success`）：

```json
{ "code": true, "message": "ok", "data": {
    "object": "token_usage", "name": "ci",
    "total_granted": 6000000, "total_used": 1000000, "total_available": 5000000,
    "unlimited_quota": false, "model_limits": {"gpt-4o": true},
    "model_limits_enabled": true, "expires_at": 0 } }
```

`expires_at` 为 `0` 表示永不过期；否则是 Unix **秒**。

## 删除

```bash
newapi-admin tokens delete 21 --yes
newapi-admin tokens batch-delete --ids 21,22 --yes
```

`POST /api/token/batch` 是**批量删除**（不是批量创建），`ids` 不能为空，返回实际删除数量（只统计自己的令牌）。

---

# 兑换码

兑换码是**管理员级**接口（`AdminAuth`），与令牌相反。

## 字段

| 字段 | 说明 |
| --- | --- |
| `id` / `user_id` | 创建者 |
| `key` | 32 位十六进制（UUID 去横线） |
| `name` | 名称，1–20 个字符 |
| `status` | 1 未使用、2 已禁用、3 已使用 |
| `quota` | 面额，单位 quota |
| `created_time` / `redeemed_time` | Unix 秒 |
| `expired_time` | Unix 秒；**`0` 表示永不过期**（与令牌的 `-1` 相反） |
| `used_user_id` | 使用者 |
| `count` | **仅请求参数**，不落库、不返回 |

## 批量生成

```bash
newapi-admin redemptions create --name welcome --count 10 --usd 5
newapi-admin redemptions create --name promo --count 100 --quota 5000000 --expired-time 2025-12-31
```

请求体：`{ "name": "...", "count": 10, "quota": 5000000, "expired_time": 0 }`

| 字段 | 约束 |
| --- | --- |
| `name` | **必填**，1–20 个字符 |
| `count` | **必填**，1–100 |
| `quota` | **必填**，> 0 且 ≤ `MaxWalletQuota` |
| `expired_time` | 可选，`0` = 永不过期；否则必须 ≥ 当前时间 |

**前置条件**：支付合规声明必须已确认（`operation_setting.IsPaymentComplianceConfirmed()`），否则报「需要先确认支付合规」。确认方式：

```bash
newapi-admin options payment-compliance
```

**响应返回生成的码数组**（按创建顺序），这是唯一能拿到码的时机——之后列表里也有 `key`，但批量生成时直接拿到更省事。

中途插入失败会返回 `success: false`，但 `data` 里**是已经创建成功的码**，不要忽略。

## 查询

```bash
newapi-admin redemptions list --all
newapi-admin redemptions search --keyword welcome
newapi-admin redemptions search --status 3            # 已使用
newapi-admin redemptions search --status expired      # 已过期
```

`status` 的取值语义：

| 值 | 含义 |
| --- | --- |
| `1` | 未使用且未过期 |
| `2` | 已禁用 |
| `3` | 已使用 |
| `expired` | 未使用但 `expired_time != 0` 且已过期 |
| 其他 | 不过滤 |

`keyword` 匹配 `id`（精确）或 `name` 前缀。

## 更新与删除

```bash
newapi-admin redemptions update 31 --quota 10000000
newapi-admin redemptions update 31 --status 2 --status-only
newapi-admin redemptions delete 31 --yes
newapi-admin redemptions batch-delete --ids 31,32 --yes        # 最多 1000
newapi-admin redemptions delete-invalid --yes                  # 危险：一次清空已用+禁用+过期
```

`?status_only` 只写 `status`，不带则只写 `name`/`quota`/`expired_time`。

**`delete-invalid` 是最容易误伤的操作**：它删除所有 `status IN (3,2)` 加上所有已过期的未使用码。执行前先用 `redemptions search` 确认范围。

## 用户兑换

```bash
newapi-admin redemptions redeem --key 0f1e2d3c...
```

对应 `POST /api/user/topup`，请求体 `{"key": "<兑换码>"}`。这是**用户级**接口，会验证码的状态和过期时间并给当前用户加余额。

## CLI 速查

```bash
newapi-admin tokens list --all
newapi-admin tokens create --name ci --usd 10
newapi-admin tokens key 21
newapi-admin tokens usage --key sk-xxxx
newapi-admin tokens delete 21 --yes

newapi-admin redemptions create --name promo --count 20 --usd 5
newapi-admin redemptions list --all
newapi-admin redemptions search --status expired
newapi-admin redemptions redeem --key CODE
newapi-admin redemptions delete-invalid --yes     # 先确认范围
```
