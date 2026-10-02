#!/usr/bin/env node
// qinglong-admin — full-surface command line client for a Qinglong (青龙 2.x) panel.
//
// Design notes that matter when reading this file:
//   * Every command is a thin wrapper over one documented HTTP route. `qinglong-admin api
//     request` reaches every route that has no typed command, so coverage is complete by
//     construction rather than by enumeration.
//   * Destructive commands refuse to run without --yes (see lib/routes.mjs for which routes
//     are destructive). --dry-run prints the exact request and sends nothing.
//   * Output defaults to a compact human summary; --json prints the raw response `data`.
//   * Credentials: QL_ACCESS_TOKEN, or QL_CLIENT_ID + QL_CLIENT_SECRET (same names as the
//     official ql CLI, so one shell profile configures both).
//
// Node builtins only. Node >= 18 (global fetch, FormData, Blob).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";

import {
  ApiError,
  DEPENDENCY_STATUS,
  DEPENDENCY_TYPES,
  DEPENDENCY_TYPE_CODES,
  SCOPES,
  SCOPE_PROBE_ROUTES,
  UsageError,
  assertConfigured,
  authMode,
  buildHeaders,
  buildUrl,
  ensureToken,
  flagBool,
  flagInt,
  flagList,
  formatMillis,
  formatSeconds,
  formatTable,
  isoToUnix,
  parseArgs,
  parsePairs,
  pickDefined,
  printJson,
  readJsonArg,
  readJsonFile,
  redactConfig,
  request,
  resetTokenCache,
  resolveConfig,
} from "../lib/core.mjs";
import { EXTRAS, findRoutes, isDestructive, matchRoute, routeStats } from "../lib/routes.mjs";

const VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Global flag handling
// ---------------------------------------------------------------------------

function extractConfig(argv) {
  const { positionals, flags } = parseArgs(argv);
  const config = resolveConfig({
    flags: {
      url: flags["panel-url"],
      token: flags.token,
      clientId: flags["client-id"],
      clientSecret: flags["client-secret"],
      timeout: flags.timeout,
      config: flags.config,
    },
  });
  return { positionals, flags, config };
}

