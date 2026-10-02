#!/usr/bin/env node
// MCP stdio server exposing a Qinglong (青龙 2.x) panel to a model.
//
// Shape of the surface, and why:
//   * `qinglong_request` is the escape hatch that reaches every route, so the tool list never
//     has to grow to keep coverage complete. Destructive requests must set confirm:true.
//   * `qinglong_routes` and `qinglong_reference` make the sedimented documentation readable
//     inside the conversation, so the model can look up an exact field name or a scope grant
//     instead of guessing or reading files.
//   * Typed tools cover the everyday workflows (tasks, envs, subscriptions, dependencies,
//     logs, dashboard) — the places where the panel's own traps bite: whole-record updates,
//     accepted≠success, byte-offset log reads, numeric-vs-enum dependency types.
//
// Protocol: JSON-RPC 2.0, one JSON message per line on stdin/stdout. stdout carries protocol
// traffic only; diagnostics go to stderr. Node >= 18, no dependencies.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiError,
  DEPENDENCY_STATUS,
  DEPENDENCY_TYPES,
  DEPENDENCY_TYPE_CODES,
  SCOPES,
  SCOPE_PROBE_ROUTES,
  UsageError,
  authMode,
  request,
  resolveConfig,
} from "../lib/core.mjs";
import { findRoutes, isDestructive, matchRoute, routeStats } from "../lib/routes.mjs";

const SERVER_NAME = "qinglong-admin";
const SERVER_VERSION = "0.2.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const referencesDir = join(pluginRoot, "skills", "qinglong-admin", "references");

// Topic -> file stem in skills/qinglong-admin/references/. Friendly names for the per-resource
// OpenAPI pages; the raw file names stay stable for the doc-drift check.
const REFERENCE_TOPICS = {
  cli: { file: "cli", about: "官方 ql CLI 与面板内部命令的边界、三种凭据模式、输出与错误" },
  routes: { file: "routes", about: "143 条 CLI 命令 ↔ HTTP 路由全表（按模块分组）" },
  workflows: { file: "workflows", about: "处方集：建任务并验证、批量运行、看日志、导入环境变量、备份恢复、巡检、排障" },
  pitfalls: { file: "pitfalls", about: "交叉坑：成功判据、请求形状、日志偏移、410 下线接口、单位与枚举、scope 速查" },
  "panel-this-box": { file: "panel-this-box", about: "本机部署事实、面板内置命令、备份/升级/恢复、常见问题矩阵" },
  auth: { file: "openapi-auth", about: "创建应用、换取 token、请求示例" },
  crons: { file: "openapi-crons", about: "定时任务与视图/标签/实例、执行选项、日志分块" },
  subscriptions: { file: "openapi-subscriptions", about: "订阅字段与必填项、拉取与状态" },
  envs: { file: "openapi-envs", about: "环境变量字段、命名规则、标签与置顶、文件导入" },
  scripts: { file: "openapi-scripts", about: "脚本 CRUD、调试运行（swap 文件）语义" },
  configs: { file: "openapi-configs", about: "配置文件读取与保存、黑名单" },
  logs: { file: "openapi-logs", about: "日志分块读取（字节偏移）、删除与下载" },
  dependencies: { file: "openapi-dependencies", about: "依赖类型数字 vs 枚举、8 种状态" },
  system: { file: "openapi-system", about: "系统信息/配置/通知（22 种枚举）/命令/数据导入导出/保留策略" },
  dashboard: { file: "openapi-dashboard", about: "仪表盘统计视图（含 CLI 未收录的 successes/failures）" },
  "apps-users": { file: "openapi-apps-users", about: "面板应用管理与用户/两步验证/IP 黑名单" },
};

const config = resolveConfig({
  flags: {},
  env: {
    QL_URL: process.env.QL_URL,
    QL_ACCESS_TOKEN: process.env.QL_ACCESS_TOKEN,
    QL_CLIENT_ID: process.env.QL_CLIENT_ID,
    QL_CLIENT_SECRET: process.env.QL_CLIENT_SECRET,
    QL_TIMEOUT_MS: process.env.QL_TIMEOUT_MS,
  },
});

// An unexpanded ${...} placeholder means the host could not resolve the user's config.
function resolved(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.includes("${") ? "" : trimmed;
}

