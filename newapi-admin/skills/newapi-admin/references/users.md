# 用户管理

## 角色与状态

**角色 `role`**（`common/constants.go`，只有这四个合法值）：

| 值 | 常量 | 说明 |
| --- | --- | --- |
| 0 | `RoleGuestUser` | 游客。未登录残留值，不要主动设置 |
| 1 | `RoleCommonUser` | 普通用户 |
| 10 | `RoleAdminUser` | 管理员 |
| 100 | `RoleRootUser` | Root，可做任何事 |

**操作目标用户的通用规则是「我的角色 > 目标角色」**。所以：

- 管理员（10）不能操作另一个管理员（10），也不能创建管理员。
- 只有 Root 能 `promote` 到管理员。
- Root 是例外，可以操作任何人（`DELETE /api/user/{id}` 用的是严格 `>`，但 Root 的 100 大于任何角色）。

**状态 `status`**：`1` 启用，`2` 禁用。**没有 3**。

删除有**两种，后果不同**：

| 方式 | 行为 |
| --- | --- |
| `DELETE /api/user/{id}` | **物理删除**，行从数据库消失，不可恢复 |
| `POST /api/user/manage` + `action: "delete"` | **软删除**，写 `deleted_at` |

软删除的用户在搜索时用 `status=-1` 才看得到（`status=-1` 的语义是「查已删除」）。

## 列表与搜索

两个接口能力**不一样**，容易用错：

| | `GET /api/user/` | `GET /api/user/search` |
| --- | --- | --- |
| 过滤 | **只有分页和排序** | `keyword`、`group`、`role`、`status` |
| 已删除用户 | 包含（用了 `Unscoped`） | 默认不含，`status=-1` 才含 |
| 排序字段 | `id`、`username`、`quota`、`group`、`created_at`、`last_login_at` | 同左 |
| 默认排序 | `id desc` | `id desc`；`sort_order` 只有 `asc` 被认，其他都是 `desc` |

**`GET /api/user/` 不支持 `group`/`status`/`role` 过滤**——传了会被忽略。CLI 的 `users list --group vip` 会自动改走 `/search`，但直接用 HTTP 时要自己选对接口。

`keyword` 匹配 `id`（精确）、`username`、`email`、`display_name`（模糊）。

```bash
newapi-admin users list --all
newapi-admin users search --group vip --role 1
newapi-admin users search --status -1            # 已删除用户
newapi-admin users search --keyword alice
```

## 创建用户

```bash
newapi-admin users create --username bob --password 'secret123' --display-name Bob --role 1
```

**只有这四个字段会生效**：`username`（必填、唯一、≤20）、`password`（必填、8–128）、`display_name`（空则等于 username）、`role`。

`email`、`quota`、`group` **会被静默丢弃**——不报错，但没生效。要设余额用 `users quota`，要设分组用 `users update`。

**响应不包含新用户的 id**，需要事后搜：

```bash
newapi-admin users search --keyword bob
```

`role` 必须小于调用者角色，否则报「无法创建更高级别的用户」。

## 更新用户

```bash
newapi-admin users update 2 --display-name Bobby --group vip --remark "内部账号"
newapi-admin users update 2 --password 'newsecret123'
```

`PUT /api/user/` **实际持久化的只有**：`username`、`display_name`、`group`、`remark`、`password`。

**`role`、`status`、`quota`、`email`、`used_quota`、`aff_*` 全部被静默忽略。** 这是最常见的「改了没反应」。

另外两个副作用要知道：

- **改 `group` 或 `password` 会踢掉该用户所有登录会话**（服务端会 bump auth 版本并撤销全部 session）。这是有意的安全行为。
- `role` 字段虽然不生效，但如果传了一个既非 0 又不同于当前值的 `role`，请求会**直接报错**。所以要么不传，要么传它当前的值。

改角色/状态/额度请用 `manage` 接口。

## 用户操作：`POST /api/user/manage`

一个接口多种动作：

```json
{ "id": 2, "action": "disable" }
```

| `action` | 效果 | 限制 |
| --- | --- | --- |
| `enable` | `status = 1` | 需要 `我的角色 > 目标角色` |
| `disable` | `status = 2` | 不能禁用 Root |
| `delete` | **软删除** | 不能删除 Root |
| `promote` | `role = 10`（管理员） | **仅 Root**；已是管理员会失败 |
| `demote` | `role = 1`（普通用户） | 不能降级 Root；已是普通用户会失败 |
| `add_quota` | 调整余额，见下 | Root 或 `我的角色 > 目标角色` |