async function main() {
  const argv = process.argv.slice(2);

  const wantsHelp = argv.length === 0 || argv[0] === "help" || argv.includes("--help") || argv.includes("-h");
  if (wantsHelp) {
    const topic = argv[0] === "help" ? argv[1] : argv[0]?.startsWith("-") ? undefined : argv[0];
    process.stdout.write(usage(topic));
    return 0;
  }
  if (argv[0] === "version" || argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const { positionals, flags, config } = extractConfig(argv);
  const [group, action, ...rest] = positionals;

  if (group === "routes") return cmdRoutes(rest, flags);
  if (group === "config") {
    printJson(redactConfig(config));
    return 0;
  }

  assertConfigured(config);

  const ctx = {
    config,
    flags,
    json: Boolean(flags.json),
    dryRun: Boolean(flags["dry-run"]),
    yes: Boolean(flags.yes),
  };

  switch (group) {
    case "status":
    case "ping":
      return cmdStatus(ctx, action, rest);
    case "api":
      return cmdApi(ctx, [action, ...rest]);
    case "task":
    case "cron":
      return cmdTask(ctx, action, rest);
    case "env":
      return cmdEnv(ctx, action, rest);
    case "sub":
    case "subscription":
      return cmdSubscription(ctx, action, rest);
    case "log":
      return cmdLog(ctx, action, rest);
    case "dep":
    case "dependency":
      return cmdDependency(ctx, action, rest);
    case "script":
      return cmdScript(ctx, action, rest);
    case "configs":
      return cmdConfigs(ctx, action, rest);
    case "system":
      return cmdSystem(ctx, action, rest);
    case "dashboard":
      return cmdDashboard(ctx, action, rest);
    case "app":
    case "apps":
      return cmdApp(ctx, action, rest);
    case "user":
      return cmdUser(ctx, action, rest);
    default:
      throw new UsageError(`unknown command group "${group}". Run \`qinglong-admin help\`.`);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emit(ctx, result, { table, summary, columns, meta } = {}) {
  if (ctx.dryRun) return;
  if (ctx.json) {
    printJson(result.data === undefined ? result.envelope ?? result : result.data);
    return;
  }
  if (summary) process.stdout.write(`${summary}\n`);
  if (table) {
    const rows = Array.isArray(table) ? table : table.rows ?? [];
    process.stdout.write(`${formatTable(rows, columns ?? table.columns ?? [])}\n`);
  } else if (!summary) {
    const value = result.data;
    if (value === undefined || value === null || value === "") process.stdout.write("ok\n");
    else if (typeof value === "object") printJson(value);
    else process.stdout.write(`${value}\n`);
  }
  if (meta) printJson(meta);
}

async function call(ctx, options) {
  const described = {
    method: (options.method ?? "GET").toUpperCase(),
    path: options.path,
    query: pickDefined(options.query ?? {}),
    body: options.body,
  };
  if (ctx.dryRun) {
    printJson({ dryRun: true, url: `${ctx.config.baseUrl}${described.path}`, ...described });
    return { data: undefined, dryRun: true };
  }
  const destructive = options.destructive ?? isDestructive(described.method, described.path);
  if (destructive && !ctx.yes) {
    const route = matchRoute(described.method, described.path);
    throw new UsageError(
      `refusing to run a destructive request without --yes: ${described.method} ${described.path}` +
        (route ? ` (${route.purpose})` : "") +
        `\nAdd --yes to confirm, or --dry-run to inspect the request first.`,
    );
  }
  return request(ctx.config, { method: described.method, path: described.path, query: described.query, body: described.body, allowText: Boolean(options.allowText) });
}

function requireYes(ctx, label) {
  if (ctx.yes || ctx.dryRun) return;
  throw new UsageError(`${label} is irreversible. Re-run with --yes to confirm, or --dry-run to inspect first.`);
}

/** Collect IDs from positionals plus an optional comma-separated --ids flag. */
function idsFrom(rest, flags) {
  const ids = [...rest, ...(flagList(flags.ids) ?? [])].map((value) => Number(value));
  if (!ids.length) throw new UsageError("at least one ID is required (positional or --ids 1,2)");
  if (ids.some((id) => !Number.isFinite(id))) throw new UsageError(`IDs must be numbers: ${rest.join(" ")} ${flags.ids ?? ""}`);
  return ids;
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

/** POST multipart/form-data (env upload, script upload, data import, avatar). */
async function postForm(ctx, { path, fields = {}, file, fileField, method = "POST" }) {
  if (ctx.dryRun) {
    printJson({ dryRun: true, url: `${ctx.config.baseUrl}${path}`, method, multipart: { fields, file: file?.name ?? null, fileField } });
    return { data: undefined, dryRun: true };
  }
  const token = await ensureToken(ctx.config);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  if (file) form.append(fileField, new Blob([readFileSync(file)]), basename(file));
  const response = await fetch(buildUrl(ctx.config.baseUrl, path), {
    method,
    headers: buildHeaders(ctx.config, token),
    body: form,
    signal: AbortSignal.timeout(ctx.config.timeoutMs),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`, { status: response.status });
  }
  if (Number(parsed.code) !== 200) {
    throw new ApiError(String(parsed.message ?? `HTTP ${response.status}`), { status: response.status, code: parsed.code, body: parsed });
  }
  return { status: response.status, data: parsed.data, envelope: parsed };
}

/** Stream a download to a file. Refuses to overwrite, like the official CLI. */
async function downloadToFile(ctx, { method = "POST", path, body, query, output }) {
  if (ctx.dryRun) {
    printJson({ dryRun: true, url: `${ctx.config.baseUrl}${path}`, method, query: pickDefined(query ?? {}), body, output });
    return { data: undefined, dryRun: true };
  }
  if (!output) throw new UsageError("--output <file> is required for downloads");
  if (existsSync(output)) throw new UsageError(`refusing to overwrite ${output}; choose another path`);
  const token = await ensureToken(ctx.config);
  const response = await fetch(buildUrl(ctx.config.baseUrl, path, query), {
    method,
    headers: buildHeaders(ctx.config, token, body === undefined ? {} : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.config.timeoutMs),
  });
  const contentType = String(response.headers.get("content-type") ?? "");
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(await response.text());
    if (Number(parsed.code) !== 200) {
      throw new ApiError(String(parsed.message ?? `HTTP ${response.status}`), { status: response.status, code: parsed.code, body: parsed });
    }
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(output, buffer);
  return { bytes: buffer.length, output };
}

function pageQuery(flags, extra = {}) {
  return pickDefined({
    page: flagInt(flags.page, "page"),
    size: flagInt(flags.size, "size"),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// status / routes / api
// ---------------------------------------------------------------------------

async function cmdStatus(ctx, action, rest) {
  const scope = ctx.flags.scope ? String(ctx.flags.scope) : undefined;
  const allScopes = Boolean(ctx.flags.scopes);
  if (scope || allScopes) {
    const want = allScopes ? SCOPES : [scope];
    const rows = [];
    for (const name of want) {
      const probe = SCOPE_PROBE_ROUTES[name];
      if (!probe) throw new UsageError(`unknown scope "${name}". Known: ${SCOPES.join(", ")}`);
      try {
        await call(ctx, { ...probe });
        rows.push({ scope: name, result: "ok", message: "" });
      } catch (error) {
        if (ctx.dryRun) return 0;
        rows.push({ scope: name, result: "denied", message: error.message.split("\n")[0] });
      }
    }
    emit(ctx, { data: rows }, {
      table: rows,
      columns: [
        { key: "scope", label: "scope", width: 16 },
        { key: "result", label: "result", width: 8 },
        { key: "message", label: "message", width: 60 },
      ],
      summary: `auth=${authMode(ctx.config)} url=${ctx.config.baseUrl}`,
    });
    return 0;
  }
  const health = await call(ctx, { method: "GET", path: "/open/health" });
  const system = await call(ctx, { method: "GET", path: "/open/system" });
  const data = system.data ?? {};
  emit(ctx, { data: { health: health.data ?? null, system: data }, envelope: system.envelope }, {
    summary: [
      `url:     ${ctx.config.baseUrl}`,
      `auth:    ${authMode(ctx.config)}`,
      `version: ${data.version ?? "?"} (${data.branch ?? "?"})`,
      `initialized: ${data.isInitialized ?? "?"}`,
      `health:  ${health.data === undefined ? "ok" : JSON.stringify(health.data)}`,
    ].join("\n"),
  });
  return 0;
}

function cmdRoutes(positionals, flags) {
  const term = positionals[0];
  const matches = findRoutes(term);
  if (flags.json) {
    printJson({ total: routeStats().total, returned: matches.length, routes: matches });
    return 0;
  }
  const stats = routeStats();
  const lines = matches.map((route) => {
    const scope = route.scope ?? "-";
    return `${route.method.padEnd(6)} ${route.path.padEnd(52)} ${scope.padEnd(14)} ${route.purpose}${route.destructive ? "  [destructive]" : ""}`;
  });
  process.stdout.write(`${matches.length} of ${stats.total} routes (${stats.groups} groups, ${stats.destructive} destructive)\n\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
  const extra = EXTRAS.filter((route) => !term || `${route.path} ${route.purpose}`.toLowerCase().includes(String(term).toLowerCase()));
  if (extra.length) {
    process.stdout.write(`\nnot in the 143-route CLI index, but served by the panel:\n`);
    for (const route of extra) process.stdout.write(`  ${route.method} ${route.path}  ${route.purpose}\n`);
  }
  return 0;
}

async function cmdApi(ctx, args) {
  const [sub, ...rest] = args;
  if (sub !== "request") throw new UsageError(`unknown api subcommand "${sub ?? ""}". Use \`api request <METHOD> <path>\`.`);
  const [method, path, ...extraPositionals] = rest;
  if (!method || !path) throw new UsageError("api request needs <METHOD> <path>, e.g. `api request GET /open/crons`");
  if (extraPositionals.length) throw new UsageError(`unexpected arguments: ${extraPositionals.join(" ")}`);
  const query = parsePairs(Array.isArray(ctx.flags.query) ? ctx.flags.query : ctx.flags.query !== undefined ? [ctx.flags.query] : [], "query");
  const body = readJsonArg(ctx.flags.data, { flagName: "data" });
  const result = await call(ctx, { method, path, query, body, allowText: true });
  if (result.dryRun) return 0;
  if (result.nonJson) {
    process.stdout.write(`${result.text.slice(0, 100000)}\n`);
    return 0;
  }
  emit(ctx, result, { summary: result.message || undefined });
  return 0;
}

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

const TASK_TABLE = [
  { key: "id", label: "ID", width: 6 },
  { get: (row) => row.name ?? "", label: "name", width: 22 },
  { get: (row) => String(row.command ?? "").replace(/\s+/g, " "), label: "command", width: 26 },
  { key: "schedule", label: "schedule", width: 14 },
  { get: (row) => (Number(row.isDisabled) === 1 ? "disabled" : row.status ?? "enabled"), label: "status", width: 14 },
  { get: (row) => (row.last_running_time ? formatSeconds(Math.floor(Date.now() / 1000 - Number(row.last_running_time))) + " ago" : ""), label: "last run", width: 12 },
];

async function cmdTask(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "list": {
      const query = pageQuery(ctx.flags, {
        searchValue: ctx.flags.search ?? ctx.flags.q,
        status: ctx.flags.status,
        type: ctx.flags.type,
      });
      const result = await call(ctx, { method: "GET", path: "/open/crons", query });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, {
        table: rows,
        columns: TASK_TABLE,
        summary: result.dryRun ? undefined : `tasks: ${rows.length}${result.data?.total !== undefined ? ` of ${result.data.total}` : ""}`,
      });
      return 0;
    }
    case "get": {
      const id = rest[0];
      if (!id) throw new UsageError("task get needs <id>, or use `task find <keyword>`");
      if (/^\d+$/.test(id)) {
        const result = await call(ctx, { method: "GET", path: `/open/crons/${id}` });
        emit(ctx, result);
        return 0;
      }
      return cmdTask(ctx, "find", rest);
    }
    case "find": {
      const keyword = rest.join(" ");
      if (!keyword) throw new UsageError("task find needs a keyword");
      const result = await call(ctx, { method: "GET", path: "/open/crons", query: { searchValue: keyword, page: 1, size: 100 } });
      const rows = unwrapList(result.data).filter((row) => String(row.name ?? "").includes(keyword) || String(row.command ?? "").includes(keyword));
      emit(ctx, { ...result, data: rows }, { table: rows, columns: TASK_TABLE, summary: `matches: ${rows.length} (IDs ready to reuse)` });
      return 0;
    }
    case "create": {
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({
          name: ctx.flags.name,
          command: ctx.flags.command,
          schedule: ctx.flags.schedule ?? ctx.flags.cron,
          labels: flagList(ctx.flags.label ?? ctx.flags.labels),
          log_name: ctx.flags["log-name"],
          work_dir: ctx.flags["work-dir"],
          task_before: ctx.flags["task-before"],
          task_after: ctx.flags["task-after"],
          allow_multiple_instances: ctx.flags["allow-multiple-instances"] === undefined ? undefined : (flagBool(ctx.flags["allow-multiple-instances"]) ? 1 : 0),
        }),
      };
      if (!body.command) throw new UsageError("task create needs --command (e.g. --command 'task demo.js')");
      if (!body.schedule) throw new UsageError("task create needs --schedule (a cron expression, e.g. '0 9 * * *')");
      const result = await call(ctx, { method: "POST", path: "/open/crons", body });
      emit(ctx, result, {
        summary: ctx.dryRun ? undefined : `created. Re-read with \`task find ${body.name ?? ""}\` to capture the real ID, then \`task run <id>\` — accepted only means submitted.`,
      });
      return 0;
    }
    case "update": {
      const id = rest[0];
      if (!id || !/^\d+$/.test(id)) throw new UsageError("task update needs a numeric <id> (find it with `task find <keyword>` first)");
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({
          command: ctx.flags.command,
          schedule: ctx.flags.schedule ?? ctx.flags.cron,
          name: ctx.flags.name,
          labels: flagList(ctx.flags.label ?? ctx.flags.labels),
          log_name: ctx.flags["log-name"],
          work_dir: ctx.flags["work-dir"],
          task_before: ctx.flags["task-before"],
          task_after: ctx.flags["task-after"],
          allow_multiple_instances: ctx.flags["allow-multiple-instances"] === undefined ? undefined : (flagBool(ctx.flags["allow-multiple-instances"]) ? 1 : 0),
        }),
      };
      // The route replaces the whole record: command and schedule must both be present.
      // A --data payload that already carries them is trusted as the full submission.
      if (!body.command || !body.schedule) {
        throw new UsageError(
          "task update replaces the whole record and does not merge: pass both --command and --schedule " +
            "(or a --data payload that includes both). Read the current values with `task get <id>` first.",
        );
      }
      const result = await call(ctx, { method: "PUT", path: "/open/crons", body: { ...body, id: Number(id) } });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "updated (whole-record submit). Re-read with `task get <id>` to verify." });
      return 0;
    }
    case "run":
    case "stop":
    case "enable":
    case "disable":
    case "pin":
    case "unpin": {
      const ids = idsFrom(rest, ctx.flags);
      const result = await call(ctx, { method: "PUT", path: `/open/crons/${action}`, body: ids });
      const notes = {
        run: `${ids.length} run request(s) submitted. accepted≠success: judge by instances and the log content (task instances <id>, task logs <id>); the newest log may belong to the previous run.`,
        stop: `${ids.length} stop request(s) sent.`,
        enable: `${ids.length} task(s) enabled.`,
        disable: `${ids.length} task(s) disabled (schedules pause; nothing is deleted).`,
        pin: `${ids.length} task(s) pinned.`,
        unpin: `${ids.length} task(s) unpinned.`,
      };
      emit(ctx, result, { summary: ctx.dryRun ? undefined : notes[action] });
      return 0;
    }
    case "logs": {
      const id = rest[0];
      if (!id) throw new UsageError("task logs needs <id> (task IDs come from `task list`)");
      const query = pickDefined({
        offset: flagInt(ctx.flags.offset, "offset"),
        limit: flagInt(ctx.flags.limit, "limit"),
        tail: ctx.flags.tail === undefined ? (ctx.flags.offset === undefined ? true : undefined) : flagBool(ctx.flags.tail),
      });
      const result = await call(ctx, { method: "GET", path: `/open/crons/${id}/log`, query });
      if (result.dryRun) return 0;
      const envelope = result.envelope ?? {};
      const meta = {
        logStatus: envelope.logStatus,
        offset: envelope.offset,
        nextOffset: envelope.nextOffset,
        total: envelope.total,
        truncated: envelope.truncated,
      };
      if (ctx.json) {
        printJson({ data: result.data ?? "", ...meta });
        return 0;
      }
      process.stdout.write(`${String(result.data ?? "")}\n`);
      process.stdout.write(`-- ${JSON.stringify(meta)}\n`);
      return 0;
    }
    case "instances": {
      const id = rest[0];
      if (!id) throw new UsageError("task instances needs <id>");
      const result = await call(ctx, { method: "GET", path: `/open/crons/${id}/instances`, query: pageQuery(ctx.flags) });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, {
        table: rows,
        columns: [
          { get: (row) => row.instanceId ?? row.id ?? "", label: "instance", width: 12 },
          { get: (row) => row.status ?? "", label: "status", width: 10 },
          { get: (row) => (row.startedAt ? String(row.startedAt) : row.startTime ?? ""), label: "started", width: 20 },
          { get: (row) => (row.elapsed !== undefined ? formatSeconds(row.elapsed) : ""), label: "elapsed", width: 10 },
        ],
        summary: rows.length ? `${rows.length} instance(s); running entries show elapsed in seconds` : "no instances recorded",
      });
      return 0;
    }
    case "instance-stop": {
      if (rest.length < 2) throw new UsageError("task instance-stop needs <taskId> <instanceId>");
      const result = await call(ctx, { method: "POST", path: `/open/crons/${rest[0]}/instances/${rest[1]}/stop` });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : `instance ${rest[1]} of task ${rest[0]} stop requested` });
      return 0;
    }
    case "log-files": {
      const id = rest[0];
      if (!id) throw new UsageError("task log-files needs <id>");
      const result = await call(ctx, { method: "GET", path: `/open/crons/${id}/logs` });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, {
        table: rows,
        columns: [
          { get: (row) => (typeof row === "string" ? row : row.filename ?? row.path ?? JSON.stringify(row)), label: "log file", width: 60 },
        ],
        summary: `${rows.length} log file(s). Read one with \`log get --file <file> --tail\`.`,
      });
      return 0;
    }
    default:
      throw new UsageError(`unknown task subcommand "${action}". Run \`qinglong-admin help task\`.`);
  }
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

