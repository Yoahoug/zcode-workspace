// The complete New API management route inventory, as data.
//
// Source of truth: router/api-router.go, router/channel-router.go, router/authz-router.go,
// router/dashboard.go in QuantumNous/new-api (main), cross-checked against the published
// OpenAPI document (docs/openapi/api.json, 161 documented operations). The router is
// authoritative: it mounts 295 routes, and the OpenAPI document covers only the subset
// the docs site renders.
//
// `auth` is the middleware tier that guards the route:
//   public  - no authentication
//   user    - any logged-in user or access token (UserAuth)
//   admin   - role >= 10 (AdminAuth), the baseline for everything above
//   root    - role >= 100 (RootAuth)
// `perm` is the finer-grained authz permission checked on top of `admin` for channel
// routes. Permissions are grantable per user, so an admin without `channel:sensitive_write`
// cannot add, update-sensitively, or delete channels even though the route is admin-tier.
//
// `destructive: true` marks routes that delete or overwrite data; the CLI refuses them
// without --yes.

export const GROUPS = [
  {
    group: "系统状态",
    id: "system",
    routes: [
      { method: "GET", path: "/api/setup", auth: "public", purpose: "初始化状态（是否已创建 root、数据库类型）" },
      { method: "POST", path: "/api/setup", auth: "public", purpose: "初始化系统并创建 root 账号（仅在未初始化时可用）", destructive: true },
      { method: "GET", path: "/api/status", auth: "public", purpose: "公开系统状态：版本、启动时间、QuotaPerUnit、汇率、主题与功能开关" },
      { method: "GET", path: "/api/status/test", auth: "admin", purpose: "测试系统状态：数据库连通性、HTTP 统计" },
      { method: "GET", path: "/api/uptime/status", auth: "public", purpose: "Uptime Kuma 状态" },
      { method: "GET", path: "/api/notice", auth: "public", purpose: "公告内容" },
      { method: "GET", path: "/api/about", auth: "public", purpose: "关于信息" },
      { method: "GET", path: "/api/home_page_content", auth: "public", purpose: "首页内容" },
      { method: "GET", path: "/api/user-agreement", auth: "public", purpose: "用户协议" },
      { method: "GET", path: "/api/privacy-policy", auth: "public", purpose: "隐私政策" },
      { method: "GET", path: "/api/models", auth: "user", purpose: "看板可用模型列表（用户视角，注意与 /api/models/ 不同）" },
      { method: "GET", path: "/api/pricing", auth: "public", purpose: "公开定价信息（受模块开关控制）" },
      { method: "GET", path: "/api/ratio_config", auth: "public", purpose: "公开倍率配置；仅在 ExposeRatioEnabled 打开时可用，否则拒绝" },
      { method: "GET", path: "/api/perf-metrics", auth: "public", purpose: "性能指标列表" },
      { method: "GET", path: "/api/perf-metrics/summary", auth: "public", purpose: "性能指标汇总" },
      { method: "GET", path: "/api/rankings", auth: "public", purpose: "排行榜" },
    ],
  },
  {
    group: "认证与登录",
    id: "auth",
    routes: [
      { method: "POST", path: "/api/user/login", auth: "public", purpose: "用户登录，返回会话（Session 方式）与 JWT" },
      { method: "POST", path: "/api/user/login/2fa", auth: "public", purpose: "两步验证登录" },
      { method: "POST", path: "/api/user/login/verify", auth: "public", purpose: "登录二次校验" },
      { method: "GET", path: "/api/user/login/encryption-key", auth: "public", purpose: "获取密码传输加密公钥" },
      { method: "POST", path: "/api/user/register", auth: "public", purpose: "用户注册" },
      { method: "POST", path: "/api/user/reset", auth: "public", purpose: "通过邮件令牌重置密码", destructive: true },
      { method: "GET", path: "/api/verification", auth: "public", purpose: "发送邮箱验证码" },
      { method: "GET", path: "/api/reset_password", auth: "public", purpose: "发送密码重置邮件" },
      { method: "POST", path: "/api/user/auth/refresh", auth: "public", purpose: "刷新面板登录会话（使用 refresh cookie）" },
      { method: "POST", path: "/api/user/auth/logout", auth: "public", purpose: "撤销当前登录会话" },
      { method: "GET", path: "/api/user/sessions", auth: "user", purpose: "查看自己的登录会话列表" },
      { method: "DELETE", path: "/api/user/sessions/{sid}", auth: "user", purpose: "撤销指定登录会话", destructive: true },
      { method: "POST", path: "/api/user/sessions/revoke-others", auth: "user", purpose: "撤销除当前以外的所有会话", destructive: true },
      { method: "POST", path: "/api/user/login/passkey/begin", auth: "public", purpose: "Passkey 登录开始" },
      { method: "POST", path: "/api/user/login/passkey/finish", auth: "public", purpose: "Passkey 登录完成" },
      { method: "POST", path: "/api/user/passkey/login/begin", auth: "public", purpose: "Passkey 登录开始（旧路径）" },
      { method: "POST", path: "/api/user/passkey/login/finish", auth: "public", purpose: "Passkey 登录完成（旧路径）" },
      { method: "GET", path: "/api/user/groups", auth: "user", purpose: "当前用户可用分组及倍率" },
      { method: "POST", path: "/api/oauth/state", auth: "public", purpose: "生成 OAuth State" },
      { method: "GET", path: "/api/oauth/{provider}", auth: "public", purpose: "OAuth 登录（github/discord/oidc/linuxdo/telegram）" },
      { method: "POST", path: "/api/oauth/email/bind/start", auth: "user", purpose: "绑定邮箱：发送验证码" },
      { method: "POST", path: "/api/oauth/email/bind/resend", auth: "user", purpose: "绑定邮箱：重发验证码" },
      { method: "POST", path: "/api/oauth/email/bind", auth: "user", purpose: "绑定邮箱：提交验证码" },
      { method: "GET", path: "/api/oauth/wechat", auth: "public", purpose: "微信 OAuth 登录" },
      { method: "POST", path: "/api/oauth/wechat/bind", auth: "user", purpose: "绑定微信" },
      { method: "GET", path: "/api/oauth/telegram/login", auth: "public", purpose: "Telegram 登录" },
      { method: "POST", path: "/api/oauth/telegram/bind/start", auth: "user", purpose: "创建 Telegram 绑定流程" },
      { method: "GET", path: "/api/oauth/telegram/bind/{flow_token}", auth: "user", purpose: "完成 Telegram 绑定" },
    ],
  },
  {
    group: "用户管理",
    id: "users",
    routes: [
      { method: "GET", path: "/api/user/self", auth: "user", purpose: "当前用户信息与余额" },
      { method: "PUT", path: "/api/user/self", auth: "user", purpose: "更新自己的资料（含密码）" },
      { method: "DELETE", path: "/api/user/self", auth: "user", purpose: "注销当前用户", destructive: true },
      { method: "GET", path: "/api/user/self/groups", auth: "user", purpose: "当前用户分组" },
      { method: "GET", path: "/api/user/models", auth: "user", purpose: "当前用户可用模型" },
      { method: "GET", path: "/api/user/token", auth: "user", purpose: "生成系统访问令牌（PAT）" },
      { method: "GET", path: "/api/user/token/status", auth: "user", purpose: "查询访问令牌状态" },
      { method: "POST", path: "/api/user/token", auth: "user", purpose: "生成系统访问令牌（POST 形式）" },
      { method: "DELETE", path: "/api/user/token", auth: "user", purpose: "撤销系统访问令牌", destructive: true },
      { method: "PUT", path: "/api/user/setting", auth: "user", purpose: "更新用户设置（通知等）" },
      { method: "GET", path: "/api/user/aff", auth: "user", purpose: "获取邀请码" },
      { method: "POST", path: "/api/user/aff_transfer", auth: "user", purpose: "邀请额度转换为余额" },
      { method: "GET", path: "/api/user/passkey", auth: "user", purpose: "Passkey 状态" },
      { method: "DELETE", path: "/api/user/passkey", auth: "user", purpose: "删除自己的 Passkey", destructive: true },
      { method: "POST", path: "/api/user/passkey/register/begin", auth: "user", purpose: "注册 Passkey 开始" },
      { method: "POST", path: "/api/user/passkey/register/finish", auth: "user", purpose: "注册 Passkey 完成" },
      { method: "POST", path: "/api/user/passkey/verify/begin", auth: "user", purpose: "验证 Passkey 开始" },
      { method: "POST", path: "/api/user/passkey/verify/finish", auth: "user", purpose: "验证 Passkey 完成" },
      { method: "GET", path: "/api/user/", auth: "admin", purpose: "用户列表（分页；注意：不支持 group/status 过滤）" },
      { method: "GET", path: "/api/user/search", auth: "admin", purpose: "搜索用户（keyword/group/role/status），支持 status=-1 查已删除" },
      { method: "GET", path: "/api/user/{id}", auth: "admin", purpose: "用户详情（含 admin_permissions）" },
      { method: "POST", path: "/api/user/", auth: "admin", purpose: "创建用户（仅 username/password/display_name/role 生效）" },
      { method: "PUT", path: "/api/user/", auth: "admin", purpose: "更新用户（仅 username/display_name/group/remark/password 生效）" },
      { method: "POST", path: "/api/user/manage", auth: "admin", purpose: "用户操作：enable/disable/delete/promote/demote/add_quota", destructive: true },
      { method: "DELETE", path: "/api/user/{id}", auth: "admin", purpose: "物理删除用户（不可恢复）", destructive: true },
      { method: "DELETE", path: "/api/user/{id}/reset_passkey", auth: "admin", purpose: "重置用户 Passkey", destructive: true },
      { method: "DELETE", path: "/api/user/{id}/2fa", auth: "admin", purpose: "管理员禁用用户两步验证", destructive: true },
      { method: "GET", path: "/api/user/2fa/stats", auth: "admin", purpose: "两步验证使用统计" },
      { method: "GET", path: "/api/user/{id}/oauth/bindings", auth: "admin", purpose: "查看用户第三方绑定" },
      { method: "DELETE", path: "/api/user/{id}/oauth/bindings/{provider_id}", auth: "admin", purpose: "解绑用户第三方账号", destructive: true },
      { method: "DELETE", path: "/api/user/{id}/bindings/{binding_type}", auth: "admin", purpose: "清除用户某类绑定（email/github/discord/oidc/wechat/telegram/linuxdo）", destructive: true },
      { method: "GET", path: "/api/user/topup", auth: "admin", purpose: "全部充值记录" },
      { method: "POST", path: "/api/user/topup/complete", auth: "admin", purpose: "人工补单：将 pending 订单置为成功并发放额度" },
      { method: "GET", path: "/api/user/topup/info", auth: "user", purpose: "充值页信息（支付方式、单价、最低充值）" },
      { method: "GET", path: "/api/user/topup/self", auth: "user", purpose: "自己的充值记录（限 30 天）" },
    ],
  },
  {
    group: "两步验证与安全验证",
    id: "security",
    routes: [
      { method: "GET", path: "/api/user/2fa/status", auth: "user", purpose: "自己的 2FA 状态" },
      { method: "POST", path: "/api/user/2fa/setup", auth: "user", purpose: "生成 2FA 密钥与二维码" },
      { method: "POST", path: "/api/user/2fa/enable", auth: "user", purpose: "启用 2FA" },
      { method: "POST", path: "/api/user/2fa/disable", auth: "user", purpose: "禁用 2FA" },
      { method: "POST", path: "/api/user/2fa/backup_codes", auth: "user", purpose: "重新生成备用码" },
      { method: "GET", path: "/api/verify/methods", auth: "user", purpose: "可用的安全验证方式" },
      { method: "POST", path: "/api/verify", auth: "user", purpose: "通用安全验证，换取 X-Security-Proof" },
    ],
  },
  {
    group: "渠道管理",
    id: "channels",
    routes: [
      { method: "GET", path: "/api/channel/", auth: "admin", perm: "channel:read", purpose: "渠道列表（p/page_size/group/status/type/sort_by/tag_mode）；返回的 key 恒为空串" },
      { method: "GET", path: "/api/channel/search", auth: "admin", perm: "channel:read", purpose: "搜索渠道（keyword/model/group/status/type），默认 page_size 为 20" },
      { method: "GET", path: "/api/channel/{id}", auth: "admin", perm: "channel:read", purpose: "渠道详情（key 为空串）" },
      { method: "GET", path: "/api/channel/models", auth: "admin", perm: "channel:read", purpose: "内置模型目录（静态表，非本实例配置）" },
      { method: "GET", path: "/api/channel/models_enabled", auth: "admin", perm: "channel:read", purpose: "本实例已启用的模型名列表（来自 abilities 表）" },
      { method: "GET", path: "/api/channel/default_base_urls", auth: "admin", perm: "channel:read", purpose: "各渠道类型的默认 base_url" },
      { method: "GET", path: "/api/channel/ops", auth: "admin", perm: "channel:read", purpose: "渠道运维信息（含自动封禁状态）" },
      { method: "GET", path: "/api/channel/tag/models", auth: "admin", perm: "channel:read", purpose: "标签下模型并集（取模型最多的渠道）" },
      { method: "GET", path: "/api/channel/{id}/vllm/status", auth: "admin", perm: "channel:read", purpose: "vLLM 渠道状态" },
      { method: "GET", path: "/api/channel/{id}/sglang/status", auth: "admin", perm: "channel:read", purpose: "SGLang 渠道状态" },
      { method: "GET", path: "/api/channel/{id}/codex/usage", auth: "admin", perm: "channel:read", purpose: "Codex 渠道用量" },
      { method: "GET", path: "/api/channel/{id}/codex/usage/reset-credits", auth: "admin", perm: "channel:read", purpose: "Codex 重置积分信息" },
      { method: "POST", path: "/api/channel/", auth: "admin", perm: "channel:sensitive_write", purpose: "添加渠道（mode=single|batch|multi_to_single）" },
      { method: "PUT", path: "/api/channel/", auth: "admin", perm: "channel:write", purpose: "更新渠道（扁平 Channel 对象；不得携带 status）" },
      { method: "PUT", path: "/api/channel/tag", auth: "admin", perm: "channel:write", purpose: "按标签批量编辑渠道（注意此处字段名是 groups 复数）" },
      { method: "POST", path: "/api/channel/batch/tag", auth: "admin", perm: "channel:write", purpose: "按 id 批量设置标签" },
      { method: "POST", path: "/api/channel/upstream_updates/apply", auth: "admin", perm: "channel:write", purpose: "应用单个渠道的上游模型更新" },
      { method: "POST", path: "/api/channel/upstream_updates/apply_all", auth: "admin", perm: "channel:write", purpose: "应用全部渠道的上游模型更新" },
      { method: "POST", path: "/api/channel/status/batch", auth: "admin", perm: "channel:operate", purpose: "批量启用/禁用渠道（status 只接受 1 或 2）" },
      { method: "POST", path: "/api/channel/{id}/status", auth: "admin", perm: "channel:operate", purpose: "启用/禁用单个渠道（status 只接受 1 或 2）" },
      { method: "GET", path: "/api/channel/test", auth: "admin", perm: "channel:operate", purpose: "发起全渠道测试任务（异步，返回 task_id；已有任务时返回 409）" },
      { method: "GET", path: "/api/channel/test/{id}", auth: "admin", perm: "channel:operate", purpose: "测试指定渠道，返回耗时秒数" },
      { method: "GET", path: "/api/channel/update_balance", auth: "admin", perm: "channel:operate", purpose: "更新所有渠道余额（同步逐个查询，无明细返回）" },
      { method: "GET", path: "/api/channel/update_balance/{id}", auth: "admin", perm: "channel:operate", purpose: "更新指定渠道余额（balance 不在 data 里，在顶层）" },
      { method: "GET", path: "/api/channel/fetch_models/{id}", auth: "admin", perm: "channel:operate", purpose: "拉取已保存渠道的上游模型列表" },
      { method: "POST", path: "/api/channel/fetch_models", auth: "admin", perm: "channel:sensitive_write", purpose: "用未保存的 key/base_url 试探上游模型列表" },
      { method: "POST", path: "/api/channel/fix", auth: "admin", perm: "channel:operate", purpose: "重建 abilities 表（修复渠道-模型能力缓存）" },
      { method: "POST", path: "/api/channel/tag/enabled", auth: "admin", perm: "channel:operate", purpose: "按标签批量启用渠道" },
      { method: "POST", path: "/api/channel/tag/disabled", auth: "admin", perm: "channel:operate", purpose: "按标签批量禁用渠道" },
      { method: "POST", path: "/api/channel/multi_key/manage", auth: "admin", perm: "channel:operate", purpose: "多密钥管理：查询/启用/禁用/删除密钥", destructive: true },
      { method: "POST", path: "/api/channel/{id}/codex/usage/reset", auth: "admin", perm: "channel:operate", purpose: "重置 Codex 渠道用量" },
      { method: "POST", path: "/api/channel/upstream_updates/detect", auth: "admin", perm: "channel:operate", purpose: "检测单个渠道的上游模型变化" },
      { method: "POST", path: "/api/channel/upstream_updates/detect_all", auth: "admin", perm: "channel:operate", purpose: "检测全部渠道的上游模型变化" },
      { method: "POST", path: "/api/channel/{id}/key", auth: "root", purpose: "读取渠道明文密钥；还需 X-Security-Proof 请求头" },
      { method: "POST", path: "/api/channel/copy/{id}", auth: "admin", perm: "channel:sensitive_write", purpose: "复制渠道（suffix/reset_balance）" },
      { method: "POST", path: "/api/channel/batch", auth: "admin", perm: "channel:sensitive_write", purpose: "批量删除渠道", destructive: true },
      { method: "DELETE", path: "/api/channel/{id}", auth: "admin", perm: "channel:sensitive_write", purpose: "删除渠道", destructive: true },
      { method: "DELETE", path: "/api/channel/disabled", auth: "admin", perm: "channel:sensitive_write", purpose: "删除所有已禁用渠道（status 2/3）", destructive: true },
      { method: "POST", path: "/api/channel/{id}/codex/refresh", auth: "admin", perm: "channel:sensitive_write", purpose: "刷新 Codex 渠道凭据" },
      { method: "POST", path: "/api/channel/ollama/pull", auth: "admin", perm: "channel:sensitive_write", purpose: "Ollama 拉取模型" },
      { method: "POST", path: "/api/channel/ollama/pull/stream", auth: "admin", perm: "channel:sensitive_write", purpose: "Ollama 拉取模型（流式）" },
      { method: "DELETE", path: "/api/channel/ollama/delete", auth: "admin", perm: "channel:sensitive_write", purpose: "Ollama 删除模型", destructive: true },
      { method: "GET", path: "/api/channel/ollama/version/{id}", auth: "admin", perm: "channel:sensitive_write", purpose: "Ollama 版本" },
    ],
  },
  {
    group: "模型元数据",
    id: "models",
    routes: [
      { method: "GET", path: "/api/models/", auth: "admin", purpose: "模型元数据列表（keyword/vendor/status/sync_official/square_state/include_channel_models）" },
      { method: "GET", path: "/api/models/search", auth: "admin", purpose: "搜索模型元数据（同列表参数）" },
      { method: "GET", path: "/api/models/{id}", auth: "admin", purpose: "模型元数据详情" },
      { method: "POST", path: "/api/models/", auth: "admin", purpose: "创建模型元数据" },
      { method: "PUT", path: "/api/models/", auth: "admin", purpose: "更新模型元数据（需 id；?status_only 只改状态）" },
      { method: "GET", path: "/api/models/missing", auth: "admin", purpose: "已启用但缺少元数据的模型名列表" },
      { method: "GET", path: "/api/models/sync_upstream/preview", auth: "admin", purpose: "预览官方元数据同步（?locale=zh|en|ja），返回候选与 source_version" },
      { method: "POST", path: "/api/models/sync_upstream", auth: "admin", purpose: "应用元数据同步；必须回传 source_version 与每个候选项的 record_version" },
      { method: "DELETE", path: "/api/models/{id}", auth: "admin", purpose: "删除模型元数据（remove_from_channels/remove_pricing 可选）", destructive: true },
      { method: "POST", path: "/api/models/delete", auth: "admin", purpose: "批量删除模型元数据", destructive: true },
    ],
  },
  {
    group: "定价与倍率",
    id: "pricing",
    routes: [
      { method: "GET", path: "/api/option/", auth: "root", purpose: "读取系统选项（敏感键被省略；含 ModelRatio/ModelPrice 等全部倍率表）" },
      { method: "PUT", path: "/api/option/", auth: "root", purpose: "更新单个系统选项 {key,value}；value 为字符串，写 JSON 对象需传 JSON 字符串" },
      { method: "GET", path: "/api/option/model_pricing", auth: "root", purpose: "按模型读取定价快照（configured/effective/version），?model= 可重复" },
      { method: "PATCH", path: "/api/option/model_pricing", auth: "root", purpose: "按模型改写定价（changes[]，每项必须带 expected_version 做乐观锁）" },
      { method: "POST", path: "/api/option/model_pricing/preview", auth: "root", purpose: "预览某模型定价的生效值，不写入" },
      { method: "POST", path: "/api/option/model_pricing/convert", auth: "root", purpose: "把倍率定价转换为 tiered_expr 表达式，不写入" },
      { method: "POST", path: "/api/option/rest_model_ratio", auth: "root", purpose: "把 ModelRatio 整体重置为内置默认值（只影响 ModelRatio）", destructive: true },
      { method: "GET", path: "/api/ratio_sync/channels", auth: "root", purpose: "可用于同步倍率的渠道列表（含两个内置预设 id=-100/-101）" },
      { method: "POST", path: "/api/ratio_sync/fetch", auth: "root", purpose: "抓取上游倍率并与本地比较（只读，不落库）" },
    ],
  },
  {
    group: "系统选项与策略",
    id: "options",
    routes: [
      { method: "GET", path: "/api/option/request_policy", auth: "root", purpose: "读取请求策略（重试、自动禁用、敏感词、渠道亲和等）" },
      { method: "PATCH", path: "/api/option/request_policy", auth: "root", purpose: "更新请求策略（值均为字符串）" },
      { method: "PUT", path: "/api/option/passkey/domains", auth: "root", purpose: "更新 Passkey 允许域名" },
      { method: "POST", path: "/api/option/payment_compliance", auth: "root", purpose: "确认支付合规声明（创建兑换码等操作的前置条件）" },
      { method: "GET", path: "/api/option/channel_affinity_cache", auth: "root", purpose: "渠道亲和缓存统计" },
      { method: "DELETE", path: "/api/option/channel_affinity_cache", auth: "root", purpose: "清空渠道亲和缓存", destructive: true },
      { method: "GET", path: "/api/option/waffo-pancake/catalog", auth: "root", purpose: "Waffo Pancake 商品目录" },
      { method: "POST", path: "/api/option/waffo-pancake/pair", auth: "root", purpose: "Waffo Pancake 配对" },
      { method: "POST", path: "/api/option/waffo-pancake/save", auth: "root", purpose: "保存 Waffo Pancake 配置" },
      { method: "POST", path: "/api/option/waffo-pancake/subscription-product", auth: "root", purpose: "创建 Waffo Pancake 订阅商品" },
      { method: "GET", path: "/api/option/waffo-pancake/subscription-product-options", auth: "root", purpose: "Waffo Pancake 订阅商品选项" },
    ],
  },
  {
    group: "令牌管理",
    id: "tokens",
    routes: [
      { method: "GET", path: "/api/token/", auth: "user", purpose: "自己的令牌列表（key 已掩码）" },
      { method: "GET", path: "/api/token/search", auth: "user", purpose: "搜索自己的令牌（keyword/token）" },
      { method: "GET", path: "/api/token/{id}", auth: "user", purpose: "自己的令牌详情（掩码）" },
      { method: "POST", path: "/api/token/", auth: "user", purpose: "创建令牌；响应不返回密钥" },
      { method: "PUT", path: "/api/token/", auth: "user", purpose: "更新令牌（?status_only 只改状态）" },
      { method: "GET", path: "/api/token/auto-groups", auth: "user", purpose: "自动分组可用分组与上限" },
      { method: "POST", path: "/api/token/{id}/key", auth: "user", purpose: "读取自己的令牌明文密钥" },
      { method: "POST", path: "/api/token/batch/keys", auth: "user", purpose: "批量读取自己的令牌密钥（最多 100）" },
      { method: "DELETE", path: "/api/token/{id}", auth: "user", purpose: "删除令牌", destructive: true },
      { method: "POST", path: "/api/token/batch", auth: "user", purpose: "批量删除令牌", destructive: true },
      { method: "GET", path: "/api/usage/token/", auth: "user", purpose: "用令牌密钥查询该令牌用量（Authorization 传 sk- 密钥）" },
      { method: "GET", path: "/api/log/token", auth: "user", purpose: "用令牌密钥查询该令牌的日志" },
    ],
  },
  {
    group: "兑换码",
    id: "redemptions",
    routes: [
      { method: "GET", path: "/api/redemption/", auth: "admin", purpose: "兑换码列表" },
      { method: "GET", path: "/api/redemption/search", auth: "admin", purpose: "搜索兑换码（keyword/status，status 支持 expired）" },
      { method: "GET", path: "/api/redemption/{id}", auth: "admin", purpose: "兑换码详情" },
      { method: "POST", path: "/api/redemption/", auth: "admin", purpose: "批量生成兑换码（name/count(1-100)/quota/expired_time），返回码数组" },
      { method: "PUT", path: "/api/redemption/", auth: "admin", purpose: "更新兑换码（?status_only 只改状态）" },
      { method: "DELETE", path: "/api/redemption/{id}", auth: "admin", purpose: "删除兑换码", destructive: true },
      { method: "DELETE", path: "/api/redemption/invalid", auth: "admin", purpose: "删除全部无效兑换码（已用/禁用/过期）", destructive: true },
      { method: "POST", path: "/api/redemption/batch", auth: "admin", purpose: "批量删除兑换码（最多 1000）", destructive: true },
      { method: "POST", path: "/api/user/topup", auth: "user", purpose: "用户用兑换码充值" },
    ],
  },
  {
    group: "日志与统计",
    id: "logs",
    routes: [
      { method: "GET", path: "/api/log/", auth: "admin", purpose: "全部日志（type/时间范围/username/model_name/channel/group/request_id 过滤）" },
      { method: "GET", path: "/api/log/stat", auth: "admin", purpose: "日志统计 {quota,rpm,tpm}；quota 受时间范围影响，rpm/tpm 恒为最近 60 秒" },
      { method: "GET", path: "/api/log/search", auth: "admin", purpose: "已废弃：恒返回「该接口已废弃」，请改用 GET /api/log/" },
      { method: "GET", path: "/api/log/self", auth: "user", purpose: "自己的日志" },
      { method: "GET", path: "/api/log/self/stat", auth: "user", purpose: "自己的日志统计" },
      { method: "GET", path: "/api/log/self/search", auth: "user", purpose: "已废弃：恒返回「该接口已废弃」" },
      { method: "GET", path: "/api/log/channel_affinity_usage_cache", auth: "admin", purpose: "渠道亲和用量缓存统计" },
      { method: "GET", path: "/api/data/", auth: "admin", purpose: "按模型聚合的额度数据" },
      { method: "GET", path: "/api/data/users", auth: "admin", purpose: "按用户聚合的额度数据" },
      { method: "GET", path: "/api/data/flow", auth: "admin", purpose: "明细流水（start/end 时间必填且 end>=start）" },
      { method: "GET", path: "/api/data/self", auth: "user", purpose: "自己的额度数据（跨度上限 30 天）" },
      { method: "GET", path: "/api/data/flow/self", auth: "user", purpose: "自己的明细流水（跨度上限 30 天）" },
      { method: "GET", path: "/api/audit", auth: "admin", purpose: "审计日志（需 audit:read 权限）" },
      { method: "GET", path: "/api/audit/self", auth: "user", purpose: "自己的审计日志" },
    ],
  },
  {
    group: "分组",
    id: "groups",
    routes: [
      { method: "GET", path: "/api/group/", auth: "admin", purpose: "全部组名（纯数组，不排序，不含倍率）" },
      { method: "GET", path: "/api/prefill_group/", auth: "admin", purpose: "预填分组列表（?type= 过滤）" },
      { method: "POST", path: "/api/prefill_group/", auth: "admin", purpose: "创建预填分组" },
      { method: "PUT", path: "/api/prefill_group/", auth: "admin", purpose: "更新预填分组（整体覆盖，需 id）" },
      { method: "DELETE", path: "/api/prefill_group/{id}", auth: "admin", purpose: "删除预填分组", destructive: true },
    ],
  },
  {
    group: "供应商",
    id: "vendors",
    routes: [
      { method: "GET", path: "/api/vendors/", auth: "admin", purpose: "供应商列表（keyword/association）" },
      { method: "GET", path: "/api/vendors/search", auth: "admin", purpose: "搜索供应商（同列表参数）" },
      { method: "GET", path: "/api/vendors/{id}", auth: "admin", purpose: "供应商详情（含 model_count 与 version）" },
      { method: "POST", path: "/api/vendors/", auth: "admin", purpose: "创建供应商" },
      { method: "PUT", path: "/api/vendors/", auth: "admin", purpose: "更新供应商（需 id；version 可作乐观锁）" },
      { method: "POST", path: "/api/vendors/operations/preview", auth: "admin", purpose: "预览供应商运维操作（assign/merge/delete），返回 version 令牌" },
      { method: "POST", path: "/api/vendors/operations", auth: "admin", purpose: "应用供应商运维操作；必须回传 expected_version" },
      { method: "DELETE", path: "/api/vendors/{id}", auth: "admin", purpose: "删除供应商（被模型引用时返回 409）", destructive: true },
    ],
  },
  {
    group: "任务与日志任务",
    id: "tasks",
    routes: [
      { method: "GET", path: "/api/task/", auth: "admin", purpose: "全部任务" },
      { method: "GET", path: "/api/task/self", auth: "user", purpose: "自己的任务" },
      { method: "GET", path: "/api/task/{task_id}/artifacts", auth: "user", purpose: "任务产物" },
      { method: "GET", path: "/api/mj/", auth: "admin", purpose: "全部 Midjourney 任务" },
      { method: "GET", path: "/api/mj/self", auth: "user", purpose: "自己的 Midjourney 任务" },
    ],
  },
  {
    group: "系统任务与运维",
    id: "system-ops",
    routes: [
      { method: "POST", path: "/api/system-task/log-cleanup", auth: "root", purpose: "创建日志清理任务（?target_timestamp=）", destructive: true },
      { method: "GET", path: "/api/system-task/list", auth: "root", purpose: "系统任务列表" },
      { method: "GET", path: "/api/system-task/current", auth: "root", purpose: "当前运行中的系统任务" },
      { method: "GET", path: "/api/system-task/{task_id}", auth: "root", purpose: "系统任务详情" },
      { method: "DELETE", path: "/api/system-task/history", auth: "root", purpose: "删除系统任务历史", destructive: true },
      { method: "GET", path: "/api/system-info/instances", auth: "root", purpose: "多节点实例列表" },
      { method: "DELETE", path: "/api/system-info/stale-instances", auth: "root", purpose: "清理失效实例", destructive: true },
      { method: "DELETE", path: "/api/system-info/instances/{node_name}", auth: "root", purpose: "删除指定实例", destructive: true },
      { method: "GET", path: "/api/performance/stats", auth: "root", purpose: "性能统计" },
      { method: "GET", path: "/api/performance/logs", auth: "root", purpose: "日志文件列表" },
      { method: "DELETE", path: "/api/performance/logs", auth: "root", purpose: "清理日志文件", destructive: true },
      { method: "DELETE", path: "/api/performance/disk_cache", auth: "root", purpose: "清理磁盘缓存", destructive: true },
      { method: "POST", path: "/api/performance/reset_stats", auth: "root", purpose: "重置性能统计", destructive: true },
      { method: "POST", path: "/api/performance/gc", auth: "root", purpose: "强制 GC" },
      { method: "GET", path: "/api/authz/catalog", auth: "admin", purpose: "权限目录（资源、动作、角色基线），用于权限编辑器" },
    ],
  },
  {
    group: "任务插件",
    id: "task-plugins",
    routes: [
      { method: "GET", path: "/api/plugin/task", auth: "root", purpose: "任务插件列表" },
      { method: "POST", path: "/api/plugin/task", auth: "root", purpose: "上传任务插件" },
      { method: "PUT", path: "/api/plugin/task", auth: "root", purpose: "更新任务插件" },
      { method: "GET", path: "/api/plugin/task/{key}", auth: "root", purpose: "任务插件详情" },
      { method: "GET", path: "/api/plugin/task/{key}/versions", auth: "root", purpose: "任务插件版本列表" },
      { method: "DELETE", path: "/api/plugin/task/{key}/versions/{version}", auth: "root", purpose: "删除任务插件版本", destructive: true },
      { method: "POST", path: "/api/plugin/task/{key}/activate", auth: "root", purpose: "激活任务插件版本" },
      { method: "POST", path: "/api/plugin/task/{key}/status", auth: "root", purpose: "设置任务插件状态" },
      { method: "POST", path: "/api/plugin/task/{key}/dryrun", auth: "root", purpose: "任务插件试运行" },
      { method: "GET", path: "/api/plugin/task/runtime/status", auth: "root", purpose: "任务插件运行时状态" },
      { method: "GET", path: "/api/plugin/task/marketplace/sources", auth: "root", purpose: "任务插件市场源" },
      { method: "PUT", path: "/api/plugin/task/marketplace/sources", auth: "root", purpose: "更新任务插件市场源" },
      { method: "GET", path: "/api/task_plugin_options", auth: "admin", purpose: "任务插件绑定选项（需 task_plugin:bind 权限）" },
    ],
  },
  {
    group: "自定义 OAuth 提供商",
    id: "custom-oauth",
    routes: [
      { method: "GET", path: "/api/custom-oauth-provider/", auth: "root", purpose: "自定义 OAuth 提供商列表" },
      { method: "GET", path: "/api/custom-oauth-provider/{id}", auth: "root", purpose: "自定义 OAuth 提供商详情" },
      { method: "POST", path: "/api/custom-oauth-provider/", auth: "root", purpose: "创建自定义 OAuth 提供商" },
      { method: "PUT", path: "/api/custom-oauth-provider/{id}", auth: "root", purpose: "更新自定义 OAuth 提供商" },
      { method: "DELETE", path: "/api/custom-oauth-provider/{id}", auth: "root", purpose: "删除自定义 OAuth 提供商", destructive: true },
      { method: "POST", path: "/api/custom-oauth-provider/discovery", auth: "root", purpose: "拉取 OIDC discovery 配置" },
    ],
  },
  {
    group: "支付与订阅",
    id: "payment",
    routes: [
      { method: "POST", path: "/api/user/pay", auth: "user", purpose: "发起易支付" },
      { method: "POST", path: "/api/user/amount", auth: "user", purpose: "计算易支付金额" },
      { method: "POST", path: "/api/user/stripe/pay", auth: "user", purpose: "发起 Stripe 支付" },
      { method: "POST", path: "/api/user/stripe/amount", auth: "user", purpose: "计算 Stripe 金额" },
      { method: "POST", path: "/api/user/creem/pay", auth: "user", purpose: "发起 Creem 支付" },
      { method: "POST", path: "/api/user/waffo/amount", auth: "user", purpose: "计算 Waffo 金额" },
      { method: "POST", path: "/api/user/waffo/pay", auth: "user", purpose: "发起 Waffo 支付" },
      { method: "POST", path: "/api/user/waffo-pancake/amount", auth: "user", purpose: "计算 Waffo Pancake 金额" },
      { method: "POST", path: "/api/user/waffo-pancake/pay", auth: "user", purpose: "发起 Waffo Pancake 支付" },
      { method: "GET", path: "/api/user/epay/notify", auth: "public", purpose: "易支付回调（由支付方调用）" },
      { method: "POST", path: "/api/stripe/webhook", auth: "public", purpose: "Stripe Webhook" },
      { method: "POST", path: "/api/creem/webhook", auth: "public", purpose: "Creem Webhook" },
      { method: "POST", path: "/api/waffo/webhook", auth: "public", purpose: "Waffo Webhook" },
      { method: "POST", path: "/api/waffo-pancake/webhook/{env}", auth: "public", purpose: "Waffo Pancake Webhook" },
      { method: "GET", path: "/api/subscription/plans", auth: "user", purpose: "订阅套餐列表" },
      { method: "GET", path: "/api/subscription/self", auth: "user", purpose: "自己的订阅" },
      { method: "PUT", path: "/api/subscription/self/preference", auth: "user", purpose: "订阅偏好设置" },
      { method: "GET", path: "/api/subscription/admin/plans", auth: "admin", purpose: "管理员：订阅套餐列表" },
      { method: "POST", path: "/api/subscription/admin/plans", auth: "admin", purpose: "管理员：创建订阅套餐" },
      { method: "PUT", path: "/api/subscription/admin/plans/{id}", auth: "admin", purpose: "管理员：更新订阅套餐" },
      { method: "PATCH", path: "/api/subscription/admin/plans/{id}", auth: "admin", purpose: "管理员：更新订阅套餐状态" },
      { method: "POST", path: "/api/subscription/admin/bind", auth: "admin", purpose: "管理员：为用户绑定订阅" },
      { method: "POST", path: "/api/subscription/admin/plans/{id}/subscriptions/reset", auth: "admin", purpose: "管理员：重置套餐下所有订阅", destructive: true },
      { method: "GET", path: "/api/subscription/admin/users/{id}/subscriptions", auth: "admin", purpose: "管理员：查看用户订阅" },
      { method: "POST", path: "/api/subscription/admin/users/{id}/subscriptions", auth: "admin", purpose: "管理员：创建用户订阅" },
      { method: "POST", path: "/api/subscription/admin/users/{id}/subscriptions/reset", auth: "admin", purpose: "管理员：重置用户订阅", destructive: true },
      { method: "POST", path: "/api/subscription/admin/user_subscriptions/{id}/invalidate", auth: "admin", purpose: "管理员：作废用户订阅", destructive: true },
      { method: "DELETE", path: "/api/subscription/admin/user_subscriptions/{id}", auth: "admin", purpose: "管理员：删除用户订阅", destructive: true },
    ],
  },
  {
    group: "模型部署 (IoNet)",
    id: "deployments",
    routes: [
      { method: "GET", path: "/api/deployments/", auth: "admin", purpose: "部署列表" },
      { method: "GET", path: "/api/deployments/search", auth: "admin", purpose: "搜索部署" },
      { method: "GET", path: "/api/deployments/{id}", auth: "admin", purpose: "部署详情" },
      { method: "GET", path: "/api/deployments/settings", auth: "admin", purpose: "部署设置" },
      { method: "POST", path: "/api/deployments/", auth: "admin", purpose: "创建部署" },
      { method: "PUT", path: "/api/deployments/{id}", auth: "admin", purpose: "更新部署" },
      { method: "PUT", path: "/api/deployments/{id}/name", auth: "admin", purpose: "更新部署名称" },
      { method: "POST", path: "/api/deployments/{id}/extend", auth: "admin", purpose: "延长部署" },
      { method: "DELETE", path: "/api/deployments/{id}", auth: "admin", purpose: "删除部署", destructive: true },
      { method: "GET", path: "/api/deployments/hardware-types", auth: "admin", purpose: "可选硬件类型" },
      { method: "GET", path: "/api/deployments/locations", auth: "admin", purpose: "可选区域" },
      { method: "GET", path: "/api/deployments/available-replicas", auth: "admin", purpose: "可用副本数" },
      { method: "POST", path: "/api/deployments/price-estimation", auth: "admin", purpose: "部署价格预估" },
      { method: "GET", path: "/api/deployments/check-name", auth: "admin", purpose: "检查集群名可用性" },
      { method: "GET", path: "/api/deployments/{id}/logs", auth: "admin", purpose: "部署日志" },
      { method: "GET", path: "/api/deployments/{id}/containers", auth: "admin", purpose: "部署容器列表" },
      { method: "GET", path: "/api/deployments/{id}/containers/{container_id}", auth: "admin", purpose: "容器详情" },
      { method: "POST", path: "/api/deployments/test-connection", auth: "admin", purpose: "测试 IoNet 连接" },
      { method: "POST", path: "/api/deployments/settings/test-connection", auth: "admin", purpose: "用给定设置测试 IoNet 连接" },
    ],
  },
  {
    group: "旧版看板计费",
    id: "legacy-dashboard",
    routes: [
      { method: "GET", path: "/dashboard/billing/subscription", auth: "user", purpose: "旧版订阅信息（用令牌鉴权，非管理面板令牌）" },
      { method: "GET", path: "/dashboard/billing/usage", auth: "user", purpose: "旧版用量信息（用令牌鉴权）" },
    ],
  },
];