响应 `data` 是 `{"role": 10, "status": 1}`。**`add_quota` 例外，不返回 `data`。**

```bash
newapi-admin users manage 2 --action disable
newapi-admin users manage 2 --action promote
newapi-admin users manage 2 --action delete      # 软删除
newapi-admin users delete 2 --yes                # 物理删除
```

## 余额调整

`action: "add_quota"` 配 `mode` 和 `value`：

| `mode` | 语义 | `value` 约束 |
| --- | --- | --- |
| `add` | 在现有余额上加 | **必须 > 0** |
| `subtract` | 从现有余额减 | **必须 > 0** |
| `override` | 设为绝对值 | 任意整数（含 0 和负数） |

`value` 的单位是 **quota，不是美元**。1 USD = `QuotaPerUnit` 个 quota（默认 500000，会被 Root 改）。

CLI 的 `--usd` 会按实例真实设置换算：

```bash
newapi-admin users quota 2 --usd 10                       # 加 $10
newapi-admin users quota 2 --mode subtract --usd 5        # 减 $5
newapi-admin users quota 2 --mode override --usd 100      # 设为 $100
newapi-admin users quota 2 --value 5000000                # 直接给 quota
```

余额上限 `MaxWalletQuota = 9007199254740991`（2^53-1），超过会被拒。

## 充值记录与补单

```bash
newapi-admin users topups --keyword USR2NO
newapi-admin users topup-complete --trade-no USR2NOabc123
```

`topup-complete` 用于人工补单：把 `pending` 的订单置为 `success` 并发放额度。

- 它以 `trade_no` 为准并加行锁，**幂等**——已经是 `success` 再调一次返回成功。
- 状态不是 `pending` 时报「订单状态不是待支付，无法补单」。
- 发放额度按支付方式不同：`stripe` 用 `money × QuotaPerUnit`，其他用 `amount × QuotaPerUnit`。

订单状态：`pending` / `success` / `failed` / `expired`。支付方：`epay`、`stripe`、`creem`、`waffo`、`waffo_pancake`、`balance`。

## 第三方绑定与安全凭证

```bash
newapi-admin users bindings 2                                   # 查看绑定
newapi-admin users unbind 2 --type github                       # 按类型清除
newapi-admin users unbind 2 --provider-id 123                   # 按自定义提供商清除
newapi-admin users reset-passkey 2 --yes                        # 重置用户 Passkey
newapi-admin users disable-2fa 2 --yes                          # 禁用用户两步验证
newapi-admin users 2fa-stats                                    # 2FA 使用统计
```

`--type` 的合法值：`email`、`github`、`discord`、`oidc`、`wechat`、`telegram`、`linuxdo`。

这几个是账号安全相关的破坏性操作，CLI 要求 `--yes`。

## 用户自助接口

用同一个令牌也能操作自己：

```bash
newapi-admin users me                     # 自己的信息 + 余额换算成 USD
newapi-admin users self                   # 原始字段
```

| 接口 | 说明 |
| --- | --- |
| `GET /api/user/self` | 自己的信息 |
| `PUT /api/user/self` | 改自己的资料 |
| `GET /api/user/token` | **生成系统访问令牌（PAT）** |
| `DELETE /api/user/token` | 撤销访问令牌 |
| `GET /api/user/aff` | 自己的邀请码 |
| `POST /api/user/aff_transfer` | 邀请额度转余额 |
| `DELETE /api/user/self` | 注销自己 |

`GET /api/user/token` 是**生成**令牌，不是读取。CLI 里对应 `api GET /api/user/token`（没有做类型化封装，避免误触发重新签发）。

## 管理员权限的细粒度授予

`GET /api/authz/catalog` 返回权限目录（资源、动作、角色基线）。渠道那 4 个权限（`channel:read`、`channel:operate`、`channel:write`、`channel:sensitive_write`）可以对单个用户覆盖。

关键点：**`channel:sensitive_write` 默认不授予任何角色，只有 Root 天然拥有**。所以一个刚提升的管理员无法新增或删除渠道。要授予，需要 Root 在权限管理里为该用户单独设置 `admin_permissions`（`GET /api/user/{id}` 会返回这个字段）。

## CLI 速查

```bash
newapi-admin users list --all
newapi-admin users search --group vip
newapi-admin users get 2
newapi-admin users create --username bob --password 'secret123'
newapi-admin users update 2 --group vip
newapi-admin users manage 2 --action disable
newapi-admin users quota 2 --usd 10
newapi-admin users topups
newapi-admin users topup-complete --trade-no X
newapi-admin users me
newapi-admin users delete 2 --yes        # 物理删除，先想清楚
```