const ENV_TABLE = [
  { key: "id", label: "ID", width: 6 },
  { key: "name", label: "name", width: 24 },
  { get: (row) => (String(row.value ?? "").length > 32 ? `${String(row.value).slice(0, 32)}…` : row.value ?? ""), label: "value", width: 34 },
  { get: (row) => (row.remarks ?? row.remark ?? ""), label: "remarks", width: 18 },
  { get: (row) => (row.labels ?? []).join(","), label: "labels", width: 14 },
];

function assertEnvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name ?? ""))) {
    throw new UsageError(`invalid env name "${name}": it must start with a letter or underscore and contain only letters, digits and underscores`);
  }
}

async function cmdEnv(ctx, action, rest) {
  const idsFor = (names) => {
    const ids = [...rest, ...(flagList(ctx.flags.ids) ?? [])].map(Number);
    if (!ids.length) throw new UsageError(`${names} needs at least one ID`);
    return ids;
  };
  switch (action) {
    case undefined:
    case "list": {
      const result = await call(ctx, { method: "GET", path: "/open/envs", query: { searchValue: ctx.flags.search ?? ctx.flags.q } });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, { table: rows, columns: ENV_TABLE, summary: `envs: ${rows.length} (values may be sensitive — mask before sharing)` });
      return 0;
    }
    case "get": {
      const id = rest[0];
      if (!id) throw new UsageError("env get needs <id>");
      const result = await call(ctx, { method: "GET", path: `/open/envs/${id}` });
      emit(ctx, result);
      return 0;
    }
    case "create": {
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      let body;
      if (data !== undefined) {
        body = Array.isArray(data) ? data : [data];
      } else {
        if (!ctx.flags.name || ctx.flags.value === undefined) throw new UsageError("env create needs --name and --value (or --data '[{...}]')");
        assertEnvName(ctx.flags.name);
        body = [pickDefined({ name: ctx.flags.name, value: ctx.flags.value, remarks: ctx.flags.remarks, labels: flagList(ctx.flags.labels) })];
      }
      for (const entry of body) {
        if (!entry?.name || entry?.value === undefined) throw new UsageError("every env entry needs name and value");
        assertEnvName(entry.name);
      }
      const result = await call(ctx, { method: "POST", path: "/open/envs", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : `created ${body.length} env(s). Upload does not update existing rows by id; re-read with \`env list --search\`.` });
      return 0;
    }
    case "update": {
      const id = rest[0];
      if (!id) throw new UsageError("env update needs <id> (whole-record submit: --name and --value are required)");
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({ name: ctx.flags.name, value: ctx.flags.value, remarks: ctx.flags.remarks, labels: flagList(ctx.flags.labels) }),
        id: Number(id),
      };
      if (!body.name || body.value === undefined) {
        throw new UsageError("env update requires id + name + value (it is not a patch; it cannot change only labels). Read the row with `env get <id>` first.");
      }
      assertEnvName(body.name);
      const result = await call(ctx, { method: "PUT", path: "/open/envs", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "updated (whole-record submit). Re-read with `env get <id>` to verify." });
      return 0;
    }
    case "delete": {
      const ids = idsFor("env delete");
      requireYes(ctx, `deleting ${ids.length} env var(s)`);
      const result = await call(ctx, { method: "DELETE", path: "/open/envs", body: ids, destructive: true });
      emit(ctx, result, { summary: `${ids.length} env(s) deleted` });
      return 0;
    }
    case "enable":
    case "disable":
    case "pin":
    case "unpin": {
      const ids = idsFor(`env ${action}`);
      const result = await call(ctx, { method: "PUT", path: `/open/envs/${action}`, body: ids });
      emit(ctx, result, { summary: `${ids.length} env(s) ${action === "pin" ? "pinned" : action === "unpin" ? "unpinned" : action + "d"}` });
      return 0;
    }
    case "rename": {
      const ids = flagList(ctx.flags.ids);
      const name = ctx.flags.name;
      if (!ids?.length || !name) throw new UsageError("env rename needs --ids 1,2 --name NEW_NAME");
      assertEnvName(name);
      const result = await call(ctx, { method: "PUT", path: "/open/envs/name", body: { ids: ids.map(Number), name } });
      emit(ctx, result, { summary: `${ids.length} env(s) renamed` });
      return 0;
    }
    case "move": {
      const id = rest[0];
      if (!id) throw new UsageError("env move needs <id> --from N --to M");
      const fromIndex = flagInt(ctx.flags.from, "from");
      const toIndex = flagInt(ctx.flags.to, "to");
      if (fromIndex === undefined || toIndex === undefined) throw new UsageError("env move needs --from and --to");
      const result = await call(ctx, { method: "PUT", path: `/open/envs/${id}/move`, body: { fromIndex, toIndex } });
      emit(ctx, result, { summary: "moved" });
      return 0;
    }
    case "labels-add":
    case "labels-delete": {
      const ids = flagList(ctx.flags.ids)?.map(Number);
      const labels = flagList(ctx.flags.labels);
      if (!ids?.length || !labels?.length) throw new UsageError(`env ${action} needs --ids 1,2 --labels a,b`);
      const method = action === "labels-add" ? "POST" : "DELETE";
      if (method === "DELETE") requireYes(ctx, `deleting labels ${labels.join(",")}`);
      const result = await call(ctx, { method, path: "/open/envs/labels", body: { ids, labels }, destructive: method === "DELETE" });
      emit(ctx, result, { summary: `labels ${action === "labels-add" ? "added" : "removed"} on ${ids.length} env(s)` });
      return 0;
    }
    case "upload": {
      const file = ctx.flags.file;
      if (!file) throw new UsageError("env upload needs --file <json file>");
      const result = await postForm(ctx, { path: "/open/envs/upload", fields: {}, file, fileField: "env" });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : `uploaded ${file}: creates new rows only, never updates by id` });
      return 0;
    }
    default:
      throw new UsageError(`unknown env subcommand "${action}". Run \`qinglong-admin help env\`.`);
  }
}