let missingConfig = false;
{
  const url = resolved(config.baseUrl);
  const token = resolved(config.accessToken);
  const clientId = resolved(config.clientId);
  const clientSecret = resolved(config.clientSecret);
  if (!url || (!token && !(clientId && clientSecret))) {
    missingConfig = true;
  } else {
    config.baseUrl = url.replace(/\/+$/, "");
    config.accessToken = token || undefined;
    config.clientId = clientId || undefined;
    config.clientSecret = clientSecret || undefined;
  }
}

const CONFIG_HINT =
  "This plugin is not configured. Set the plugin's panel URL and credentials (plugin settings), " +
  "or export QL_URL and QL_ACCESS_TOKEN — or QL_CLIENT_ID + QL_CLIENT_SECRET. Create the application " +
  "in 面板 系统设置 → 应用设置 and grant the scopes you need.";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const json = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });
const idList = (description) => ({ type: "array", items: { type: "integer" }, description });

const TOOLS = [
  {
    name: "qinglong_request",
    description:
      "Call any Qinglong panel route directly. Use this for anything the typed tools do not cover — it reaches every route. " +
      "Paths are panel-relative starting with /open, e.g. '/open/crons' or '/open/envs/3'. Query values must be strings. " +
      "Destructive requests (DELETE, or a delete/reset/import/cleanup/reload/update path) are refused unless confirm is true.",
    inputSchema: json(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method" },
        path: str("Panel path, e.g. /open/crons or /open/envs"),
        query: { type: "object", description: "Query parameters as strings", additionalProperties: { type: "string" } },
        body: { description: "JSON request body (object or array)" },
        confirm: bool("Must be true to run a destructive request"),
      },
      ["method", "path"],
    ),
  },
  {
    name: "qinglong_routes",
    description:
      "Search the bundled index of the 143 documented panel routes (method, path, scope, purpose, destructive flag), " +
      "plus the unindexed dashboard extras. Omit term to list everything, or pass a keyword, path fragment or group id.",
    inputSchema: json({ term: str("Keyword, path fragment or group id, e.g. 'cron', 'env', 'retention'") }),
  },
  {
    name: "qinglong_reference",
    description:
      "Read a Qinglong reference document from this plugin. Call it before making non-trivial changes: the docs carry " +
      "exact field names, request shapes and failure criteria that are easy to get wrong (whole-record updates, byte offsets, 410 routes).",
    inputSchema: json({ topic: { type: "string", enum: Object.keys(REFERENCE_TOPICS), description: "Which reference to read" } }, ["topic"]),
  },
  {
    name: "qinglong_status",
    description:
      "Panel health, version and auth mode. Pass scope to probe one application scope (crons, envs, system, …) with a " +
      "representative read route — the answer distinguishes a working grant from a 403. Omitting scope probes nothing.",
    inputSchema: json({ scope: { type: "string", enum: SCOPES, description: "Probe this scope's representative read route" } }),
  },
  {
    name: "qinglong_tasks_list",
    description:
      "List scheduled tasks. Each row is the panel's own task object (id, name, command, schedule, labels, " +
      "isDisabled/status, last_running_time, pid, log_path). Read the ID you need from here — never guess IDs.",
    inputSchema: json({
      search: str("Keyword matched against name/command (searchValue)"),
      status: str("Status filter, e.g. 'running' or 'waiting' (pass through)"),
      type: str("Type filter (pass through)"),
      page: int("Page number (default 1)"),
      size: int("Page size (default 20)"),
    }),
  },
  {
    name: "qinglong_task_get",
    description:
      "Fetch one task by numeric id, or look ones up by name with the name field (returns every close match with its id). " +
      "Every change should start with this: the update route replaces the whole record and merges nothing.",
    inputSchema: json({ id: int("Task id"), name: str("Task name to search for") }),
  },
  {
    name: "qinglong_task_create",
    description:
      "Create a scheduled task. command and schedule are mandatory; command uses the panel executor syntax ('task demo.js' for a saved " +
      "script, 'task folder/demo.js' for subdirectories). The script must already exist — check with qinglong_request GET /open/scripts/detail first. " +
      "After creating, re-read with qinglong_tasks_list to capture the real id.",
    inputSchema: json(
      {
        name: str("Task name"),
        command: str("Command the panel executes, e.g. 'task demo.js'"),
        schedule: str("Cron expression, e.g. '0 9 * * *' (seconds supported; no bare /5, no '?')"),
        labels: { type: "array", items: { type: "string" }, description: "Labels" },
        log_name: str("Custom log name (relative ≤100 chars, no ./..; or /dev/null)"),
        work_dir: str("Working directory"),
        task_before: str("Command run before the task"),
        task_after: str("Command run after the task"),
        allow_multiple_instances: bool("Allow overlapping instances (default false)"),
      },
      ["command", "schedule"],
    ),
  },
  {
    name: "qinglong_task_update",
    description:
      "Update a task. The panel replaces the whole record: command and schedule are mandatory every time and nothing is merged — " +
      "read the current record with qinglong_task_get first and restate the full submission. Re-read after the write to verify.",
    inputSchema: json(
      {
        id: int("Task id"),
        command: str("Full command (mandatory)"),
        schedule: str("Full cron expression (mandatory)"),
        name: str("Task name"),
        labels: { type: "array", items: { type: "string" } },
        log_name: str("Custom log name"),
        work_dir: str("Working directory"),
        task_before: str("Command run before the task"),
        task_after: str("Command run after the task"),
        allow_multiple_instances: bool("Allow overlapping instances"),
      },
      ["id", "command", "schedule"],
    ),
  },
  {
    name: "qinglong_task_action",
    description:
      "Run, stop, enable, disable, pin or unpin tasks by ID array. run submits execution requests ONLY: accepted≠success — judge the " +
      "outcome from qinglong_task_instances and the log text (qinglong_task_logs), and remember the newest log may belong to the previous run. " +
      "stop kills running instances. enable/disable only toggles the schedule (nothing is deleted).",
    inputSchema: json(
      {
        action: { type: "string", enum: ["run", "stop", "enable", "disable", "pin", "unpin"], description: "What to do" },
        ids: idList("Task IDs (arrays are accepted; the HTTP routes take ID arrays)"),
      },
      ["action", "ids"],
    ),
  },
  {
    name: "qinglong_task_logs",
    description:
      "Read a task's log in byte chunks. The response carries logStatus, offset, nextOffset, total and truncated; continue from " +
      "nextOffset (bytes — never compute offsets from character counts). Without offset the read starts at the tail. A completed-looking " +
      "log can still belong to the previous run; correlate with instances.",
    inputSchema: json({
      id: int("Task id"),
      offset: int("Byte offset (non-negative); omit to read the tail"),
      limit: int("Max bytes to read (≤1048576, default 262144)"),
      tail: bool("Read the tail (default true when offset is omitted)"),
    }, ["id"]),
  },
  {
    name: "qinglong_task_instances",
    description:
      "List a task's instances, newest first, with elapsed seconds for running ones. This — plus the log content — is the evidence " +
      "for whether a run actually succeeded.",
    inputSchema: json({ id: int("Task id") }, ["id"]),
  },
  {
    name: "qinglong_envs_list",
    description:
      "List environment variables (including values — treat the output as sensitive and mask before sharing). " +
      "search filters by name substring (searchValue).",
    inputSchema: json({ search: str("Name substring to filter by (searchValue)") }),
  },
  {
    name: "qinglong_env_create",
    description:
      "Create environment variables. The route takes an OBJECT ARRAY, and creation never updates existing rows by id. " +
      "Names must start with a letter or underscore and contain only letters, digits, underscores.",
    inputSchema: json(
      {
        entries: {
          type: "array",
          description: "Entries to create",
          items: json({ name: str("Variable name"), value: str("Value"), remarks: str("Remark"), labels: { type: "array", items: { type: "string" } } }, ["name", "value"]),
        },
      },
      ["entries"],
    ),
  },
  {
    name: "qinglong_env_update",
    description:
      "Update ONE environment variable. id + name + value are all mandatory — it is a whole-record submit and cannot change only " +
      "remarks or labels. Read the row first (qinglong_envs_list) and restate name and value exactly.",
    inputSchema: json(
      {
        id: int("Env id"),
        name: str("Variable name (mandatory)"),
        value: str("Value (mandatory)"),
        remarks: str("Remark"),
        labels: { type: "array", items: { type: "string" } },
      },
      ["id", "name", "value"],
    ),
  },
  {
    name: "qinglong_env_delete",
    description: "Delete environment variables by ID array. Requires confirm:true — deletion is irreversible.",
    inputSchema: json({ ids: idList("Env IDs"), confirm: bool("Must be true to delete") }, ["ids", "confirm"]),
  },
  {
    name: "qinglong_subscriptions_list",
    description: "List subscriptions (repositories). search matches name/alias/url; ids filters a JSON-encoded ID list.",
    inputSchema: json({ search: str("Keyword (searchValue)"), ids: str("JSON-encoded ID array, e.g. '[1,2]'") }),
  },
  {
    name: "qinglong_subscription_create",
    description:
      "Create a subscription (repository pull). type/url/alias/schedule_type are mandatory; interval schedules need value ≥ 1. " +
      "After creating, trigger with qinglong_subscription_action run and check the log — a successful pull still needs the target files " +
      "to actually appear in the script directory.",
    inputSchema: json(
      {
        type: str("Subscription type, e.g. public-repo"),
        url: str("Repository URL"),
        alias: str("Alias (directory name)"),
        schedule_type: str("Schedule type, e.g. crontab"),
        schedule: str("Cron expression when schedule_type is crontab"),
        name: str("Display name"),
        branch: str("Branch"),
        whitelist: str("Whitelist (| separated)"),
        blacklist: str("Blacklist (| separated)"),
        dependences: str("Dependency file inside the repo"),
        proxy: str("Proxy for this subscription"),
        extra: { type: "object", description: "Any remaining documented fields (autoAddCron, autoDelCron, pull_type, …) merged into the body" },
      },
      ["type", "url", "alias", "schedule_type"],
    ),
  },
  {
    name: "qinglong_subscription_action",
    description: "Run (trigger a pull), stop, enable or disable subscriptions by ID array.",
    inputSchema: json(
      {
        action: { type: "string", enum: ["run", "stop", "enable", "disable"], description: "What to do" },
        ids: idList("Subscription IDs"),
      },
      ["action", "ids"],
    ),
  },
  {
    name: "qinglong_dependencies_list",
    description:
      "List dependencies. type filters by ENUM NAME (nodejs/python3/linux) while the create body uses NUMBERS (0/1/2) — this is the " +
      "panel's most common 400. status accepts comma-separated codes: 0 installing, 1 installed, 2 failed, 6 queued.",
    inputSchema: json({
      search: str("Keyword (searchValue)"),
      type: { type: "string", enum: ["nodejs", "python3", "linux"], description: "Filter type (enum name)" },
      status: str("Status codes, e.g. '2,5'"),
    }),
  },
  {
    name: "qinglong_dependency_install",
    description:
      "Queue dependency installation. The route takes an OBJECT ARRAY whose type is numeric (nodejs 0, python3 1, linux 2) — names are " +
      "converted for you. Queued ≠ installed: poll qinglong_dependencies_list until status is 1, and read the install log on failure.",
    inputSchema: json(
      {
        entries: {
          type: "array",
          description: "Dependencies to install",
          items: json(
            { name: str("Package name"), type: { type: "string", description: "nodejs | python3 | linux (or 0/1/2)" }, remark: str("Remark") },
            ["name", "type"],
          ),
        },
      },
      ["entries"],
    ),
  },
  {
    name: "qinglong_log_read",
    description:
      "Read a log file in byte chunks (GET /open/logs/detail). Get file/path values from qinglong_request GET /open/logs (directory listing) " +
      "or a task's log-files. Continue from the returned nextOffset; a truncated response means read on. The retired /open/logs/:file route answers 410.",
    inputSchema: json({
      file: str("File name (required)"),
      path: str("Path relative to the log directory"),
      offset: int("Byte offset; omit to read the tail"),
      limit: int("Max bytes (1–1048576, default 262144)"),
      tail: bool("Read the tail (default true when offset is omitted)"),
    }, ["file"]),
  },
  {
    name: "qinglong_dashboard",
    description:
      "Dashboard views. overview: totals, today's runs/success/failure, rate, average time (ms). trend: per-day counts (days default 7). " +
      "runtime: running instances (elapsed in seconds), queue and stale tasks. successes/failures include today's tasks, with deleted:true for " +
      "soft-deleted ones. Elapsed units: avgTime/maxTime are milliseconds, instance elapsed is seconds.",
    inputSchema: json({
      view: { type: "string", enum: ["overview", "trend", "top-time", "top-count", "runtime", "labels", "system", "successes", "failures"], description: "Which view" },
      days: int("Trend window in days (default 7)"),
    }, ["view"]),
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function requireConfig() {
  if (missingConfig) throw new ApiError(CONFIG_HINT);
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function listOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function callTool(name, args = {}) {
  if (name === "qinglong_routes") {
    const matches = findRoutes(args.term);
    if (!matches.length) return text(`No route matches "${args.term}".`);
    const stats = routeStats();
    const lines = matches.map((route) => {
      const scope = route.scope ?? "-";
      return `${route.method.padEnd(6)} ${route.path.padEnd(52)} ${scope.padEnd(14)} ${route.purpose}${route.destructive ? "  [destructive]" : ""}`;
    });
    return text(`${matches.length} of ${stats.total} routes (${stats.groups} groups, ${stats.destructive} destructive).\n\n${lines.join("\n")}`);
  }

  if (name === "qinglong_reference") {
    const topic = REFERENCE_TOPICS[args.topic];
    if (!topic) {
      return text(`Unknown topic "${args.topic}". Available: ${Object.keys(REFERENCE_TOPICS).join(", ")}`);
    }
    try {
      return text(readFileSync(join(referencesDir, `${topic.file}.md`), "utf8"));
    } catch (error) {
      return text(`Could not read reference "${args.topic}": ${error.message}`);
    }
  }

  requireConfig();

  if (name === "qinglong_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    const query = {};
    for (const [key, value] of Object.entries(args.query ?? {})) query[key] = String(value);
    const destructive = isDestructive(method, args.path);
    if (destructive && args.confirm !== true) {
      const known = matchRoute(method, args.path);
      throw new ApiError(
        `Refusing ${method} ${args.path} without confirm:true${known ? ` (${known.purpose})` : ""}. ` +
          "Re-issue the call with confirm:true if this change is intended.",
      );
    }
    const result = await request(config, { method, path: args.path, query, body: args.body, allowText: true });
    const known = matchRoute(method, args.path);
    const note = known ? "" : `\n(note: ${method} ${args.path} is not in the bundled route index; the panel answered anyway.)`;
    if (result.nonJson) {
      return text(`${result.text.slice(0, 100000)}${note}\n(raw non-JSON response, ${result.text.length} bytes)`);
    }
    return text(`${JSON.stringify(result.data ?? null, null, 2)}${note}`);
  }

  if (name === "qinglong_status") {
    const health = await request(config, { method: "GET", path: "/open/health" });
    const system = await request(config, { method: "GET", path: "/open/system" });
    const data = system.data ?? {};
    const payload = {
      panel_url: config.baseUrl,
      auth_mode: authMode(config),
      version: data.version,
      branch: data.branch,
      is_initialized: data.isInitialized,
      publish_time: data.publishTime,
      health: health.data ?? "ok",
    };
    if (args.scope) {
      const probe = SCOPE_PROBE_ROUTES[args.scope];
      if (!probe) throw new ApiError(`Unknown scope "${args.scope}". Known: ${SCOPES.join(", ")}`);
      try {
        await request(config, { ...probe });
        payload.scope_probe = { scope: args.scope, result: "ok" };
      } catch (error) {
        payload.scope_probe = { scope: args.scope, result: "denied", message: String(error.message).split("\n")[0] };
        payload.scope_probe.note = "A 403 here means the application lacks this scope (面板 系统设置 → 应用设置); grant and re-probe.";
      }
    }
    return text(payload);
  }

  if (name === "qinglong_tasks_list") {
    const query = { page: String(args.page ?? 1), size: String(Math.min(Number(args.size ?? 20) || 20, 100)) };
    if (args.search) query.searchValue = args.search;
    if (args.status) query.status = args.status;
    if (args.type) query.type = args.type;
    const result = await request(config, { method: "GET", path: "/open/crons", query });
    const rows = listOf(result.data);
    return text({
      returned: rows.length,
      total: result.data?.total,
      tasks: rows,
      note: "Pass these rows through as-is; status/isDisabled come from the panel. Run results live in instances + logs, not here.",
    });
  }

  if (name === "qinglong_task_get") {
    if (args.id !== undefined) {
      const result = await request(config, { method: "GET", path: `/open/crons/${Number(args.id)}` });
      return text(result.data ?? null);
    }
    if (args.name) {
      const result = await request(config, { method: "GET", path: "/open/crons", query: { searchValue: args.name, page: "1", size: "100" } });
      const rows = listOf(result.data).filter((row) => String(row.name ?? "").includes(args.name) || String(row.command ?? "").includes(args.name));
      if (!rows.length) throw new ApiError(`No task matches "${args.name}". Use qinglong_tasks_list to search.`);
      if (rows.length === 1) return text(rows[0]);
      return text({ matches: rows.length, note: "Several tasks match; use one of these ids with qinglong_task_get.", tasks: rows });
    }
    throw new ApiError("Provide id or name.");
  }

  if (name === "qinglong_task_create") {
    const body = {
      command: args.command,
      schedule: args.schedule,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.labels !== undefined ? { labels: args.labels } : {}),
      ...(args.log_name !== undefined ? { log_name: args.log_name } : {}),
      ...(args.work_dir !== undefined ? { work_dir: args.work_dir } : {}),
      ...(args.task_before !== undefined ? { task_before: args.task_before } : {}),
      ...(args.task_after !== undefined ? { task_after: args.task_after } : {}),
      ...(args.allow_multiple_instances !== undefined ? { allow_multiple_instances: args.allow_multiple_instances ? 1 : 0 } : {}),
    };
    const result = await request(config, { method: "POST", path: "/open/crons", body });
    return text({
      created: true,
      response: result.data ?? null,
      next_step: `Re-read with qinglong_tasks_list (search "${args.name ?? args.command}") to capture the real id, then qinglong_task_action run.`,
    });
  }

  if (name === "qinglong_task_update") {
    const id = Number(args.id);
    if (!Number.isFinite(id)) throw new ApiError("id must be a number.");
    const body = {
      id,
      command: args.command,
      schedule: args.schedule,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.labels !== undefined ? { labels: args.labels } : {}),
      ...(args.log_name !== undefined ? { log_name: args.log_name } : {}),
      ...(args.work_dir !== undefined ? { work_dir: args.work_dir } : {}),
      ...(args.task_before !== undefined ? { task_before: args.task_before } : {}),
      ...(args.task_after !== undefined ? { task_after: args.task_after } : {}),
      ...(args.allow_multiple_instances !== undefined ? { allow_multiple_instances: args.allow_multiple_instances ? 1 : 0 } : {}),
    };
    const result = await request(config, { method: "PUT", path: "/open/crons", body });
    return text({
      updated: true,
      response: result.data ?? null,
      note: "Whole-record submit: fields you did not restate reverted to defaults. Re-read with qinglong_task_get to verify.",
    });
  }

  if (name === "qinglong_task_action") {
    const ids = (args.ids ?? []).map(Number);
    if (!ids.length || ids.some((id) => !Number.isFinite(id))) throw new ApiError("ids must be a non-empty array of numbers.");
    const action = String(args.action);
    if (!["run", "stop", "enable", "disable", "pin", "unpin"].includes(action)) {
      throw new ApiError("action must be run, stop, enable, disable, pin or unpin.");
    }
    const result = await request(config, { method: "PUT", path: `/open/crons/${action}`, body: ids });
    const notes = {
      run: "Requests submitted — accepted≠success. Judge by qinglong_task_instances and the log text; the newest log may be from the previous run.",
      stop: "Stop requested.",
      enable: "Enabled (schedule resumed; nothing is deleted).",
      disable: "Disabled (schedule paused; nothing is deleted).",
      pin: "Pinned.",
      unpin: "Unpinned.",
    };
    return text({ action, ids, response: result.data ?? null, note: notes[action] });
  }

  if (name === "qinglong_task_logs") {
    const id = Number(args.id);
    if (!Number.isFinite(id)) throw new ApiError("id must be a number.");
    const query = {};
    if (args.offset !== undefined) query.offset = String(args.offset);
    if (args.limit !== undefined) query.limit = String(Math.min(Number(args.limit), 1048576));
    if (args.tail !== undefined) query.tail = String(Boolean(args.tail));
    else if (args.offset === undefined) query.tail = "true";
    const result = await request(config, { method: "GET", path: `/open/crons/${id}/log`, query });
    const envelope = result.envelope ?? {};
    return text(
      `${String(result.data ?? "")}\n\n-- meta: ${JSON.stringify({
        logStatus: envelope.logStatus,
        offset: envelope.offset,
        nextOffset: envelope.nextOffset,
        total: envelope.total,
        truncated: envelope.truncated,
      })}`,
    );
  }

  if (name === "qinglong_task_instances") {
    const id = Number(args.id);
    if (!Number.isFinite(id)) throw new ApiError("id must be a number.");
    const result = await request(config, { method: "GET", path: `/open/crons/${id}/instances` });
    const rows = listOf(result.data);
    return text({
      returned: rows.length,
      instances: rows,
      note: rows.some((row) => row.status === "running" || row.elapsed !== undefined)
        ? "Running entries are still in flight; elapsed is seconds."
        : "Newest first. An empty list means this task has no recorded instance — the run may not have started.",
    });
  }

  if (name === "qinglong_envs_list") {
    const result = await request(config, { method: "GET", path: "/open/envs", query: args.search ? { searchValue: args.search } : {} });
    const rows = listOf(result.data);
    return text({ returned: rows.length, envs: rows, note: "Values may be sensitive — mask before quoting." });
  }

  if (name === "qinglong_env_create") {
    const entries = Array.isArray(args.entries) ? args.entries : [];
    if (!entries.length) throw new ApiError("entries must be a non-empty array.");
    for (const entry of entries) {
      if (!entry?.name || entry?.value === undefined) throw new ApiError("every entry needs name and value.");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(entry.name))) {
        throw new ApiError(`invalid env name "${entry.name}": letter/underscore start, then letters, digits, underscores.`);
      }
    }
    const result = await request(config, { method: "POST", path: "/open/envs", body: entries });
    return text({ created: entries.length, response: result.data ?? null, note: "Creation never updates existing rows by id (import is create-only). Re-read with qinglong_envs_list." });
  }

  if (name === "qinglong_env_update") {
    const body = {
      id: Number(args.id),
      name: args.name,
      value: args.value,
      ...(args.remarks !== undefined ? { remarks: args.remarks } : {}),
      ...(args.labels !== undefined ? { labels: args.labels } : {}),
    };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(body.name))) {
      throw new ApiError(`invalid env name "${body.name}": letter/underscore start, then letters, digits, underscores.`);
    }
    const result = await request(config, { method: "PUT", path: "/open/envs", body });
    return text({ updated: true, response: result.data ?? null, note: "Whole-record submit (id+name+value were all restated). Re-read with qinglong_envs_list." });
  }

  if (name === "qinglong_env_delete") {
    if (args.confirm !== true) throw new ApiError("Refusing to delete without confirm:true.");
    const ids = (args.ids ?? []).map(Number);
    if (!ids.length || ids.some((id) => !Number.isFinite(id))) throw new ApiError("ids must be a non-empty array of numbers.");
    const result = await request(config, { method: "DELETE", path: "/open/envs", body: ids });
    return text({ deleted: ids.length, ids, response: result.data ?? null });
  }

  if (name === "qinglong_subscriptions_list") {
    const query = {};
    if (args.search) query.searchValue = args.search;
    if (args.ids) query.ids = args.ids;
    const result = await request(config, { method: "GET", path: "/open/subscriptions", query });
    const rows = listOf(result.data);
    return text({ returned: rows.length, subscriptions: rows });
  }

  if (name === "qinglong_subscription_create") {
    const body = {
      type: args.type,
      url: args.url,
      alias: args.alias,
      schedule_type: args.schedule_type,
      ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      ...(args.whitelist !== undefined ? { whitelist: args.whitelist } : {}),
      ...(args.blacklist !== undefined ? { blacklist: args.blacklist } : {}),
      ...(args.dependences !== undefined ? { dependences: args.dependences } : {}),
      ...(args.proxy !== undefined ? { proxy: args.proxy } : {}),
      ...(args.extra && typeof args.extra === "object" ? args.extra : {}),
    };
    if (body.interval_schedule && Number(body.interval_schedule.value) < 1) {
      throw new ApiError("interval_schedule.value must be >= 1.");
    }
    const result = await request(config, { method: "POST", path: "/open/subscriptions", body });
    return text({
      created: true,
      response: result.data ?? null,
      next_step: "Trigger a pull with qinglong_subscription_action run, then read the log (GET /open/subscriptions/:id/log) and confirm the files appeared in the script directory.",
    });
  }

  if (name === "qinglong_subscription_action") {
    const ids = (args.ids ?? []).map(Number);
    if (!ids.length || ids.some((id) => !Number.isFinite(id))) throw new ApiError("ids must be a non-empty array of numbers.");
    const action = String(args.action);
    if (!["run", "stop", "enable", "disable"].includes(action)) throw new ApiError("action must be run, stop, enable or disable.");
    const result = await request(config, { method: "PUT", path: `/open/subscriptions/${action}`, body: ids });
    return text({
      action,
      ids,
      response: result.data ?? null,
      note: action === "run" ? "Pull requested — accepted≠usable: confirm the scripts actually landed." : undefined,
    });
  }

  if (name === "qinglong_dependencies_list") {
    const query = {};
    if (args.search) query.searchValue = args.search;
    if (args.type) query.type = args.type;
    if (args.status) query.status = args.status;
    const result = await request(config, { method: "GET", path: "/open/dependencies", query });
    const rows = listOf(result.data).map((row) => ({
      ...row,
      type_name: DEPENDENCY_TYPES[row.type] ?? row.type,
      status_name: DEPENDENCY_STATUS[row.status] ?? row.status,
    }));
    return text({ returned: rows.length, dependencies: rows });
  }

  if (name === "qinglong_dependency_install") {
    const entries = Array.isArray(args.entries) ? args.entries : [];
    if (!entries.length) throw new ApiError("entries must be a non-empty array.");
    const body = entries.map((entry) => {
      if (!entry?.name || entry?.type === undefined) throw new ApiError("every entry needs name and type.");
      const raw = String(entry.type).toLowerCase();
      const code = /^\d+$/.test(raw) ? Number(raw) : DEPENDENCY_TYPE_CODES[raw];
      if (code === undefined) throw new ApiError(`unknown dependency type "${entry.type}". Use nodejs, python3, linux or 0/1/2.`);
      return { name: entry.name, type: code, ...(entry.remark !== undefined ? { remark: entry.remark } : {}) };
    });
    const result = await request(config, { method: "POST", path: "/open/dependencies", body });
    return text({
      queued: body.length,
      response: result.data ?? null,
      note: "Queued ≠ installed: poll qinglong_dependencies_list until status is 1 (installed); failures show status 2 and detail in the install log.",
    });
  }

  if (name === "qinglong_log_read") {
    const query = { file: args.file };
    if (args.path) query.path = args.path;
    if (args.offset !== undefined) query.offset = String(args.offset);
    if (args.limit !== undefined) query.limit = String(Math.min(Number(args.limit), 1048576));
    if (args.tail !== undefined) query.tail = String(Boolean(args.tail));
    const result = await request(config, { method: "GET", path: "/open/logs/detail", query });
    const envelope = result.envelope ?? {};
    return text(
      `${String(result.data ?? "")}\n\n-- meta: ${JSON.stringify({
        offset: envelope.offset,
        nextOffset: envelope.nextOffset,
        total: envelope.total,
        truncated: envelope.truncated,
        logStatus: envelope.logStatus,
      })}`,
    );
  }

  if (name === "qinglong_dashboard") {
    const views = {
      overview: "/open/dashboard/overview",
      trend: "/open/dashboard/trend",
      "top-time": "/open/dashboard/top-time",
      "top-count": "/open/dashboard/top-count",
      runtime: "/open/dashboard/runtime",
      labels: "/open/dashboard/labels",
      system: "/open/dashboard/system",
      successes: "/open/dashboard/successes",
      failures: "/open/dashboard/failures",
    };
    const path = views[args.view];
    if (!path) throw new ApiError(`Unknown view "${args.view}".`);
    const query = args.view === "trend" && args.days !== undefined ? { days: String(args.days) } : {};
    const result = await request(config, { method: "GET", path, query });
    return text(result.data ?? null);
  }

  throw new ApiError(`Unknown tool "${name}".`);
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message ?? {};
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        const result = await callTool(name, args);
        reply(id, result);
      } catch (error) {
        // Tool failures are results, not protocol errors: the model needs the message.
        const message = error instanceof ApiError || error instanceof UsageError ? error.message : `Unexpected error: ${error?.message ?? error}`;
        reply(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`ignoring malformed JSON-RPC line: ${trimmed.slice(0, 200)}\n`);
    return;
  }
  // Serialize handling so replies keep request order.
  queue = queue.then(() => handle(message)).catch((error) => process.stderr.write(`handler error: ${error?.stack ?? error}\n`));
});
rl.on("close", () => {
  queue.finally(() => process.exit(0));
});

if (missingConfig) {
  process.stderr.write(`${SERVER_NAME}: ${CONFIG_HINT}\n`);
}
process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready: ${TOOLS.length} tools, ${routeStats().total} routes indexed${missingConfig ? " (unconfigured)" : ""}\n`);
