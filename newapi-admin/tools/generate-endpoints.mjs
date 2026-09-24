#!/usr/bin/env node
// Regenerate skills/newapi-admin/references/endpoints.md from lib/routes.mjs.
//
// The route table is hand-maintained data (lib/routes.mjs) because the upstream sources do
// not agree: the router in the new-api repository mounts 295 routes, while the published
// OpenAPI document covers only the 161 the docs site renders, and the two disagree on some
// field names. lib/routes.mjs encodes the router, which is authoritative. This script turns
// it back into readable markdown so the document and the CLI's `routes` command can never
// drift apart.
//
// Run: node tools/generate-endpoints.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GROUPS, routeStats } from "../lib/routes.mjs";

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), "skills", "newapi-admin", "references", "endpoints.md");

const AUTH_LABEL = {
  public: "公开",
  user: "用户",
  admin: "管理员",
  root: "Root",
};

const stats = routeStats();

const lines = [
  "# 管理接口全量路由索引",
  "",
  `本文件由 \`node tools/generate-endpoints.mjs\` 从 \`lib/routes.mjs\` 生成，请勿手工编辑。`,
  "",
  `共 **${stats.total}** 条路由，分 **${stats.groups}** 组，其中会改动数据的 **${stats.destructive}** 条。`,
  "",
  "## 权限层级",
  "",
  "| 标记 | 含义 | 判定 |",
  "| --- | --- | --- |",
  "| 公开 | 无需鉴权 | — |",
  "| 用户 | 任意已登录用户或访问令牌 | `UserAuth` |",
  "| 管理员 | 站点管理员 | `AdminAuth`，角色 `role >= 10` |",
  "| Root | 超级管理员 | `RootAuth`，角色 `role >= 100` |",
  "| `admin+channel:write` | 管理员且持有该细粒度权限 | `AdminAuth` + `RequirePermission` |",
  "",
  `按层级统计：${Object.entries(stats.byAuth)
    .map(([tier, count]) => `${AUTH_LABEL[tier] ?? tier} ${count}`)
    .join("、")}。`,
  "",
  "渠道路由在管理员之上还叠加了细粒度权限，可对单个用户授予或撤销：",
  "",
  "| 权限 | 覆盖的写操作 | 默认角色 |",
  "| --- | --- | --- |",
  "| `channel:read` | 列表、详情、模型目录、默认 base_url | admin |",
  "| `channel:operate` | 启停、测试、余额、拉取模型、修能力、多密钥 | admin |",
  "| `channel:write` | 更新渠道、标签编辑与批量打标 | admin |",
  "| `channel:sensitive_write` | 新增、删除、复制、密钥相关、上游模型更新 | **无**（默认仅 Root） |",
  "",
  "> 默认情况下普通管理员**没有** `channel:sensitive_write`，因此新增或删除渠道会返回「权限不足」。",
  "> 需要时由 Root 通过权限管理单独授权，或直接用 Root 令牌。",
  "",
  "标记 `[destructive]` 的路由会改动或删除数据；CLI 中必须加 `--yes`（MCP 中必须 `confirm:true`）。",
  "",
];

for (const group of GROUPS) {
  lines.push(`## ${group.group}`, "", "| 方法 | 路径 | 权限 | 说明 |", "| --- | --- | --- | --- |");
  for (const route of group.routes) {
    const guard = route.auth === "admin" && route.perm ? `admin+${route.perm}` : AUTH_LABEL[route.auth] ?? route.auth;
    const purpose = `${route.purpose}${route.destructive ? " **[destructive]**" : ""}`;
    lines.push(`| ${route.method} | \`${route.path}\` | ${guard} | ${purpose} |`);
  }
  lines.push("");
}

lines.push(
  "## 未覆盖的路由",
  "",
  "以下路由挂在同一后端但**不属于管理面板接口**，本索引与 CLI 均不覆盖：",
  "",
  "- `/v1/*`、`/v1beta/*`、`/claude/*` 等 **AI 模型调用接口**（用 `sk-` 令牌鉴权，不是面板令牌），见 AI 模型接口文档。",
  "- `/api/usage/token/`、`/api/log/token` 用**令牌密钥**鉴权（`Authorization: Bearer sk-...`），不是面板令牌；CLI 中对应 `tokens usage`。",
  "- `/dashboard/billing/*` 旧版看板接口，用令牌鉴权。",
  "- `/api/plugin/task/*` 任务插件管理与 `/api/deployments/*` 模型部署有管理接口，但属于独立子系统，CLI 未做类型化封装，可用 `newapi-admin api` 直接调用。",
  "",
  "## 与官方 OpenAPI 文档的差异",
  "",
  "以本表为准（它取自 `router/` 源码）。已知官方 `docs/openapi/api.json` 与源码不一致之处：",
  "",
  "| 项目 | 文档写法 | 源码实际 |",
  "| --- | --- | --- |",
  "| 渠道分组字段 | `groups` | `group`（单数，逗号分隔） |",
  "| 渠道列表过滤 | 未记载 `group` / `sort_by` / `sort_order` | 实际支持 |",
  "| 多密钥操作枚举 | 缺 `enable_all_keys` / `disable_all_keys` | 实际支持 |",
  "| 标签编辑请求体 | 未记载 `models` / `groups` / `priority` 等 | 实际支持 |",
  "",
);

writeFileSync(out, `${lines.join("\n")}\n`);
process.stdout.write(`wrote ${out}: ${stats.total} routes in ${stats.groups} groups\n`);