// ---------------------------------------------------------------------------
// subscription
// ---------------------------------------------------------------------------

const SUB_TABLE = [
  { key: "id", label: "ID", width: 6 },
  { get: (row) => row.name ?? row.alias ?? "", label: "name", width: 22 },
  { key: "type", label: "type", width: 16 },
  { get: (row) => row.schedule ?? (row.interval_schedule ? `${row.interval_schedule.type}:${row.interval_schedule.value}` : ""), label: "schedule", width: 18 },
  { get: (row) => row.url ?? "", label: "url", width: 40 },
];

async function cmdSubscription(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "list": {
      const result = await call(ctx, { method: "GET", path: "/open/subscriptions", query: { searchValue: ctx.flags.search ?? ctx.flags.q, ids: ctx.flags.ids } });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, { table: rows, columns: SUB_TABLE, summary: `subscriptions: ${rows.length}` });
      return 0;
    }
    case "get": {
      const id = rest[0];
      if (!id) throw new UsageError("sub get needs <id>");
      const result = await call(ctx, { method: "GET", path: `/open/subscriptions/${id}` });
      emit(ctx, result);
      return 0;
    }
    case "create": {
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({
          type: ctx.flags.type,
          url: ctx.flags.url,
          alias: ctx.flags.alias,
          name: ctx.flags.name,
          schedule_type: ctx.flags["schedule-type"],
          schedule: ctx.flags.schedule,
          branch: ctx.flags.branch,
          whitelist: ctx.flags.whitelist,
          blacklist: ctx.flags.blacklist,
          dependences: ctx.flags.dependences,
          proxy: ctx.flags.proxy,
        }),
      };
      for (const required of ["type", "url", "alias", "schedule_type"]) {
        if (!body[required]) throw new UsageError(`sub create requires --${required.replace("_", "-")} (type/url/alias/schedule_type are all mandatory)`);
      }
      if (body.interval_schedule && Number(body.interval_schedule.value) < 1) {
        throw new UsageError("interval_schedule.value must be >= 1");
      }
      const result = await call(ctx, { method: "POST", path: "/open/subscriptions", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "created. Trigger a pull with `sub run <id>`, then read `sub logs <id>` to confirm files landed." });
      return 0;
    }
    case "update": {
      const id = rest[0];
      if (!id) throw new UsageError("sub update needs <id>");
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({
          type: ctx.flags.type,
          url: ctx.flags.url,
          alias: ctx.flags.alias,
          name: ctx.flags.name,
          schedule_type: ctx.flags["schedule-type"],
          schedule: ctx.flags.schedule,
          branch: ctx.flags.branch,
          whitelist: ctx.flags.whitelist,
          blacklist: ctx.flags.blacklist,
        }),
        id: Number(id),
      };
      for (const required of ["type", "url", "alias"]) {
        if (!body[required]) throw new UsageError(`sub update requires --${required} as well (update is not a patch: id + type + url + alias are mandatory)`);
      }
      const result = await call(ctx, { method: "PUT", path: "/open/subscriptions", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "updated. Re-read with `sub get <id>`." });
      return 0;
    }
    case "run":
    case "stop":
    case "enable":
    case "disable": {
      const ids = idsFrom(rest, ctx.flags);
      const result = await call(ctx, { method: "PUT", path: `/open/subscriptions/${action}`, body: ids });
      emit(ctx, result, { summary: `${ids.length} subscription(s) ${action === "run" ? "pull requested" : action + "d"}; pull accepted ≠ scripts usable — check the script directory and logs.` });
      return 0;
    }
    case "logs": {
      const id = rest[0];
      if (!id) throw new UsageError("sub logs needs <id>");
      const query = pickDefined({
        offset: flagInt(ctx.flags.offset, "offset"),
        limit: flagInt(ctx.flags.limit, "limit"),
        tail: ctx.flags.tail === undefined ? (ctx.flags.offset === undefined ? true : undefined) : flagBool(ctx.flags.tail),
      });
      const result = await call(ctx, { method: "GET", path: `/open/subscriptions/${id}/log`, query });
      if (result.dryRun) return 0;
      const envelope = result.envelope ?? {};
      const meta = { offset: envelope.offset, nextOffset: envelope.nextOffset, total: envelope.total, truncated: envelope.truncated };
      if (ctx.json) {
        printJson({ data: result.data ?? "", ...meta });
        return 0;
      }
      process.stdout.write(`${String(result.data ?? "")}\n`);
      process.stdout.write(`-- ${JSON.stringify(meta)}\n`);
      return 0;
    }
    case "log-files": {
      const id = rest[0];
      if (!id) throw new UsageError("sub log-files needs <id>");
      const result = await call(ctx, { method: "GET", path: `/open/subscriptions/${id}/logs` });
      emit(ctx, result);
      return 0;
    }
    default:
      throw new UsageError(`unknown sub subcommand "${action}". Run \`qinglong-admin help sub\`.`);
  }
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

async function cmdLog(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "list": {
      const result = await call(ctx, { method: "GET", path: "/open/logs" });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, {
        table: rows,
        columns: [{ get: (row) => (typeof row === "string" ? row : row.path ?? row.filename ?? row.name ?? JSON.stringify(row)), label: "path", width: 80 }],
        summary: `entries: ${rows.length}. Read one with \`log get --path <dir> --file <file> --tail\`.`,
      });
      return 0;
    }
    case "get": {
      const query = pickDefined({
        file: ctx.flags.file,
        path: ctx.flags.path,
        offset: flagInt(ctx.flags.offset, "offset"),
        limit: flagInt(ctx.flags.limit, "limit"),
        tail: ctx.flags.tail === undefined ? undefined : flagBool(ctx.flags.tail),
      });
      if (!query.file) throw new UsageError("log get needs --file (and usually --path)");
      const result = await call(ctx, { method: "GET", path: "/open/logs/detail", query });
      if (result.dryRun) return 0;
      const envelope = result.envelope ?? {};
      const meta = { offset: envelope.offset, nextOffset: envelope.nextOffset, total: envelope.total, truncated: envelope.truncated, logStatus: envelope.logStatus };
      if (ctx.json) {
        printJson({ data: result.data ?? "", ...meta });
        return 0;
      }
      process.stdout.write(`${String(result.data ?? "")}\n`);
      process.stdout.write(`-- ${JSON.stringify(meta)}\n`);
      return 0;
    }
    case "delete": {
      const filename = ctx.flags.file;
      if (!filename) throw new UsageError("log delete needs --file (the body field is filename, not file)");
      requireYes(ctx, `deleting log ${ctx.flags.path ? `${ctx.flags.path}/` : ""}${filename}`);
      const body = pickDefined({ filename, path: ctx.flags.path, type: ctx.flags.type });
      const result = await call(ctx, { method: "DELETE", path: "/open/logs", body, destructive: true });
      emit(ctx, result, { summary: `log ${filename} deleted` });
      return 0;
    }
    case "download": {
      const filename = ctx.flags.file;
      if (!filename) throw new UsageError("log download needs --file --output <path>");
      const outcome = await downloadToFile(ctx, {
        method: "POST",
        path: "/open/logs/download",
        body: pickDefined({ filename, path: ctx.flags.path }),
        output: ctx.flags.output,
      });
      if (!ctx.dryRun) process.stdout.write(`wrote ${outcome.output} (${outcome.bytes} bytes)\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown log subcommand "${action}". Run \`qinglong-admin help log\`.`);
  }
}

