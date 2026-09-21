# 参考文档索引

这些文档是插件的知识主体。它们**不是**官方文档的转述——官方 OpenAPI 文档与实际代码有出入（见根目录 README 的对照表），这里的字段名、单位、权限层级逐条对照过 New API 的 `router/`、`model/`、`controller/` 源码。

改动任何东西之前，先读 `conventions.md` 和对应主题的那一篇。

| 文档 | 什么时候读 |
| --- | --- |
| [conventions.md](conventions.md) | **第一次用必读**。鉴权方式、响应信封、分页差异、额度/倍率/金额换算、权限层级、乐观锁、危险操作清单、被静默忽略的字段 |
| [channels.md](channels.md) | 增删改渠道、测试连通性、查余额、标签批量操作、多密钥、上游模型变化 |
| [models-and-pricing.md](models-and-pricing.md) | 改模型价格与倍率、按次固定价、计费公式、模型元数据、官方目录同步 |
| [users.md](users.md) | 用户增删改、角色与状态、额度调整、充值补单、第三方绑定、细粒度权限 |
| [tokens-and-redemptions.md](tokens-and-redemptions.md) | 令牌（注意是用户级作用域）与兑换码（管理员级） |
| [logs-and-stats.md](logs-and-stats.md) | 请求日志、日志统计的时间语义陷阱、用量聚合、审计日志、日志清理 |
| [system-and-options.md](system-and-options.md) | 系统选项键表、请求策略、分组、预填分组、供应商两阶段运维、系统任务与多节点 |
| [endpoints.md](endpoints.md) | 全部 295 条路由的方法、路径、权限层级、用途。**由脚本生成，勿手工编辑** |

## 最容易出错的八件事

先看这八条，能省掉大部分试错：

1. **失败也是 HTTP 200**。判断成败看 `success` 字段，不是状态码。
2. **渠道的 `group` 是单数，标签编辑的 `groups` 是复数**。渠道对象用 `group`，`PUT /api/channel/tag` 用 `groups`。
3. **`PUT /api/channel/` 不能带 `status`**，带整个请求就失败。启停走 `/api/channel/{id}/status`。
4. **`PUT /api/user/` 只能改 `username`/`display_name`/`group`/`remark`/`password`**，`role`/`status`/`quota` 静默忽略。改这些用 `/api/user/manage`。
5. **1 倍率 = $2/1M tokens**，所以 `ratio = USD_per_1M ÷ 2`；而 `1 USD = QuotaPerUnit 个 quota`（默认 500000）。这是两个不同的换算。
6. **`ModelPrice` 一旦设置就完全绕过倍率**。想让模型回到按倍率计费，必须删掉它的 `ModelPrice` 条目。
7. **令牌的「永不过期」是 `-1`，兑换码的是 `0`**。写反不报错。
8. **`/api/log/stat` 的 `rpm`/`tpm` 恒为最近 60 秒**，与传入的时间区间无关；只有 `quota` 受区间影响。

## 三处乐观锁

改这三个东西要**先读版本号再回传**，否则 409：

| 场景 | 版本字段 | CLI 是否已代劳 |
| --- | --- | --- |
| 按模型改定价 | `expected_version` | ✅ `pricing set` / `pricing bulk` |
| 应用模型元数据同步 | `source_version` + 每条 `record_version` | ✅ `models sync-apply` |
| 供应商合并/删除/改派 | `expected_version` | ✅ `vendors assign/merge/delete-many` |

用 `newapi-admin api` 直接调这些接口时要自己搬运版本号。

## 路由覆盖范围

`endpoints.md` 里的 295 条路由来自 `router/` 源码。**不包括**：

- AI 模型调用接口（`/v1/*`、`/v1beta/*`、`/claude/*`），那是用 `sk-` 令牌调用的中继接口，不是管理接口。
- 用令牌密钥鉴权的接口（`/api/usage/token/`、`/api/log/token`）。
- 旧版看板接口（`/dashboard/billing/*`）。

有管理接口但 CLI 未做类型化封装的子系统（用 `newapi-admin api` 直接调）：任务插件 `/api/plugin/task/*`、模型部署 `/api/deployments/*`、订阅 `/api/admin/subscription/*`、自定义 OAuth `/api/custom-oauth-provider/*`。

## 上游文档

- 文档站：<https://docs.newapi.pro/zh/docs/api/management/auth>
- 源码：<https://github.com/QuantumNous/new-api>
- 本插件的路由与字段结论以源码为准，与文档站不一致时以本插件为准（差异表见根目录 README）