/** Flat list of every route, with its group id attached. */
export const ROUTES = GROUPS.flatMap((entry) => entry.routes.map((route) => ({ ...route, group: entry.id, groupLabel: entry.group })));

export function findRoutes(term) {
  if (!term) return ROUTES;
  const wanted = String(term).toLowerCase();
  return ROUTES.filter(
    (route) =>
      route.path.toLowerCase().includes(wanted) ||
      route.method.toLowerCase() === wanted ||
      route.purpose.toLowerCase().includes(wanted) ||
      route.group.includes(wanted) ||
      route.groupLabel.includes(term),
  );
}

export function routeStats() {
  const byAuth = {};
  for (const route of ROUTES) byAuth[route.auth] = (byAuth[route.auth] ?? 0) + 1;
  return { total: ROUTES.length, groups: GROUPS.length, byAuth, destructive: ROUTES.filter((r) => r.destructive).length };
}

/**
 * Find the declared route matching a concrete method + path, so the CLI can warn when a
 * hand-written path is not a known route (a typo, or a version skew with the server).
 * `{id}`-style placeholders match any single segment.
 */
export function matchRoute(method, path) {
  const wantedMethod = String(method).toUpperCase();
  const target = path.split("?")[0].replace(/\/+$/, "") || "/";
  for (const route of ROUTES) {
    if (route.method !== wantedMethod) continue;
    const pattern = route.path.replace(/\/+$/, "") || "/";
    if (pattern === target) return route;
    const patternParts = pattern.split("/");
    const targetParts = target.split("/");
    if (patternParts.length !== targetParts.length) continue;
    const matched = patternParts.every((segment, index) => /^\{.*\}$/.test(segment) || segment === targetParts[index]);
    if (matched) return route;
  }
  return undefined;
}