// ---------------------------------------------------------------------------
// dependency
// ---------------------------------------------------------------------------

const DEP_TABLE = [
  { key: "id", label: "ID", width: 6 },
  { key: "name", label: "name", width: 24 },
  { get: (row) => DEPENDENCY_TYPES[row.type] ?? row.type ?? "", label: "type", width: 10 },
  { get: (row) => DEPENDENCY_STATUS[row.status] ?? row.status ?? "", label: "status", width: 16 },
  { get: (row) => row.remark ?? "", label: "remark", width: 24 },
];

function dependencyTypeCode(value) {
  if (value === undefined) return undefined;
  const text = String(value).toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  const code = DEPENDENCY_TYPE_CODES[text];
  if (code === undefined) throw new UsageError(`unknown dependency type "${value}". Use nodejs, python3, linux or 0/1/2.`);
  return code;
}

async function cmdDependency(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "list": {
      const result = await call(ctx, {
        method: "GET",
        path: "/open/dependencies",
        query: { searchValue: ctx.flags.search ?? ctx.flags.q, type: ctx.flags.type, status: ctx.flags.status },
      });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, {
        table: rows,
        columns: DEP_TABLE,
        summary: `dependencies: ${rows.length}. status: 0 installing / 1 installed / 2 failed / 6 queued; creation accepted ≠ installed.`,
      });
      return 0;
    }
    case "get": {
      const id = rest[0];
      if (!id) throw new UsageError("dep get needs <id>");
      const result = await call(ctx, { method: "GET", path: `/open/dependencies/${id}` });
      emit(ctx, result);
      return 0;
    }
    case "create": {
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      let body;
      if (data !== undefined) {
        body = Array.isArray(data) ? data : [data];
      } else {
        if (!ctx.flags.name || ctx.flags.type === undefined) throw new UsageError("dep create needs --name and --type (nodejs|python3|linux)");
        body = [pickDefined({ name: ctx.flags.name, type: dependencyTypeCode(ctx.flags.type), remark: ctx.flags.remark })];
      }
      const result = await call(ctx, { method: "POST", path: "/open/dependencies", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : `install queued for ${body.length} dependency(ies). Creation accepted ≠ installed: poll \`dep list --search <name>\` until status is 1, then read the install log on failure.` });
      return 0;
    }
    case "update": {
      const id = rest[0];
      if (!id) throw new UsageError("dep update needs <id>");
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({ name: ctx.flags.name, type: dependencyTypeCode(ctx.flags.type), remark: ctx.flags.remark }),
        id: Number(id),
      };
      if (!body.name || body.type === undefined) throw new UsageError("dep update requires id + name + type (not a patch)");
      const result = await call(ctx, { method: "PUT", path: "/open/dependencies", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "updated" });
      return 0;
    }
    case "delete":
    case "force-delete": {
      const ids = idsFrom(rest, ctx.flags);
      requireYes(ctx, `${action} on ${ids.length} dependency(ies)`);
      const path = action === "force-delete" ? "/open/dependencies/force" : "/open/dependencies";
      const result = await call(ctx, { method: "DELETE", path, body: ids, destructive: true });
      emit(ctx, result, { summary: `${ids.length} dependency(ies) ${action === "force-delete" ? "force-deleted" : "deletion requested"}` });
      return 0;
    }
    case "reinstall":
    case "cancel": {
      const ids = idsFrom(rest, ctx.flags);
      const result = await call(ctx, { method: "PUT", path: `/open/dependencies/${action}`, body: ids });
      emit(ctx, result, { summary: `${ids.length} dependency(ies) ${action === "reinstall" ? "reinstall queued (not finished)" : "install cancelled"}` });
      return 0;
    }
    default:
      throw new UsageError(`unknown dep subcommand "${action}". Run \`qinglong-admin help dep\`.`);
  }
}

// ---------------------------------------------------------------------------
// script
// ---------------------------------------------------------------------------

async function cmdScript(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "list": {
      const result = await call(ctx, { method: "GET", path: "/open/scripts", query: pickDefined({ path: ctx.flags.path }) });
      emit(ctx, result, {
        table: unwrapList(result.data),
        columns: [{ get: (row) => (typeof row === "string" ? row : row.path ?? row.filename ?? row.name ?? JSON.stringify(row)), label: "path", width: 70 }],
        summary: `entries: ${unwrapList(result.data).length} (blacklisted dirs like node_modules are excluded; dirs first)`,
      });
      return 0;
    }
    case "get": {
      const query = pickDefined({ file: ctx.flags.file, path: ctx.flags.path });
      if (!query.file) throw new UsageError("script get needs --file (and usually --path)");
      const result = await call(ctx, { method: "GET", path: "/open/scripts/detail", query });
      emit(ctx, result);
      return 0;
    }
    case "create": {
      if (ctx.flags.file) {
        const fields = pickDefined({
          filename: ctx.flags.filename ?? basename(String(ctx.flags.file)),
          path: ctx.flags.path,
          originFilename: basename(String(ctx.flags.file)),
          directory: ctx.flags.directory,
        });
        const result = await postForm(ctx, { path: "/open/scripts", fields, file: ctx.flags.file, fileField: "file" });
        emit(ctx, result, { summary: ctx.dryRun ? undefined : `uploaded ${ctx.flags.file}` });
        return 0;
      }
      if (!ctx.flags.filename) throw new UsageError("script create needs --file <local file> (upload) or --filename + --content (inline)");
      const body = pickDefined({
        filename: ctx.flags.filename,
        path: ctx.flags.path,
        content: ctx.flags.content ?? (ctx.flags["content-file"] ? readFileSync(String(ctx.flags["content-file"]), "utf8") : undefined),
        directory: ctx.flags.directory,
      });
      const result = await call(ctx, { method: "POST", path: "/open/scripts", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "created" });
      return 0;
    }
    case "update": {
      const content = ctx.flags.content ?? (ctx.flags["content-file"] ? readFileSync(String(ctx.flags["content-file"]), "utf8") : undefined);
      if (!ctx.flags.filename || content === undefined) throw new UsageError("script update needs --filename and --content or --content-file");
      const result = await call(ctx, { method: "PUT", path: "/open/scripts", body: pickDefined({ filename: ctx.flags.filename, path: ctx.flags.path, content }) });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "updated" });
      return 0;
    }
    case "delete": {
      if (!ctx.flags.filename) throw new UsageError("script delete needs --filename (and usually --path)");
      requireYes(ctx, `deleting script ${ctx.flags.path ? `${ctx.flags.path}/` : ""}${ctx.flags.filename}`);
      const result = await call(ctx, { method: "DELETE", path: "/open/scripts", body: pickDefined({ filename: ctx.flags.filename, path: ctx.flags.path }), destructive: true });
      emit(ctx, result, { summary: "deleted" });
      return 0;
    }
    case "run": {
      const content = ctx.flags.content ?? (ctx.flags["content-file"] ? readFileSync(String(ctx.flags["content-file"]), "utf8") : undefined);
      if (!ctx.flags.filename) throw new UsageError("script run needs --filename [--content|--content-file] — this is the debug route: it runs a temp swap file, not the saved script");
      const result = await call(ctx, { method: "PUT", path: "/open/scripts/run", body: pickDefined({ filename: ctx.flags.filename, path: ctx.flags.path, content }) });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "debug run submitted (temp swap file). To run a saved scheduled task use `task run <id>`." });
      return 0;
    }
    case "stop": {
      if (!ctx.flags.filename) throw new UsageError("script stop needs --filename [--path] [--pid]");
      const result = await call(ctx, { method: "PUT", path: "/open/scripts/stop", body: pickDefined({ filename: ctx.flags.filename, path: ctx.flags.path, pid: flagInt(ctx.flags.pid, "pid") }) });
      emit(ctx, result, { summary: "stop requested" });
      return 0;
    }
    case "rename": {
      if (!ctx.flags.filename || !ctx.flags["new-name"]) throw new UsageError("script rename needs --filename --new-name [--path]");
      const result = await call(ctx, { method: "PUT", path: "/open/scripts/rename", body: pickDefined({ filename: ctx.flags.filename, path: ctx.flags.path, newFilename: ctx.flags["new-name"] }) });
      emit(ctx, result, { summary: "renamed" });
      return 0;
    }
    case "download": {
      if (!ctx.flags.filename) throw new UsageError("script download needs --filename [--path] --output <file>");
      const outcome = await downloadToFile(ctx, { path: "/open/scripts/download", body: pickDefined({ filename: ctx.flags.filename, path: ctx.flags.path }), output: ctx.flags.output });
      if (!ctx.dryRun) process.stdout.write(`wrote ${outcome.output} (${outcome.bytes} bytes)\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown script subcommand "${action}". Run \`qinglong-admin help script\`.`);
  }
}

// ---------------------------------------------------------------------------
// configs (panel configuration files)
// ---------------------------------------------------------------------------

async function cmdConfigs(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "list": {
      const result = await call(ctx, { method: "GET", path: "/open/configs/files" });
      emit(ctx, { ...result, data: result.data }, {
        table: unwrapList(result.data),
        columns: [
          { get: (row) => row.title ?? row.name ?? "", label: "file", width: 40 },
          { get: (row) => row.value ?? row.path ?? "", label: "value", width: 40 },
        ],
      });
      return 0;
    }
    case "samples": {
      const result = await call(ctx, { method: "GET", path: "/open/configs/samples" });
      emit(ctx, result);
      return 0;
    }
    case "get": {
      const path = ctx.flags.path ?? rest[0];
      if (!path) throw new UsageError("configs get needs --path config.sh (the retired route GET /open/configs/:file answers 410)");
      const result = await call(ctx, { method: "GET", path: "/open/configs/detail", query: { path } });
      emit(ctx, result);
      return 0;
    }
    case "save": {
      const name = ctx.flags.name;
      const content = ctx.flags.content ?? (ctx.flags["content-file"] ? readFileSync(String(ctx.flags["content-file"]), "utf8") : undefined);
      if (!name || content === undefined) throw new UsageError("configs save needs --name and --content or --content-file (whole-file overwrite)");
      const result = await call(ctx, { method: "POST", path: "/open/configs/save", body: { name, content } });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : `saved ${name} (whole-file overwrite). Re-read with \`configs get --path ${name}\`.` });
      return 0;
    }
    default:
      throw new UsageError(`unknown configs subcommand "${action}". Run \`qinglong-admin help configs\`.`);
  }
}

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------

const SYSTEM_CONFIG_ROUTES = {
  "log-remove-frequency": { path: "/open/system/config/log-remove-frequency", field: "logRemoveFrequency", numeric: true },
  "cron-concurrency": { path: "/open/system/config/cron-concurrency", field: "cronConcurrency", numeric: true },
  "dependence-proxy": { path: "/open/system/config/dependence-proxy", field: "dependenceProxy" },
  "node-mirror": { path: "/open/system/config/node-mirror", field: "nodeMirror" },
  "python-mirror": { path: "/open/system/config/python-mirror", field: "pythonMirror" },
  "linux-mirror": { path: "/open/system/config/linux-mirror", field: "linuxMirror" },
  timezone: { path: "/open/system/config/timezone", field: "timezone" },
  lang: { path: "/open/system/config/lang", field: "lang" },
  "panel-title": { path: "/open/system/config/panel-title", field: "panelTitle" },
  "global-ssh-key": { path: "/open/system/config/global-ssh-key", field: "globalSshKey" },
};

async function cmdSystem(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "info": {
      const result = await call(ctx, { method: "GET", path: "/open/system" });
      emit(ctx, result);
      return 0;
    }
    case "config-get": {
      const result = await call(ctx, { method: "GET", path: "/open/system/config" });
      emit(ctx, result);
      return 0;
    }
    case "config-set": {
      const key = ctx.flags.key;
      const route = SYSTEM_CONFIG_ROUTES[key];
      if (!route) throw new UsageError(`system config-set --key must be one of: ${Object.keys(SYSTEM_CONFIG_ROUTES).join(", ")}`);
      const raw = ctx.flags.value;
      if (raw === undefined) throw new UsageError("system config-set needs --value");
      const value = route.numeric ? (raw === "null" || raw === "" ? null : Number(raw)) : raw;
      const result = await call(ctx, { method: "PUT", path: route.path, body: { [route.field]: value } });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : `${key} set. Re-read with \`system config-get\` to verify.` });
      return 0;
    }
    case "notify": {
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({ title: ctx.flags.title, content: ctx.flags.content }),
      };
      if (!body.title || !body.content) throw new UsageError("system notify needs --title and --content (or --data '{...}' with notificationInfo)");
      const result = await call(ctx, { method: "PUT", path: "/open/system/notify", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "notification sent (panel default channels unless notificationInfo was supplied)" });
      return 0;
    }
    case "update-check": {
      const result = await call(ctx, { method: "PUT", path: "/open/system/update-check" });
      emit(ctx, result);
      return 0;
    }
    case "update": {
      requireYes(ctx, "system update restarts the panel");
      const result = await call(ctx, { method: "PUT", path: "/open/system/update", destructive: true });
      emit(ctx, result, { summary: "update triggered; the panel may restart" });
      return 0;
    }
    case "reload": {
      const type = ctx.flags.type ?? "services";
      if (type === "data") requireYes(ctx, "reload type=data replaces and clears the data directory");
      const result = await call(ctx, { method: "PUT", path: "/open/system/reload", body: { type }, destructive: type === "data" });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : `reload (${type}) triggered` });
      return 0;
    }
    case "command-run": {
      if (!ctx.flags.command) throw new UsageError("system command-run needs --command (streams text; stop with `system command-stop`)");
      const result = await call(ctx, { method: "PUT", path: "/open/system/command-run", body: { command: ctx.flags.command }, allowText: true });
      if (result.dryRun) return 0;
      if (result.nonJson) process.stdout.write(result.text.slice(0, flagInt(ctx.flags["max-bytes"], "max-bytes") ?? 200000));
      else emit(ctx, result);
      return 0;
    }
    case "command-stop": {
      const body = pickDefined({ command: ctx.flags.command, pid: flagInt(ctx.flags.pid, "pid") });
      if (!body.command && body.pid === undefined) throw new UsageError("system command-stop needs --command or --pid");
      const result = await call(ctx, { method: "PUT", path: "/open/system/command-stop", body });
      emit(ctx, result, { summary: "stop requested" });
      return 0;
    }
    case "log": {
      const query = pickDefined({
        startTime: ctx.flags.start,
        endTime: ctx.flags.end,
        limit: flagInt(ctx.flags.limit, "limit"),
      });
      const result = await call(ctx, { method: "GET", path: "/open/system/log", query, allowText: true });
      if (result.dryRun) return 0;
      if (result.nonJson) {
        process.stdout.write(result.text);
        if (!result.text.endsWith("\n")) process.stdout.write("\n");
      } else emit(ctx, result);
      return 0;
    }
    case "log-delete": {
      requireYes(ctx, "deleting system logs");
      const result = await call(ctx, { method: "DELETE", path: "/open/system/log", destructive: true });
      emit(ctx, result, { summary: "system logs deleted" });
      return 0;
    }
    case "auth-reset": {
      requireYes(ctx, "resetting the panel auth state");
      const result = await call(ctx, { method: "PUT", path: "/open/system/auth/reset", body: readJsonArg(ctx.flags.data, { flagName: "data" }) ?? {}, destructive: true });
      emit(ctx, result, { summary: "auth state reset" });
      return 0;
    }
    case "data-export": {
      const type = flagList(ctx.flags.type);
      const outcome = await downloadToFile(ctx, {
        method: "PUT",
        path: "/open/system/data/export",
        body: type?.length ? { type } : undefined,
        output: ctx.flags.output,
      });
      if (!ctx.dryRun) process.stdout.write(`wrote ${outcome.output} (${outcome.bytes} bytes). Omitted type exports only db+upload; add --type scripts,config,log for more.\n`);
      return 0;
    }
    case "data-import": {
      if (!ctx.flags.file) throw new UsageError("system data-import needs --file <data.tgz>");
      if (!ctx.yes && !ctx.dryRun) {
        throw new UsageError(
          "data import unpacks to a temp directory only; the second step `system reload --type data --yes` replaces and clears the live data directory. Back up first, then re-run with --yes.",
        );
      }
      const result = await postForm(ctx, { path: "/open/system/data/import", fields: {}, file: ctx.flags.file, fileField: "data" });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "uploaded and unpacked to a temp directory. Run `system reload --type data --yes` to apply — it clears the current data directory." });
      return 0;
    }
    case "client-ip-get": {
      const result = await call(ctx, { method: "GET", path: "/open/system/client-ip/config" });
      emit(ctx, result);
      return 0;
    }
    case "client-ip-set": {
      if (ctx.flags["trust-proxy"] === undefined) throw new UsageError("system client-ip-set needs --trust-proxy (string, max 500 chars; empty string clears)");
      const result = await call(ctx, { method: "PUT", path: "/open/system/client-ip/config", body: { trustProxy: String(ctx.flags["trust-proxy"]) } });
      emit(ctx, result, { summary: "saved" });
      return 0;
    }
    case "client-ip-diagnose": {
      const result = await call(ctx, { method: "GET", path: "/open/system/client-ip/diagnose" });
      emit(ctx, result);
      return 0;
    }
    case "retention-set":
    case "retention-preview":
    case "retention-cleanup": {
      const running = flagInt(ctx.flags["running-days"], "running-days");
      const cronStat = flagInt(ctx.flags["cron-stat-days"], "cron-stat-days");
      if (running === undefined || cronStat === undefined) {
        throw new UsageError("retention commands need --running-days and --cron-stat-days (integers 0-3650)");
      }
      const body = {
        runningInstanceRetentionDays: running,
        cronStatRetentionDays: cronStat,
        dependenceCacheTypes: flagList(ctx.flags["dependence-cache-types"]) ?? [],
        compactDatabase: Boolean(flagBool(ctx.flags["compact-database"])),
      };
      if (action === "retention-set") {
        const result = await call(ctx, { method: "PUT", path: "/open/system/storage-retention/config", body });
        emit(ctx, result, { summary: "retention policy saved" });
        return 0;
      }
      const path = action === "retention-preview" ? "/open/system/storage-retention/preview" : "/open/system/storage-retention/cleanup";
      if (action === "retention-cleanup") {
        if (ctx.flags.confirmation !== "CLEAN") throw new UsageError("retention-cleanup requires --confirmation CLEAN (and --yes to actually run)");
        requireYes(ctx, "storage retention cleanup deletes data");
        body.confirmation = "CLEAN";
      }
      const result = await call(ctx, { method: "POST", path, body, destructive: action === "retention-cleanup" });
      emit(ctx, result, {
        summary: action === "retention-preview" ? "preview only; nothing was deleted" : "cleanup executed",
      });
      return 0;
    }
    default:
      throw new UsageError(`unknown system subcommand "${action}". Run \`qinglong-admin help system\`.`);
  }
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

const DASHBOARD_VIEWS = {
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

async function cmdDashboard(ctx, action, rest) {
  const view = action ?? "overview";
  const path = DASHBOARD_VIEWS[view];
  if (!path) throw new UsageError(`unknown dashboard view "${view}". One of: ${Object.keys(DASHBOARD_VIEWS).join(", ")}`);
  const query = view === "trend" ? pickDefined({ days: flagInt(ctx.flags.days, "days") }) : {};
  const result = await call(ctx, { method: "GET", path, query });
  if (view === "overview" && !ctx.json && !ctx.dryRun) {
    const d = result.data ?? {};
    emit(ctx, result, {
      summary: [
        `tasks:     ${d.total ?? "?"} total, ${d.enabled ?? "?"} enabled, ${d.disabled ?? "?"} disabled`,
        `today:     ${d.todayRunCount ?? d.todayRuns ?? "?"} runs, ${d.todaySuccessCount ?? d.successCount ?? "?"} ok, ${d.todayFailCount ?? d.failCount ?? "?"} failed`,
        `success:   ${d.successRate !== undefined ? `${d.successRate}%` : "?"}`,
        `avg time:  ${d.avgTime !== undefined ? formatMillis(d.avgTime) : "?"}`,
      ].join("\n"),
    });
    return 0;
  }
  emit(ctx, result, { summary: view === "successes" || view === "failures" ? `${view}: today, soft-deleted tasks keep deleted:true` : undefined });
  return 0;
}

// ---------------------------------------------------------------------------
// app / user
// ---------------------------------------------------------------------------

async function cmdApp(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "list": {
      const result = await call(ctx, { method: "GET", path: "/open/apps" });
      const rows = unwrapList(result.data);
      emit(ctx, { ...result, data: result.data }, {
        table: rows,
        columns: [
          { key: "id", label: "ID", width: 6 },
          { key: "name", label: "name", width: 20 },
          { get: (row) => (row.scopes ?? []).join(","), label: "scopes", width: 50 },
        ],
      });
      return 0;
    }
    case "create": {
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({ name: ctx.flags.name, scopes: flagList(ctx.flags.scopes) }),
      };
      if (name_is_system(body.name)) throw new UsageError(`application name "system" is reserved`);
      const result = await call(ctx, { method: "POST", path: "/open/apps", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "created. Capture client_id/client_secret now if the panel shows them; store them as QL_CLIENT_ID/QL_CLIENT_SECRET." });
      return 0;
    }
    case "update": {
      const id = rest[0];
      if (!id) throw new UsageError("app update needs <id>");
      const data = readJsonArg(ctx.flags.data, { flagName: "data" });
      const body = {
        ...(data && !Array.isArray(data) ? data : {}),
        ...pickDefined({ name: ctx.flags.name, scopes: flagList(ctx.flags.scopes) }),
        id: Number(id),
      };
      if (name_is_system(body.name)) throw new UsageError(`application name "system" is reserved`);
      const result = await call(ctx, { method: "PUT", path: "/open/apps", body });
      emit(ctx, result, { summary: ctx.dryRun ? undefined : "updated" });
      return 0;
    }
    case "delete": {
      const ids = idsFrom(rest, ctx.flags);
      requireYes(ctx, `deleting ${ids.length} application(s)`);
      const result = await call(ctx, { method: "DELETE", path: "/open/apps", body: ids, destructive: true });
      emit(ctx, result, { summary: `${ids.length} app(s) deleted; tokens issued to them stop working` });
      return 0;
    }
    case "reset-secret": {
      const id = rest[0];
      if (!id) throw new UsageError("app reset-secret needs <id>");
      requireYes(ctx, "resetting the application secret clears all its existing tokens (irreversible)");
      const result = await call(ctx, { method: "PUT", path: `/open/apps/${id}/reset-secret`, destructive: true });
      emit(ctx, result, { summary: "secret reset; all earlier tokens for this app are cleared" });
      return 0;
    }
    default:
      throw new UsageError(`unknown app subcommand "${action}". Run \`qinglong-admin help app\`.`);
  }
}

function name_is_system(name) {
  return name !== undefined && String(name).trim().toLowerCase() === "system";
}

async function cmdUser(ctx, action, rest) {
  switch (action) {
    case undefined:
    case "get": {
      const result = await call(ctx, { method: "GET", path: "/open/user" });
      emit(ctx, result);
      return 0;
    }
    case "login-log": {
      const result = await call(ctx, { method: "GET", path: "/open/user/login-log" });
      emit(ctx, result);
      return 0;
    }
    case "ip-blacklist": {
      const result = await call(ctx, { method: "GET", path: "/open/user/ip-blacklist" });
      emit(ctx, result);
      return 0;
    }
    case "ip-blacklist-add":
    case "ip-blacklist-remove": {
      const ip = ctx.flags.ip;
      if (!ip) throw new UsageError(`user ${action} needs --ip <address> (single IPv4/IPv6, no CIDR)`);
      const method = action === "ip-blacklist-add" ? "PUT" : "DELETE";
      const result = await call(ctx, { method, path: "/open/user/ip-blacklist", body: { ip } });
      emit(ctx, result, { summary: `IP ${ip} ${action === "ip-blacklist-add" ? "added to" : "removed from"} the blacklist` });
      return 0;
    }
    case "notification-get": {
      const result = await call(ctx, { method: "GET", path: "/open/user/notification" });
      emit(ctx, result);
      return 0;
    }
    case "notification-set": {
      const body = readJsonArg(ctx.flags.data, { flagName: "data" });
      if (body === undefined) throw new UsageError("user notification-set needs --data '<json>'");
      const result = await call(ctx, { method: "PUT", path: "/open/user/notification", body });
      emit(ctx, result, { summary: "notification settings updated" });
      return 0;
    }
    default:
      throw new UsageError(`unknown user subcommand "${action}". Run \`qinglong-admin help user\`.`);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function usage(topic) {
  const sections = {
    task: `task — 定时任务（crons）
  task list [--search k] [--status s] [--type t] [--page 1] [--size 20]
  task get <id> | task find <keyword>
  task create --name N --command 'task demo.js' --schedule '0 9 * * *'
              [--label a,b] [--log-name n] [--work-dir d] [--allow-multiple-instances] [--data @file]
  task update <id> --command C --schedule S [--name N] [--label a,b] …   (whole-record submit; no merge)
  task run <id...> | stop | enable | disable | pin | unpin   [--ids 1,2]
  task logs <id> [--offset N] [--limit N] [--tail]        (bytes; follow nextOffset)
  task instances <id> | task instance-stop <taskId> <instanceId> | task log-files <id>

  accepted ≠ success: after \`task run\`, read instances + log content, not the accepted flag.`,
    env: `env — 环境变量（envs）
  env list [--search k]
  env get <id>
  env create --name NAME --value V [--remarks r] [--labels a,b]   |  --data '[{...}]'
  env update <id> --name NAME --value V [--remarks r]             (id+name+value mandatory)
  env delete <id...> --yes
  env enable|disable|pin|unpin <id...>
  env rename --ids 1,2 --name NEW
  env move <id> --from N --to M
  env labels-add|labels-delete --ids 1,2 --labels a,b
  env upload --file envs.json                                     (multipart; creates only)`,
    sub: `sub — 订阅/仓库（subscriptions）
  sub list [--search k] [--ids 1,2]
  sub get <id>
  sub create --type public-repo --url URL --alias demo --schedule-type crontab [--schedule '0 0 * * *'] [--data @file]
  sub update <id> --type T --url U --alias A …                    (id/type/url/alias mandatory)
  sub run|stop|enable|disable <id...>
  sub logs <id> [--offset N] [--limit N] [--tail] | sub log-files <id>`,
    log: `log — 日志（logs）
  log list
  log get (--file F [--path P] [--offset N] [--limit N] [--tail])   (bytes; use returned nextOffset)
  log delete --file F [--path P] --yes
  log download --file F [--path P] --output ./F                     (refuses to overwrite)`,
    dep: `dep — 依赖（dependencies）
  dep list [--search k] [--type nodejs|python3|linux] [--status 2,5]
  dep get <id>
  dep create --name axios --type nodejs [--remark r] | --data '[{...}]'   (body type is 0/1/2)
  dep update <id> --name N --type T
  dep delete <id...> --yes | dep force-delete <id...> --yes
  dep reinstall <id...> | dep cancel <id...>                       (accepted ≠ installed)`,
    script: `script — 脚本（scripts）
  script list [--path p]
  script get --file F [--path P]
  script create --file ./local.js [--filename F] [--path P]        (upload)
              | --filename F --content C | --content-file ./f.js
  script update --filename F --content C [--path P]
  script delete --filename F [--path P] --yes
  script run --filename F [--content C]    (debug: temp swap file; saved tasks use \`task run\`)
  script stop --filename F [--path P] [--pid N]
  script rename --filename F --new-name G [--path P]
  script download --filename F --output ./F`,
    configs: `configs — 配置文件（configs）
  configs list | configs samples
  configs get --path config.sh
  configs save --name config.sh (--content C | --content-file ./config.sh)   (whole-file overwrite)`,
    system: `system — 系统（system）
  system info | system config-get
  system config-set --key <${Object.keys(SYSTEM_CONFIG_ROUTES).join("|")}> --value V
  system notify --title T --content C [--data @file]
  system update-check | system update --yes | system reload [--type services|system|data] --yes
  system command-run --command '…' [--max-bytes N] | system command-stop (--command C | --pid N)
  system log [--start D] [--end D] [--limit N] | system log-delete --yes
  system auth-reset --yes
  system data-export --output backup.tgz [--type scripts,config,log]
  system data-import --file backup.tgz --yes
  system client-ip-get | client-ip-set --trust-proxy V | client-ip-diagnose
  system retention-set --running-days N --cron-stat-days N [--dependence-cache-types node,python3] [--compact-database]
  system retention-preview (same flags) | retention-cleanup (same + --confirmation CLEAN) --yes`,
    dashboard: `dashboard — 仪表盘（dashboard）
  dashboard overview | trend [--days 7] | top-time | top-count | runtime | labels | system
  dashboard successes | failures      (not in the CLI route table; served by the panel directly)`,
    app: `app — 面板应用（apps）
  app list
  app create --name N --scopes crons,envs [--data @file]
  app update <id> [--name N] [--scopes a,b]
  app delete <id...> --yes
  app reset-secret <id> --yes       (clears all tokens of that app)`,
    user: `user — 用户与安全（user）
  user get | user login-log
  user ip-blacklist | user ip-blacklist-add --ip A | user ip-blacklist-remove --ip A
  user notification-get | user notification-set --data '<json>'`,
    api: `api — 通用请求
  api request <METHOD> <path> [--query k=v]… [--data '<json>'|@file|-] [--yes]
  api request PUT /open/crons/run --data '[12,13]'            (batch run)
  api request GET /open/dashboard/failures                     (not in the CLI route table)`,
    status: `status — 面板状态
  status [--scope crons] [--scopes]        (probing a scope shows whether the app is authorized)
  status --json`,
    routes: `routes — 路由索引
  routes [term] [--json]                   (143 indexed routes + 2 extras)`,
    config: `config — 本机连接配置（脱敏输出）
  config`,
  };

  if (topic && sections[topic]) return `${sections[topic]}\n`;
  if (topic && !sections[topic]) {
    return `unknown help topic "${topic}". available help topics: ${Object.keys(sections).join(", ")}\n`;
  }
  return `qinglong-admin ${VERSION} — manage a Qinglong (青龙 2.x) panel over its OpenAPI.

usage: qinglong-admin <group> <action> [flags]

connection (precedence: flags > env > ${"~/.config/qinglong-admin/config.json"}):
  --panel-url URL | QL_URL                    panel root, no trailing /open
                                              (--url is NOT the panel flag: some commands,
                                              like \`sub create\`, use --url for a repo URL)
  --token TOKEN | QL_ACCESS_TOKEN             application or session token
  --client-id ID --client-secret SECRET       or QL_CLIENT_ID + QL_CLIENT_SECRET:
                                              exchanged for a token on demand, refreshed on 401
  --timeout MS | QL_TIMEOUT_MS                per-request timeout (default 30000)
  --config PATH | QL_ADMIN_CONFIG             config file location

global flags:
  --json        print the raw response data
  --dry-run     print the exact request and send nothing
  --yes         required for destructive routes

groups:
  status      panel health, version and scope probing
  routes      the 143-route index, searchable
  api         generic request for any route
  task        scheduled tasks (crons)
  env         environment variables
  sub         subscriptions / repositories
  log         log directory, chunked reads, downloads
  dep         dependencies
  script      scripts (files under the panel's script directory)
  configs     panel configuration files (config.sh …)
  system      system info, settings, notifications, data, retention
  dashboard   overview, trend, rankings, runtime
  app         panel OpenAPI applications
  user        panel user, login log, IP blacklist, notifications

  help <group> for one group's flags; \`routes\` lists every HTTP route.

notes:
  * A route existing does not mean the app is authorized: grant scopes in 面板 系统设置 → 应用设置.
  * The retired routes GET /open/{configs|scripts|logs}/:file answer 410; use the /detail forms.
  * Env values and logs may contain secrets — mask before sharing.
`;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    if (error instanceof ApiError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`unexpected error: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
