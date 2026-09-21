#!/usr/bin/env node
// newapi-admin — full-surface command line client for the New API management API.
//
// Design notes that matter when reading this file:
//   * Every command is a thin wrapper over one documented HTTP route. `newapi-admin api`
//     reaches every route that has no typed command, so coverage is complete by
//     construction rather than by enumeration.
//   * Destructive commands refuse to run without --yes. They are marked in ROUTES.
//   * --dry-run prints the exact request and sends nothing, for every command.
//   * Output defaults to a compact human summary; --json prints the raw response `data`.
//
// Node builtins only. Node >= 18 (global fetch).

import { readFileSync } from "node:fs";
import process from "node:process";

import {
  ApiError,
  DEFAULT_QUOTA_PER_UNIT,
  UsageError,
  assertConfigured,
  channelTypeCode,
  channelTypeName,
  CHANNEL_STATUS,
  estimateTextQuota,
  flagBool,
  flagInt,
  flagList,
  formatTable,
  isoToUnix,
  LOG_TYPES,
  parseArgs,
  parsePairs,
  pickDefined,
  printJson,
  quotaToUsd,
  ratioToUsdPerMillion,
  readJsonArg,
  readJsonFile,
  redactConfig,
  request,
  resolveConfig,
  ROLE_NAMES,
  usdPerMillionToRatio,
  usdToQuota,
  USER_STATUS,
} from "../lib/core.mjs";
import { findRoutes, matchRoute, routeStats } from "../lib/routes.mjs";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Global flag handling
// ---------------------------------------------------------------------------

const GLOBAL_FLAGS = new Set([
  "base-url",
  "token",
  "user-id",
  "timeout",
  "config",
  "security-proof",
  "json",
  "dry-run",
  "yes",
  "all",
  "help",
  "version",
  "query",
]);

function extractConfig(argv) {
  const { positionals, flags } = parseArgs(argv);
  const config = resolveConfig({
    flags: {
      baseUrl: flags["base-url"],
      token: flags.token,
      userId: flags["user-id"],
      timeout: flags.timeout,
      config: flags.config,
      securityProof: flags["security-proof"],
    },
  });
  return { positionals, flags, config };
}

/** Wrap a command so no page of the implementation has to remember any of this. */
async function main() {
  const argv = process.argv.slice(2);

  const wantsHelp = argv.length === 0 || argv[0] === "help" || argv.includes("--help") || argv.includes("-h");
  if (wantsHelp) {
    // `help <group>` names a topic; `--help` after a group names that group too.
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

  if (group === "routes") {
    return cmdRoutes(rest, flags);
  }
  if (group === "config") {
    return cmdConfig(config, flags);
  }

  assertConfigured(config);

  const ctx = {
    config,
    flags,
    json: Boolean(flags.json),
    dryRun: Boolean(flags["dry-run"]),
    yes: Boolean(flags.yes),
    all: Boolean(flags.all) || Boolean(flags.all_pages),
  };

  switch (group) {
    case "ping":
    case "status":
      return cmdStatus(ctx, action, rest);
    case "api":
      return cmdApi(ctx, [action, ...rest]);
    case "channels":
      return cmdChannels(ctx, action, rest);
    case "models":
      return cmdModels(ctx, action, rest);
    case "pricing":
      return cmdPricing(ctx, action, rest);
    case "users":
      return cmdUsers(ctx, action, rest);
    case "tokens":
      return cmdTokens(ctx, action, rest);
    case "redemptions":
      return cmdRedemptions(ctx, action, rest);
    case "logs":
      return cmdLogs(ctx, action, rest);
    case "data":
      return cmdData(ctx, action, rest);
    case "groups":
      return cmdGroups(ctx, action, rest);
    case "vendors":
      return cmdVendors(ctx, action, rest);
    case "prefill":
      return cmdPrefill(ctx, action, rest);
    case "options":
      return cmdOptions(ctx, action, rest);
    case "system":
      return cmdSystem(ctx, action, rest);
    case "tasks":
      return cmdTasks(ctx, action, rest);
    case "audit":
      return cmdAudit(ctx, action, rest);
    case "subscription":
      return cmdSubscription(ctx, action, rest);
    default:
      throw new UsageError(`unknown command group "${group}". Run \`newapi-admin help\`.`);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emit(ctx, result, { table, summary, columns } = {}) {
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
  if (options.destructive && !ctx.yes) {
    const route = matchRoute(described.method, described.path);
    throw new UsageError(
      `refusing to run a destructive request without --yes: ${described.method} ${described.path}` +
        (route ? ` (${route.purpose})` : "") +
        `\nAdd --yes to confirm, or --dry-run to inspect the request first.`,
    );
  }
  return request(ctx.config, described);
}

function requireYes(ctx, label) {
  if (ctx.yes || ctx.dryRun) return;
  throw new UsageError(`${label} is irreversible. Re-run with --yes to confirm, or --dry-run to inspect first.`);
}

function paginate(ctx, { path, query = {}, pageSize = 100 } = {}) {
  return {
    path,
    query: { ...query, p: flagInt(query.p, "p") ?? 1, page_size: flagInt(query.page_size, "page_size") ?? pageSize },
  };
}

/** Fetch every page of a paginated list endpoint. Server caps page_size at 100. */
async function fetchAllPages(ctx, { path, query = {}, maxPages = 200 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await call(ctx, { method: "GET", path, query: { ...query, p: page, page_size: 100 } });
    if (result.dryRun) return [];
    const data = result.data ?? {};
    const batch = data.items ?? [];
    items.push(...batch);
    const total = Number(data.total ?? items.length);
    if (batch.length === 0 || items.length >= total) break;
  }
  return items;
}

function pageQuery(flags, extra = {}) {
  return pickDefined({
    p: flagInt(flags.page, "page") ?? 1,
    page_size: flagInt(flags["page-size"] ?? flags.page_size, "page-size"),
    ...extra,
  });
}

function requireId(value, label) {
  if (value === undefined || value === null || value === "") throw new UsageError(`${label} is required`);
  return value;
}

function numeric(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`${label} must be a number, got "${value}"`);
  return parsed;
}

let quotaPerUnitCache;
/** QuotaPerUnit comes from the public /api/status, so it reflects the instance's real setting. */
async function quotaPerUnit(ctx) {
  if (quotaPerUnitCache !== undefined) return quotaPerUnitCache;
  try {
    const result = await request(ctx.config, { method: "GET", path: "/api/status" });
    const value = Number(result.data?.quota_per_unit);
    quotaPerUnitCache = Number.isFinite(value) && value > 0 ? value : DEFAULT_QUOTA_PER_UNIT;
  } catch {
    quotaPerUnitCache = DEFAULT_QUOTA_PER_UNIT;
  }
  return quotaPerUnitCache;
}

// ---------------------------------------------------------------------------
// config / routes / status / api
// ---------------------------------------------------------------------------

function cmdConfig(config, flags) {
  printJson(redactConfig(config));
  return 0;
}

function cmdRoutes(positionals, flags) {
  const term = positionals.join(" ").trim();
  if (flags.stats) {
    printJson(routeStats());
    return 0;
  }
  const matches = findRoutes(term);
  if (flags.json) {
    printJson(matches);
    return 0;
  }
  if (matches.length === 0) {
    process.stdout.write(`no route matches "${term}"\n`);
    return 1;
  }
  let currentGroup = "";
  for (const route of matches) {
    if (route.group !== currentGroup) {
      currentGroup = route.group;
      process.stdout.write(`\n${route.groupLabel}\n`);
    }
    const guard = route.auth === "admin" && route.perm ? `admin+${route.perm}` : route.auth;
    const flag = route.destructive ? "  [destructive]" : "";
    process.stdout.write(`  ${route.method.padEnd(6)} ${route.path.padEnd(52)} ${guard.padEnd(30)} ${route.purpose}${flag}\n`);
  }
  process.stdout.write(`\n${matches.length} route(s).\n`);
  return 0;
}

async function cmdStatus(ctx, action, rest) {
  if (action === "test") {
    const result = await call(ctx, { method: "GET", path: "/api/status/test" });
    return emit(ctx, result);
  }
  if (action === "about") {
    const result = await call(ctx, { method: "GET", path: "/api/about" });
    return emit(ctx, result);
  }
  if (action === "setup") {
    const result = await call(ctx, { method: "GET", path: "/api/setup" });
    return emit(ctx, result);
  }
  // Default: a compact health summary, which is the single most useful admin call.
  const [status, test] = await Promise.all([
    call(ctx, { method: "GET", path: "/api/status" }),
    call(ctx, { method: "GET", path: "/api/status/test" }).catch((error) => ({ error })),
  ]);
  if (ctx.json) {
    printJson({ status: status.data, status_test: test?.data ?? null, status_test_error: test?.error?.message ?? null });
    return 0;
  }
  const data = status.data ?? {};
  const lines = [
    `instance     ${ctx.config.baseUrl}`,
    `version      ${data.version ?? "?"}`,
    `start_time   ${data.start_time ?? "?"}`,
    `setup        ${data.setup ?? "?"}`,
    `quota/unit   ${data.quota_per_unit ?? "?"}  (1 USD = ${data.quota_per_unit ?? "?"} quota)`,
  ];
  if (test?.error) lines.push(`status/test  FAILED: ${test.error.message}`);
  else lines.push(`status/test  ok`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function cmdApi(ctx, positionals) {
  const [method, path, ...rest] = positionals;
  if (!method || !path) throw new UsageError("usage: newapi-admin api <METHOD> <PATH> [--query k=v] [--body '<json>']");
  const fullPath = [path, ...rest].join("/").replace(/\/+/g, "/");
  const query = parsePairs(ctx.flags.query, "query");
  const body = readJsonArg(ctx.flags.body ?? ctx.flags.data, { flagName: "body" });
  const known = matchRoute(method, fullPath);
  const result = await call(ctx, {
    method,
    path: fullPath,
    query,
    body,
    destructive: ["DELETE", "PATCH"].includes(method.toUpperCase()) || /delete|reset|clear|cleanup|batch$|invalid$|revoke/i.test(fullPath),
  });
  if (ctx.dryRun) return 0;
  if (!ctx.json && !known) {
    process.stderr.write(`note: ${method.toUpperCase()} ${fullPath} is not in the bundled route index; the server decides.\n`);
  }
  return emit(ctx, result);
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

function buildChannelBody(flags) {
  const explicit = readJsonArg(flags.json_body ?? flags["channel-json"] ?? flags["body-json"], { flagName: "channel-json" });
  const type = flags.type !== undefined ? channelTypeCode(flags.type) ?? flagInt(flags.type, "type") : undefined;
  if (flags.type !== undefined && type === undefined) {
    throw new UsageError(`--type "${flags.type}" is not a known channel type code or name`);
  }
  const derived = pickDefined({
    id: flagInt(flags.id, "id"),
    name: flags.name,
    type,
    key: flags.key,
    base_url: flags["base-url"],
    models: flags.models,
    group: flags.group,
    priority: flagInt(flags.priority, "priority"),
    weight: flagInt(flags.weight, "weight"),
    test_model: flags["test-model"],
    tag: flags.tag,
    remark: flags.remark,
    auto_ban: flagBool(flags["auto-ban"]),
    openai_organization: flags["openai-organization"],
    other: flags.other,
    model_mapping: flags["model-mapping"],
    status_code_mapping: flags["status-code-mapping"],
    setting: flags.setting,
    settings: flags.settings,
    param_override: flags["param-override"],
    header_override: flags["header-override"],
  });
  return { ...(explicit ?? {}), ...derived };
}

async function cmdChannels(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "list": {
      const query = pageQuery(flags, {
        group: flags.group,
        status: flags.status,
        type: flags.type !== undefined ? channelTypeCode(flags.type) ?? flagInt(flags.type, "type") : undefined,
        sort_by: flags["sort-by"],
        sort_order: flags["sort-order"],
        id_sort: flagBool(flags["id-sort"]),
        tag_mode: flagBool(flags["tag-mode"]),
      });
      if (ctx.all) {
        const items = await fetchAllPages(ctx, { path: "/api/channel/", query });
        return emit(
          ctx,
          { data: { items, total: items.length } },
          { summary: `${items.length} channel(s)`, table: items, columns: CHANNEL_COLUMNS },
        );
      }
      const result = await call(ctx, { method: "GET", path: "/api/channel/", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, {
        summary: `${items.length} of ${result.data?.total ?? "?"} channel(s)${result.data?.type_counts ? `  type_counts=${JSON.stringify(result.data.type_counts)}` : ""}`,
        table: items,
        columns: CHANNEL_COLUMNS,
      });
    }
    case "search": {
      const query = pageQuery(flags, {
        keyword: flags.keyword,
        model: flags.model,
        group: flags.group,
        status: flags.status,
        type: flags.type !== undefined ? channelTypeCode(flags.type) ?? flagInt(flags.type, "type") : undefined,
      });
      const result = await call(ctx, { method: "GET", path: "/api/channel/search", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, { summary: `${items.length} of ${result.data?.total ?? "?"} match(es)`, table: items, columns: CHANNEL_COLUMNS });
    }
    case "get": {
      const id = requireId(rest[0] ?? flags.id, "channel id");
      const result = await call(ctx, { method: "GET", path: `/api/channel/${id}` });
      return emit(ctx, result, { table: result.data ? [result.data] : [], columns: CHANNEL_DETAIL_COLUMNS });
    }
    case "add": {
      const body = { mode: flags.mode ?? "single", channel: buildChannelBody(flags) };
      if (flags["multi-key-mode"]) body.multi_key_mode = flags["multi-key-mode"];
      if (flags["key-prefix-name"] !== undefined) body.batch_add_set_key_prefix_2_name = flagBool(flags["key-prefix-name"]);
      if (!body.channel.name || body.channel.key === undefined || body.channel.type === undefined) {
        throw new UsageError("channels add needs at least --name, --type and --key (or pass a full object with --channel-json)");
      }
      const result = await call(ctx, { method: "POST", path: "/api/channel/", body });
      return emit(ctx, result, { summary: `added channel ${body.channel.name} (mode=${body.mode})` });
    }
    case "update": {
      const id = requireId(rest[0] ?? flags.id, "channel id");
      const body = { ...buildChannelBody(flags), id: Number(id) };
      // The server rejects the whole request if `status` is present; direct users to the status command.
      if (flags.status !== undefined) {
        throw new UsageError("PUT /api/channel/ rejects `status`. Use `newapi-admin channels enable|disable|status` instead.");
      }
      if (flags["key-mode"]) body.key_mode = flags["key-mode"];
      if (flags["multi-key-mode"]) body.multi_key_mode = flags["multi-key-mode"];
      const result = await call(ctx, { method: "PUT", path: "/api/channel/", body });
      return emit(ctx, result, { summary: `updated channel ${id}` });
    }
    case "delete": {
      const id = requireId(rest[0] ?? flags.id, "channel id");
      const result = await call(ctx, { method: "DELETE", path: `/api/channel/${id}`, destructive: true });
      return emit(ctx, result, { summary: `deleted channel ${id}` });
    }
    case "batch-delete": {
      const ids = (flagList(rest[0] ?? flags.ids) ?? []).map((value) => numeric(value, "id"));
      if (!ids.length) throw new UsageError("channels batch-delete needs --ids 1,2,3");
      const result = await call(ctx, { method: "POST", path: "/api/channel/batch", body: { ids }, destructive: true });
      return emit(ctx, result, { summary: `deleted ${result.data ?? 0} channel(s)` });
    }
    case "delete-disabled": {
      const result = await call(ctx, { method: "DELETE", path: "/api/channel/disabled", destructive: true });
      return emit(ctx, result, { summary: `deleted ${result.data ?? 0} disabled channel(s)` });
    }
    case "enable":
    case "disable": {
      const ids = (flagList(rest[0] ?? flags.ids) ?? []).map((value) => numeric(value, "id"));
      if (!ids.length) throw new UsageError(`channels ${action} needs an id or --ids 1,2,3`);
      const status = action === "enable" ? 1 : 2;
      if (ids.length === 1 && !flags.ids) {
        const result = await call(ctx, { method: "POST", path: `/api/channel/${ids[0]}/status`, body: { status } });
        return emit(ctx, result, { summary: `channel ${ids[0]} -> ${CHANNEL_STATUS[status]}` });
      }
      const result = await call(ctx, { method: "POST", path: "/api/channel/status/batch", body: { ids, status } });
      return emit(ctx, result, { summary: `${ids.length} channel(s) -> ${CHANNEL_STATUS[status]}` });
    }
    case "status-set": {
      const ids = (flagList(flags.ids ?? rest[0]) ?? []).map((value) => numeric(value, "id"));
      const status = flagInt(flags.status, "status");
      if (!ids.length || (status !== 1 && status !== 2)) {
        throw new UsageError("channels status-set needs --ids 1,2 and --status 1|2 (3 = auto-disabled cannot be set)");
      }
      const result = await call(ctx, { method: "POST", path: "/api/channel/status/batch", body: { ids, status } });
      return emit(ctx, result, { summary: `${ids.length} channel(s) -> ${CHANNEL_STATUS[status]}` });
    }
    case "test": {
      const target = rest[0] ?? flags.id;
      if (!target || target === "all") {
        const result = await call(ctx, { method: "GET", path: "/api/channel/test" });
        return emit(ctx, result, { summary: "channel test task enqueued (asynchronous)" });
      }
      const query = pickDefined({ model: flags.model, endpoint_type: flags["endpoint-type"], stream: flagBool(flags.stream) });
      const raw = await request(ctx.config, { method: "GET", path: `/api/channel/test/${target}`, query });
      return emit(ctx, { data: raw.data, envelope: raw.envelope }, { summary: `channel ${target}: ${raw.envelope.success ? "ok" : "FAILED"}  time=${raw.envelope.time ?? "?"}s  ${raw.envelope.message ?? ""}` });
    }
    case "balance": {
      const target = rest[0] ?? flags.id;
      if (!target || target === "all") {
        const result = await call(ctx, { method: "GET", path: "/api/channel/update_balance" });
        return emit(ctx, result, { summary: "balance refresh finished for all supported channels (no per-channel detail returned)" });
      }
      // This route answers with balance/message at the top level, not inside `data`.
      const raw = await request(ctx.config, { method: "GET", path: `/api/channel/update_balance/${target}` });
      const envelope = raw.envelope;
      return emit(ctx, { data: envelope.data, envelope }, { summary: `channel ${target}: ${envelope.success ? `balance ${envelope.balance ?? "?"} USD` : `FAILED: ${envelope.message}`}` });
    }
    case "fetch-models": {
      const id = requireId(rest[0] ?? flags.id, "channel id");
      const result = await call(ctx, { method: "GET", path: `/api/channel/fetch_models/${id}` });
      const models = result.data ?? [];
      return emit(ctx, result, { summary: `${models.length} upstream model(s):\n${models.join("\n")}` });
    }
    case "probe-models": {
      const body = pickDefined({
        type: requireId(flags.type !== undefined ? channelTypeCode(flags.type) ?? flagInt(flags.type, "type") : undefined, "--type"),
        key: flags.key,
        channel_id: flagInt(flags["channel-id"], "channel-id"),
        base_url: flags["base-url"],
        proxy: flags.proxy,
        header_override: flags["header-override"],
      });
      const result = await call(ctx, { method: "POST", path: "/api/channel/fetch_models", body });
      const models = result.data ?? [];
      return emit(ctx, result, { summary: `${models.length} model(s) reachable with these credentials:\n${models.join("\n")}` });
    }
    case "models":
    case "enabled-models": {
      const result = await call(ctx, { method: "GET", path: "/api/channel/models_enabled" });
      const models = result.data ?? [];
      return emit(ctx, result, { summary: `${models.length} enabled model(s):\n${models.join("\n")}` });
    }
    case "catalog": {
      const result = await call(ctx, { method: "GET", path: "/api/channel/models" });
      const models = result.data ?? [];
      return emit(ctx, result, {
        summary: `${models.length} built-in catalog model(s)`,
        table: models.map((model) => ({ id: model.id, owned_by: model.owned_by })),
        columns: [{ key: "id", label: "model", width: 48 }, { key: "owned_by", label: "owned_by" }],
      });
    }
    case "fix": {
      const result = await call(ctx, { method: "POST", path: "/api/channel/fix" });
      return emit(ctx, result, { summary: `abilities rebuilt: ${JSON.stringify(result.data)}` });
    }
    case "copy": {
      const id = requireId(rest[0] ?? flags.id, "channel id");
      const query = pickDefined({ suffix: flags.suffix, reset_balance: flagBool(flags["reset-balance"]) });
      const result = await call(ctx, { method: "POST", path: `/api/channel/copy/${id}`, query });
      return emit(ctx, result, { summary: `copied channel ${id} -> ${result.data?.id ?? "?"}` });
    }
    case "key": {
      // Root-only and additionally gated by the X-Security-Proof header.
      const id = requireId(rest[0] ?? flags.id, "channel id");
      if (!ctx.config.securityProof && !ctx.dryRun) {
        throw new UsageError(
          "reading a channel key needs a security proof: POST /api/verify to obtain one, then pass --security-proof or set NEWAPI_SECURITY_PROOF.\n" +
            "The route is root-only and refuses requests without X-Security-Proof.",
        );
      }
      const result = await call(ctx, { method: "POST", path: `/api/channel/${id}/key` });
      return emit(ctx, result, { summary: `channel ${id} key: ${result.data?.key ?? "<not returned>"}` });
    }
    case "tag": {
      return cmdChannelTag(ctx, rest);
    }
    case "keys": {
      return cmdChannelKeys(ctx, rest);
    }
    case "upstream": {
      return cmdChannelUpstream(ctx, rest);
    }
    case "default-base-urls": {
      const result = await call(ctx, { method: "GET", path: "/api/channel/default_base_urls" });
      return emit(ctx, result);
    }
    default:
      throw new UsageError(`unknown channels subcommand "${action}". See \`newapi-admin help channels\`.`);
  }
}

const CHANNEL_COLUMNS = [
  { key: "id", label: "id", width: 6 },
  { key: "name", label: "name", width: 26 },
  { get: (row) => channelTypeName(row.type), label: "type", width: 16 },
  { get: (row) => CHANNEL_STATUS[row.status] ?? row.status, label: "status", width: 18 },
  { key: "priority", label: "prio", width: 5 },
  { key: "weight", label: "weight", width: 6 },
  { key: "group", label: "group", width: 18 },
  { get: (row) => (row.models ? String(row.models).split(",").length : 0), label: "models", width: 6 },
  { key: "balance", label: "balance", width: 10 },
  { key: "response_time", label: "ms", width: 7 },
  { key: "tag", label: "tag", width: 12 },
];

const CHANNEL_DETAIL_COLUMNS = [
  { key: "id", label: "id", width: 6 },
  { key: "name", label: "name", width: 24 },
  { get: (row) => `${channelTypeName(row.type)} (${row.type})`, label: "type", width: 24 },
  { get: (row) => CHANNEL_STATUS[row.status] ?? row.status, label: "status", width: 18 },
  { key: "group", label: "group", width: 14 },
  { key: "priority", label: "prio", width: 5 },
  { key: "weight", label: "weight", width: 6 },
  { key: "base_url", label: "base_url", width: 34 },
  { key: "test_model", label: "test_model", width: 22 },
  { key: "tag", label: "tag", width: 12 },
  { key: "models", label: "models", width: 48 },
];

async function cmdChannelTag(ctx, rest) {
  const flags = ctx.flags;
  const sub = rest[0] ?? flags.action;
  switch (sub) {
    case "set": {
      const ids = (flagList(flags.ids ?? rest[1]) ?? []).map((value) => numeric(value, "id"));
      if (!ids.length) throw new UsageError("channels tag set needs --ids 1,2,3 [--tag name]");
      const result = await call(ctx, { method: "POST", path: "/api/channel/batch/tag", body: pickDefined({ ids, tag: flags.tag }) });
      return emit(ctx, result, { summary: `tagged ${result.data ?? ids.length} channel(s) as "${flags.tag ?? "<cleared>"}"` });
    }
    case "enable":
    case "disable": {
      const tag = requireId(flags.tag ?? rest[1], "--tag");
      const result = await call(ctx, {
        method: "POST",
        path: sub === "enable" ? "/api/channel/tag/enabled" : "/api/channel/tag/disabled",
        body: { tag },
      });
      return emit(ctx, result, { summary: `all channels tagged "${tag}" -> ${sub === "enable" ? "enabled" : "disabled"}` });
    }
    case "edit": {
      const tag = requireId(flags.tag ?? rest[1], "--tag");
      // Note: this route uses `groups` (plural) while the Channel object uses `group`.
      const body = pickDefined({
        tag,
        new_tag: flags["new-tag"],
        models: flags.models,
        groups: flags.groups,
        priority: flagInt(flags.priority, "priority"),
        weight: flagInt(flags.weight, "weight"),
        model_mapping: flags["model-mapping"],
        param_override: flags["param-override"],
        header_override: flags["header-override"],
      });
      const result = await call(ctx, { method: "PUT", path: "/api/channel/tag", body });
      return emit(ctx, result, { summary: `edited channels tagged "${tag}"` });
    }
    case "models": {
      const tag = requireId(flags.tag ?? rest[1], "--tag");
      const result = await call(ctx, { method: "GET", path: "/api/channel/tag/models", query: { tag } });
      const models = String(result.data ?? "").split(",").filter(Boolean);
      return emit(ctx, result, { summary: `${models.length} model(s) across tag "${tag}":\n${models.join("\n")}` });
    }
    default:
      throw new UsageError("usage: newapi-admin channels tag set|enable|disable|edit|models");
  }
}

async function cmdChannelKeys(ctx, rest) {
  const flags = ctx.flags;
  const sub = rest[0] ?? "status";
  const channel = flagInt(flags.channel ?? flags["channel-id"] ?? rest[1], "channel");
  if (channel === undefined) throw new UsageError("channels keys needs --channel <id>");
  const body = { channel_id: channel, action: sub === "status" ? "get_key_status" : sub.replace(/-/g, "_") };
  if (sub === "status") {
    body.page = flagInt(flags.page, "page") ?? 1;
    body.page_size = flagInt(flags["page-size"], "page-size") ?? 50;
    if (flags.status !== undefined) body.status = flagInt(flags.status, "status");
  } else if (["disable", "enable", "delete"].includes(sub)) {
    body.key_index = flagInt(flags.index, "index");
    if (body.key_index === undefined) throw new UsageError(`channels keys ${sub} needs --index <n>`);
  }
  const destructive = ["delete", "delete-disabled"].includes(sub);
  const result = await call(ctx, { method: "POST", path: "/api/channel/multi_key/manage", body, destructive });
  if (sub === "status") {
    const keys = result.data?.keys ?? [];
    return emit(ctx, result, {
      summary: `${result.data?.total ?? keys.length} key(s)  enabled=${result.data?.enabled_count ?? "?"} manual_disabled=${result.data?.manual_disabled_count ?? "?"} auto_disabled=${result.data?.auto_disabled_count ?? "?"}`,
      table: keys,
      columns: [
        { key: "index", label: "idx", width: 5 },
        { get: (row) => CHANNEL_STATUS[row.status] ?? row.status, label: "status", width: 18 },
        { key: "key_preview", label: "key", width: 20 },
        { key: "reason", label: "reason", width: 30 },
      ],
    });
  }
  return emit(ctx, result, { summary: result.message ?? "ok" });
}

async function cmdChannelUpstream(ctx, rest) {
  const flags = ctx.flags;
  const sub = rest[0] ?? "detect";
  const ids = (flagList(flags.ids ?? rest[1]) ?? []).map((value) => numeric(value, "id"));
  const all = sub.endsWith("-all") || flags.all;
  if (sub.startsWith("detect")) {
    const result = await call(ctx, {
      method: "POST",
      path: all ? "/api/channel/upstream_updates/detect_all" : "/api/channel/upstream_updates/detect",
      body: all ? undefined : { ids },
    });
    return emit(ctx, result, { summary: "upstream model change detection finished" });
  }
  if (sub.startsWith("apply")) {
    const result = await call(ctx, {
      method: "POST",
      path: all ? "/api/channel/upstream_updates/apply_all" : "/api/channel/upstream_updates/apply",
      body: all ? undefined : { ids },
    });
    return emit(ctx, result, { summary: "applied upstream model updates" });
  }
  throw new UsageError("usage: newapi-admin channels upstream detect|detect-all|apply|apply-all [--ids 1,2]");
}

// ---------------------------------------------------------------------------
// models (metadata)
// ---------------------------------------------------------------------------

const MODEL_COLUMNS = [
  { key: "id", label: "id", width: 6 },
  { key: "model_name", label: "model_name", width: 34 },
  { get: (row) => (row.name_rule ? ["exact", "prefix", "contains", "suffix"][row.name_rule] : "exact"), label: "rule", width: 9 },
  { key: "vendor_id", label: "vendor", width: 7 },
  { get: (row) => (row.status === 1 ? "visible" : "hidden"), label: "status", width: 8 },
  { get: (row) => (row.sync_official === 1 ? "sync" : "locked"), label: "official", width: 7 },
  { get: (row) => row.configured_channel_count ?? "", label: "chans", width: 6 },
  { get: (row) => row.square_state ?? "", label: "square", width: 12 },
  { key: "tags", label: "tags", width: 18 },
];

async function cmdModels(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "list":
    case "search": {
      const query = pageQuery(flags, {
        keyword: flags.keyword,
        vendor: flags.vendor,
        status: flags.status,
        sync_official: flags["sync-official"],
        square_state: flags["square-state"],
        include_channel_models: flagBool(flags["include-channel-models"]),
      });
      const path = action === "search" ? "/api/models/search" : "/api/models/";
      if (ctx.all) {
        const items = await fetchAllPages(ctx, { path, query });
        return emit(ctx, { data: { items, total: items.length } }, { summary: `${items.length} model metadata record(s)`, table: items, columns: MODEL_COLUMNS });
      }
      const result = await call(ctx, { method: "GET", path, query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, {
        summary: `${items.length} of ${result.data?.total ?? "?"} record(s)${result.data?.vendor_counts ? `  vendor_counts=${JSON.stringify(result.data.vendor_counts)}` : ""}`,
        table: items,
        columns: MODEL_COLUMNS,
      });
    }
    case "get": {
      const id = requireId(rest[0] ?? flags.id, "model id");
      const result = await call(ctx, { method: "GET", path: `/api/models/${id}` });
      return emit(ctx, result);
    }
    case "missing": {
      const result = await call(ctx, { method: "GET", path: "/api/models/missing" });
      const names = result.data ?? [];
      return emit(ctx, result, { summary: `${names.length} enabled model(s) without metadata:\n${names.join("\n")}` });
    }
    case "create": {
      const body = pickDefined({
        model_name: requireId(flags["model-name"] ?? rest[0], "--model-name"),
        description: flags.description,
        icon: flags.icon,
        tags: flags.tags,
        vendor_id: flagInt(flags["vendor-id"], "vendor-id"),
        endpoints: flags.endpoints,
        status: flagInt(flags.status, "status"),
        sync_official: flagInt(flags["sync-official"], "sync-official"),
        name_rule: flagInt(flags["name-rule"], "name-rule"),
      });
      const result = await call(ctx, { method: "POST", path: "/api/models/", body });
      return emit(ctx, result, { summary: `created model metadata ${body.model_name}` });
    }
    case "update": {
      const id = flagInt(rest[0] ?? flags.id, "id");
      const body = pickDefined({
        id: requireId(id, "model id"),
        model_name: flags["model-name"],
        description: flags.description,
        icon: flags.icon,
        tags: flags.tags,
        vendor_id: flagInt(flags["vendor-id"], "vendor-id"),
        endpoints: flags.endpoints,
        status: flagInt(flags.status, "status"),
        sync_official: flagInt(flags["sync-official"], "sync-official"),
        name_rule: flagInt(flags["name-rule"], "name-rule"),
      });
      const query = pickDefined({ status_only: flagBool(flags["status-only"]) });
      const result = await call(ctx, { method: "PUT", path: "/api/models/", body, query });
      return emit(ctx, result, { summary: `updated model metadata ${body.id}` });
    }
    case "delete": {
      const id = requireId(rest[0] ?? flags.id, "model id");
      const query = pickDefined({
        remove_from_channels: flagBool(flags["remove-from-channels"]),
        remove_pricing: flagBool(flags["remove-pricing"]),
      });
      const result = await call(ctx, { method: "DELETE", path: `/api/models/${id}`, query, destructive: true });
      return emit(ctx, result, { summary: `deleted model metadata ${id}: ${JSON.stringify(result.data)}` });
    }
    case "batch-delete": {
      const ids = (flagList(rest[0] ?? flags["model-ids"] ?? flags.ids) ?? []).map((value) => numeric(value, "id"));
      if (!ids.length) throw new UsageError("models batch-delete needs --model-ids 1,2,3");
      const body = pickDefined({
        model_ids: ids,
        remove_from_channels: flagBool(flags["remove-from-channels"]),
        remove_pricing: flagBool(flags["remove-pricing"]),
      });
      const result = await call(ctx, { method: "POST", path: "/api/models/delete", body, destructive: true });
      return emit(ctx, result, { summary: `deleted: ${JSON.stringify(result.data)}` });
    }
    case "sync-preview": {
      const query = pickDefined({ locale: flags.locale });
      const result = await call(ctx, { method: "GET", path: "/api/models/sync_upstream/preview", query });
      const candidates = result.data?.candidates ?? [];
      if (flags.save) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(flags.save, JSON.stringify(result.data, null, 2));
        process.stdout.write(`preview saved to ${flags.save} (source_version=${result.data?.source?.version})\n`);
        return 0;
      }
      const byKind = {};
      for (const candidate of candidates) byKind[candidate.kind] = (byKind[candidate.kind] ?? 0) + 1;
      return emit(ctx, result, {
        summary: `${candidates.length} candidate(s) from ${result.data?.source?.models_url ?? "?"}  locale=${result.data?.source?.locale}\nsource_version=${result.data?.source?.version}\nkinds=${JSON.stringify(byKind)}`,
        table: candidates,
        columns: [
          { key: "model_name", label: "model_name", width: 34 },
          { key: "kind", label: "kind", width: 18 },
          { key: "scope", label: "scope", width: 9 },
          { get: (row) => (row.fields ?? []).map((field) => field.field).join(","), label: "fields", width: 40 },
        ],
      });
    }
    case "sync-apply": {
      // Two-step by design: the server re-fetches the catalog and rejects the apply if it
      // changed since the preview, so the preview's version token is the confirmation.
      const preview = readJsonFile(flags["from-preview"] ?? flags.preview, { flagName: "from-preview" });
      if (!preview) throw new UsageError("models sync-apply needs --from-preview <preview.json> (from `models sync-preview --save`)");
      const kinds = new Set(flagList(flags.kinds) ?? ["create", "update"]);
      const only = flagList(flags.models);
      const selections = (preview.candidates ?? [])
        .filter((candidate) => kinds.has(candidate.kind))
        .filter((candidate) => !only || only.includes(candidate.model_name))
        .map((candidate) => ({
          model_name: candidate.model_name,
          record_version: candidate.record_version,
          create: candidate.kind === "create",
          fields: candidate.kind === "create" ? [] : (candidate.fields ?? []).map((field) => field.field),
        }))
        .filter((selection) => selection.create || selection.fields.length > 0);
      if (!selections.length) {
        process.stdout.write("nothing to apply (no candidates matched)\n");
        return 0;
      }
      const body = { locale: flags.locale ?? preview.source?.locale, source_version: preview.source?.version, selections };
      const result = await call(ctx, { method: "POST", path: "/api/models/sync_upstream", body });
      return emit(ctx, result, {
        summary: `applied ${selections.length} selection(s): created_models=${JSON.stringify(result.data?.created_models ?? [])} updated=${(result.data?.updated_models ?? []).length} created_vendors=${JSON.stringify(result.data?.created_vendors ?? [])}`,
      });
    }
    default:
      throw new UsageError(`unknown models subcommand "${action}". See \`newapi-admin help models\`.`);
  }
}

// ---------------------------------------------------------------------------
// pricing (the highest-value area: model ratios, fixed prices, bulk option maps)
// ---------------------------------------------------------------------------

async function cmdPricing(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "get": {
      const query = {};
      const models = flagList(flags.model ?? rest[0]);
      if (models?.length) query.model = models;
      const result = await call(ctx, { method: "GET", path: "/api/option/model_pricing", query });
      const entries = result.data?.entries ?? [];
      if (ctx.json) {
        printJson(result.data);
        return 0;
      }
      const unit = await quotaPerUnit(ctx);
      return emit(ctx, result, {
        summary: `${entries.length} configured model(s)  (1 ratio = $${ratioToUsdPerMillion(1)}/1M tokens; 1 USD = ${unit} quota)`,
        table: entries.map((entry) => ({
          ...entry,
          ratio_usd_per_m: entry.effective?.ModelRatio !== undefined ? ratioToUsdPerMillion(entry.effective.ModelRatio).toFixed(4) : "",
          price_usd: entry.effective?.ModelPrice ?? "",
        })),
        columns: [
          { key: "model_name", label: "model_name", width: 34 },
          { get: (row) => row.effective?.ModelRatio ?? "", label: "ModelRatio", width: 11 },
          { get: (row) => row.ratio_usd_per_m, label: "$/1M", width: 9 },
          { get: (row) => row.effective?.CompletionRatio ?? "", label: "Completion", width: 11 },
          { get: (row) => row.effective?.CacheRatio ?? "", label: "Cache", width: 7 },
          { get: (row) => row.effective?.CreateCacheRatio ?? "", label: "CacheWrite", width: 10 },
          { get: (row) => row.price_usd, label: "$/req", width: 9 },
          { get: (row) => row.billing_details?.mode ?? "ratio", label: "mode", width: 12 },
          { key: "version", label: "version", width: 12 },
        ],
      });
    }
    case "set": {
      const model = requireId(flags.model ?? rest[0], "--model");
      const pricing = pickDefined({
        ModelRatio: flags.ratio !== undefined ? numeric(flags.ratio, "--ratio") : flags["usd-per-1m"] !== undefined ? usdPerMillionToRatio(numeric(flags["usd-per-1m"], "--usd-per-1m")) : undefined,
        ModelPrice: flags.price !== undefined ? numeric(flags.price, "--price") : undefined,
        CompletionRatio: flags["completion-ratio"] !== undefined ? numeric(flags["completion-ratio"], "--completion-ratio") : undefined,
        CacheRatio: flags["cache-ratio"] !== undefined ? numeric(flags["cache-ratio"], "--cache-ratio") : undefined,
        CreateCacheRatio: flags["create-cache-ratio"] !== undefined ? numeric(flags["create-cache-ratio"], "--create-cache-ratio") : undefined,
        ImageRatio: flags["image-ratio"] !== undefined ? numeric(flags["image-ratio"], "--image-ratio") : undefined,
        AudioRatio: flags["audio-ratio"] !== undefined ? numeric(flags["audio-ratio"], "--audio-ratio") : undefined,
        AudioCompletionRatio: flags["audio-completion-ratio"] !== undefined ? numeric(flags["audio-completion-ratio"], "--audio-completion-ratio") : undefined,
        "billing_setting.billing_mode": flags["billing-mode"],
        "billing_setting.billing_expr": flags["billing-expr"],
      });
      const reset = flagBool(flags.reset);
      if (Object.keys(pricing).length === 0 && !reset) {
        throw new UsageError("pricing set needs at least one of --ratio, --usd-per-1m, --price, --completion-ratio, --cache-ratio, --create-cache-ratio, --image-ratio, --audio-ratio, --audio-completion-ratio, --billing-mode, --billing-expr, or --reset");
      }
      // Read the current version first: PATCH is optimistic-locked on it.
      const snapshot = await call(ctx, { method: "GET", path: "/api/option/model_pricing", query: { model } });
      const entry = (snapshot.data?.entries ?? []).find((item) => item.model_name === model);
      const expected = entry?.version ?? snapshot.data?.empty_version ?? "";
      const body = { changes: [{ model_name: model, expected_version: expected, pricing, ...(reset ? { reset: true } : {}) }] };
      const result = await call(ctx, { method: "PATCH", path: "/api/option/model_pricing", body });
      const usdNote =
        pricing.ModelPrice !== undefined
          ? `fixed price $${pricing.ModelPrice}/request`
          : pricing.ModelRatio !== undefined
            ? `ratio ${pricing.ModelRatio} = $${ratioToUsdPerMillion(pricing.ModelRatio)}/1M tokens`
            : "";
      return emit(ctx, result, { summary: `updated pricing for ${model} ${usdNote}`.trim() });
    }
    case "preview": {
      const model = requireId(flags.model ?? rest[0], "--model");
      const pricing = pickDefined({
        ModelRatio: flags.ratio !== undefined ? numeric(flags.ratio, "--ratio") : undefined,
        ModelPrice: flags.price !== undefined ? numeric(flags.price, "--price") : undefined,
        CompletionRatio: flags["completion-ratio"] !== undefined ? numeric(flags["completion-ratio"], "--completion-ratio") : undefined,
        CacheRatio: flags["cache-ratio"] !== undefined ? numeric(flags["cache-ratio"], "--cache-ratio") : undefined,
        CreateCacheRatio: flags["create-cache-ratio"] !== undefined ? numeric(flags["create-cache-ratio"], "--create-cache-ratio") : undefined,
      });
      const result = await call(ctx, { method: "POST", path: "/api/option/model_pricing/preview", body: { model_name: model, pricing } });
      return emit(ctx, result, { summary: `effective pricing for ${model}: ${JSON.stringify(result.data?.effective)}` });
    }
    case "convert": {
      const model = requireId(flags.model ?? rest[0], "--model");
      const pricing = pickDefined({
        ModelRatio: flags.ratio !== undefined ? numeric(flags.ratio, "--ratio") : undefined,
        ModelPrice: flags.price !== undefined ? numeric(flags.price, "--price") : undefined,
        CompletionRatio: flags["completion-ratio"] !== undefined ? numeric(flags["completion-ratio"], "--completion-ratio") : undefined,
        CacheRatio: flags["cache-ratio"] !== undefined ? numeric(flags["cache-ratio"], "--cache-ratio") : undefined,
        CreateCacheRatio: flags["create-cache-ratio"] !== undefined ? numeric(flags["create-cache-ratio"], "--create-cache-ratio") : undefined,
      });
      const result = await call(ctx, { method: "POST", path: "/api/option/model_pricing/convert", body: { model_name: model, pricing } });
      return emit(ctx, result, { summary: `expression: ${result.data?.expression ?? `<none> (${result.data?.unsupported_reason ?? ""})`}` });
    }
    case "bulk": {
      // Apply a whole file of per-model changes, each re-read for its current version so
      // concurrent edits surface as a conflict rather than silently overwriting.
      const changes = readJsonFile(flags.file, { flagName: "file" });
      if (!Array.isArray(changes) && !Array.isArray(changes?.changes)) {
        throw new UsageError("pricing bulk needs --file <json> containing an array of {model_name, pricing|reset} entries");
      }
      const list = Array.isArray(changes) ? changes : changes.changes;
      const models = list.map((item) => item.model_name);
      const snapshot = await call(ctx, { method: "GET", path: "/api/option/model_pricing", query: { model: models } });
      const versions = new Map((snapshot.data?.entries ?? []).map((entry) => [entry.model_name, entry.version]));
      const emptyVersion = snapshot.data?.empty_version ?? "";
      const resolved = list.map((item) => ({
        model_name: item.model_name,
        expected_version: item.expected_version ?? versions.get(item.model_name) ?? emptyVersion,
        pricing: item.pricing ?? {},
        ...(item.reset ? { reset: true } : {}),
      }));
      const result = await call(ctx, { method: "PATCH", path: "/api/option/model_pricing", body: { changes: resolved } });
      return emit(ctx, result, { summary: `updated ${resolved.length} model(s): ${JSON.stringify(result.data?.updated_models ?? [])}` });
    }
    case "options-get": {
      const result = await call(ctx, { method: "GET", path: "/api/option/" });
      const wanted = flagList(flags.key ?? rest[0]);
      let options = result.data ?? [];
      if (wanted?.length) options = options.filter((option) => wanted.includes(option.key));
      if (ctx.json) {
        printJson(options);
        return 0;
      }
      return emit(ctx, { data: options }, {
        table: options.map((option) => ({
          key: option.key,
          size: typeof option.value === "string" ? option.value.length : JSON.stringify(option.value ?? "").length,
          preview: typeof option.value === "string" ? option.value.slice(0, 80) : JSON.stringify(option.value ?? "").slice(0, 80),
        })),
        columns: [
          { key: "key", label: "key", width: 34 },
          { key: "size", label: "len", width: 7 },
          { key: "preview", label: "value (truncated)", width: 80 },
        ],
      });
    }
    case "options-set": {
      // PUT /api/option/ takes ONE {key, value} pair and coerces value to a string, so a
      // JSON object must be passed as a JSON *string*.
      const key = requireId(flags.key ?? rest[0], "--key");
      let value = flags.value ?? rest[1];
      if (value === undefined) throw new UsageError("pricing options-set needs --value '<string>' or --value-file <path>");
      if (flags["value-file"]) value = readFileSync(flags["value-file"], "utf8").trim();
      if (flags["json-value"]) {
        value = typeof flags["json-value"] === "string" ? flags["json-value"] : JSON.stringify(JSON.parse(String(flags["json-value"])));
      }
      const result = await call(ctx, { method: "PUT", path: "/api/option/", body: { key, value: String(value) } });
      return emit(ctx, result, { summary: `set option ${key}` });
    }
    case "model-ratio-map": {
      // Convenience for the single most common bulk edit: replace the whole ModelRatio map.
      const map = readJsonFile(flags.file, { flagName: "file" });
      if (!map || typeof map !== "object") throw new UsageError("pricing model-ratio-map needs --file <json> containing {model: ratio}");
      const result = await call(ctx, { method: "PUT", path: "/api/option/", body: { key: "ModelRatio", value: JSON.stringify(map) } });
      return emit(ctx, { data: result.data }, { summary: `replaced ModelRatio with ${Object.keys(map).length} entries` });
    }
    case "reset-model-ratio": {
      requireYes(ctx, "Resetting ModelRatio to built-in defaults");
      const result = await call(ctx, { method: "POST", path: "/api/option/rest_model_ratio", destructive: true });
      return emit(ctx, result, { summary: result.message ?? "ModelRatio reset to built-in defaults (ModelPrice and other ratio maps are untouched)" });
    }
    case "sync-channels": {
      const result = await call(ctx, { method: "GET", path: "/api/ratio_sync/channels" });
      const channels = result.data ?? [];
      return emit(ctx, result, {
        summary: `${channels.length} syncable source(s)  (id -100 = official preset, -101 = models.dev preset)`,
        table: channels,
        columns: [
          { key: "id", label: "id", width: 7 },
          { key: "name", label: "name", width: 30 },
          { get: (row) => channelTypeName(row.type), label: "type", width: 14 },
          { key: "base_url", label: "base_url", width: 44 },
          { get: (row) => CHANNEL_STATUS[row.status] ?? "", label: "status", width: 18 },
        ],
      });
    }
    case "sync-fetch": {
      const body = pickDefined({
        channel_ids: (flagList(flags["channel-ids"] ?? flags.ids) ?? []).map((value) => numeric(value, "channel id")),
        upstreams: flags.upstream ? [{ name: flags.name ?? flags.upstream, base_url: flags.upstream, endpoint: flags.endpoint ?? "" }] : undefined,
        timeout: flagInt(flags.timeout, "timeout"),
      });
      if (!body.channel_ids?.length && !body.upstreams) {
        throw new UsageError("pricing sync-fetch needs --channel-ids 1,2 or --upstream https://host [--endpoint /api/pricing]");
      }
      const result = await call(ctx, { method: "POST", path: "/api/ratio_sync/fetch", body });
      const differences = result.data?.differences ?? {};
      const rows = [];
      for (const [model, fields] of Object.entries(differences)) {
        for (const [field, item] of Object.entries(fields)) {
          rows.push({ model, field, current: item.current, upstream: JSON.stringify(item.upstreams ?? {}) });
        }
      }
      return emit(ctx, result, {
        summary: `${rows.length} difference row(s); test_results=${JSON.stringify(result.data?.test_results ?? [])}`,
        table: rows,
        columns: [
          { key: "model", label: "model", width: 34 },
          { key: "field", label: "field", width: 24 },
          { key: "current", label: "current", width: 10 },
          { key: "upstream", label: "upstream", width: 48 },
        ],
      });
    }
    case "cost": {
      // Local arithmetic: the CLI's own reproduction of the server's formula, for
      // sanity-checking a ratio before applying it.
      const model = requireId(flags.model ?? rest[0], "--model");
      const snapshot = await call(ctx, { method: "GET", path: "/api/option/model_pricing", query: { model } });
      const entry = (snapshot.data?.entries ?? []).find((item) => item.model_name === model);
      const effective = entry?.effective ?? {};
      const promptTokens = flagInt(flags["prompt-tokens"], "prompt-tokens") ?? 0;
      const completionTokens = flagInt(flags["completion-tokens"], "completion-tokens") ?? 0;
      const cacheTokens = flagInt(flags["cache-tokens"], "cache-tokens") ?? 0;
      const createCacheTokens = flagInt(flags["create-cache-tokens"], "create-cache-tokens") ?? 0;
      const groupRatio = flags["group-ratio"] !== undefined ? numeric(flags["group-ratio"], "--group-ratio") : (await groupRatioFor(ctx, flags.group)) ?? 1;
      const unit = await quotaPerUnit(ctx);
      const quota = estimateTextQuota(
        { ...effective, groupRatio },
        { promptTokens, completionTokens, cacheTokens, createCacheTokens },
        unit,
      );
      // estimateTextQuota takes the API's own field names, so `effective` passes through unchanged.
      const summary = [
        `model          ${model}`,
        `ModelRatio     ${effective.ModelRatio ?? "?"}  (= $${ratioToUsdPerMillion(effective.ModelRatio ?? 0).toFixed(4)}/1M tokens)`,
        `ModelPrice     ${effective.ModelPrice ?? "-"}${effective.ModelPrice ? " (fixed, ratios bypassed)" : ""}`,
        `group ratio    ${groupRatio}`,
        `tokens         prompt=${promptTokens} completion=${completionTokens} cache=${cacheTokens} cache_write=${createCacheTokens}`,
        `=> quota       ${Math.round(quota)}`,
        `=> USD         $${quotaToUsd(quota, unit).toFixed(6)}   (1 USD = ${unit} quota)`,
      ].join("\n");
      process.stdout.write(`${summary}\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown pricing subcommand "${action}". See \`newapi-admin help pricing\`.`);
  }
}

async function groupRatioFor(ctx, group) {
  if (!group) return undefined;
  try {
    const result = await request(ctx.config, { method: "GET", path: "/api/option/" });
    const row = (result.data ?? []).find((option) => option.key === "GroupRatio");
    if (!row) return undefined;
    const map = JSON.parse(String(row.value));
    const value = Number(map[group]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

const USER_COLUMNS = [
  { key: "id", label: "id", width: 6 },
  { key: "username", label: "username", width: 20 },
  { key: "display_name", label: "display_name", width: 18 },
  { get: (row) => `${ROLE_NAMES[row.role] ?? row.role} (${row.role})`, label: "role", width: 14 },
  { get: (row) => USER_STATUS[row.status] ?? row.status, label: "status", width: 9 },
  { key: "group", label: "group", width: 14 },
  { key: "quota", label: "quota", width: 12 },
  { key: "used_quota", label: "used", width: 12 },
  { key: "email", label: "email", width: 24 },
];

async function cmdUsers(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "list": {
      // GET /api/user/ has no group/role/status filter; route those through `search`.
      if (flags.group || flags.status || flags.role || flags.keyword) {
        return cmdUsers(ctx, "search", rest);
      }
      const query = pageQuery(flags, { sort_by: flags["sort-by"], sort_order: flags["sort-order"] });
      if (ctx.all) {
        const items = await fetchAllPages(ctx, { path: "/api/user/", query });
        return emit(ctx, { data: { items, total: items.length } }, { summary: `${items.length} user(s)`, table: items, columns: USER_COLUMNS });
      }
      const result = await call(ctx, { method: "GET", path: "/api/user/", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, { summary: `${items.length} of ${result.data?.total ?? "?"} user(s)`, table: items, columns: USER_COLUMNS });
    }
    case "search": {
      const query = pageQuery(flags, {
        keyword: flags.keyword ?? rest[0],
        group: flags.group,
        role: flagInt(flags.role, "role"),
        status: flagInt(flags.status, "status"),
        sort_by: flags["sort-by"],
        sort_order: flags["sort-order"],
      });
      if (ctx.all) {
        const items = await fetchAllPages(ctx, { path: "/api/user/search", query });
        return emit(ctx, { data: { items, total: items.length } }, { summary: `${items.length} user(s)`, table: items, columns: USER_COLUMNS });
      }
      const result = await call(ctx, { method: "GET", path: "/api/user/search", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, { summary: `${items.length} of ${result.data?.total ?? "?"} user(s)`, table: items, columns: USER_COLUMNS });
    }
    case "get": {
      const id = requireId(rest[0] ?? flags.id, "user id");
      const result = await call(ctx, { method: "GET", path: `/api/user/${id}` });
      return emit(ctx, result);
    }
    case "create": {
      const body = pickDefined({
        username: requireId(flags.username ?? rest[0], "--username"),
        password: requireId(flags.password, "--password"),
        display_name: flags["display-name"],
        role: flagInt(flags.role, "role"),
      });
      const result = await call(ctx, { method: "POST", path: "/api/user/", body });
      return emit(ctx, result, { summary: `created user ${body.username} (the response does not include the new id; look it up with \`users search --keyword\`)` });
    }
    case "update": {
      // Only username/display_name/group/remark/password persist; role/status/quota are ignored here.
      const id = flagInt(rest[0] ?? flags.id, "id");
      const body = pickDefined({
        id: requireId(id, "user id"),
        username: flags.username,
        display_name: flags["display-name"],
        group: flags.group,
        remark: flags.remark,
        password: flags.password,
      });
      const result = await call(ctx, { method: "PUT", path: "/api/user/", body });
      return emit(ctx, result, { summary: `updated user ${body.id}` });
    }
    case "delete": {
      const id = requireId(rest[0] ?? flags.id, "user id");
      const result = await call(ctx, { method: "DELETE", path: `/api/user/${id}`, destructive: true });
      return emit(ctx, result, { summary: `permanently deleted user ${id} (hard delete; the row is gone)` });
    }
    case "manage": {
      const id = flagInt(rest[0] ?? flags.id, "id");
      const op = requireId(flags.action ?? rest[1], "--action");
      const body = { id: requireId(id, "user id"), action: op };
      if (op === "add_quota") {
        body.mode = requireId(flags.mode, "--mode (add|subtract|override)");
        if (flags.usd !== undefined) body.value = usdToQuota(numeric(flags.usd, "--usd"), await quotaPerUnit(ctx));
        else body.value = flagInt(flags.value, "value");
        if (body.value === undefined) throw new UsageError("user manage add_quota needs --value <quota> or --usd <amount>");
      }
      const destructive = ["delete"].includes(op);
      const result = await call(ctx, { method: "POST", path: "/api/user/manage", body, destructive });
      const detail = op === "add_quota" ? `${body.mode} ${body.value} quota` : JSON.stringify(result.data);
      return emit(ctx, result, { summary: `user ${body.id}: ${op} -> ${detail}` });
    }
    case "quota": {
      const id = flagInt(rest[0] ?? flags.id, "id");
      const mode = requireId(flags.mode ?? "add", "--mode");
      const unit = await quotaPerUnit(ctx);
      const value =
        flags.usd !== undefined ? usdToQuota(numeric(flags.usd, "--usd"), unit) : flagInt(flags.value, "value");
      if (value === undefined) throw new UsageError("users quota needs --value <quota> or --usd <amount>");
      const result = await call(ctx, {
        method: "POST",
        path: "/api/user/manage",
        body: { id: requireId(id, "user id"), action: "add_quota", mode, value },
      });
      const usd = quotaToUsd(value, unit);
      const detail =
        mode === "override" ? `balance set to ${value} quota ($${usd.toFixed(4)})` : `${mode} ${value} quota ($${usd.toFixed(4)})`;
      return emit(ctx, result, { summary: `user ${id}: ${detail}  [1 USD = ${unit} quota]` });
    }
    case "topups": {
      const query = pageQuery(flags, { keyword: flags.keyword });
      const result = await call(ctx, { method: "GET", path: "/api/user/topup", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, {
        summary: `${items.length} of ${result.data?.total ?? "?"} top-up record(s)`,
        table: items,
        columns: [
          { key: "id", label: "id", width: 6 },
          { key: "user_id", label: "user", width: 6 },
          { key: "trade_no", label: "trade_no", width: 34 },
          { key: "amount", label: "amount", width: 10 },
          { key: "money", label: "money", width: 10 },
          { key: "payment_provider", label: "provider", width: 14 },
          { key: "status", label: "status", width: 9 },
          { get: (row) => isoToIsoSafe(row.create_time), label: "created", width: 20 },
        ],
      });
    }
    case "topup-complete": {
      const tradeNo = requireId(flags["trade-no"] ?? rest[0], "--trade-no");
      const result = await call(ctx, { method: "POST", path: "/api/user/topup/complete", body: { trade_no: tradeNo } });
      return emit(ctx, result, { summary: `completed top-up ${tradeNo}` });
    }
    case "bindings": {
      const id = requireId(rest[0] ?? flags.id, "user id");
      const result = await call(ctx, { method: "GET", path: `/api/user/${id}/oauth/bindings` });
      return emit(ctx, result);
    }
    case "unbind": {
      const id = requireId(rest[0] ?? flags.id, "user id");
      const kind = requireId(flags.type ?? rest[1], "--type (email|github|discord|oidc|wechat|telegram|linuxdo) or --provider-id");
      const path = flags["provider-id"] ? `/api/user/${id}/oauth/bindings/${flags["provider-id"]}` : `/api/user/${id}/bindings/${kind}`;
      const result = await call(ctx, { method: "DELETE", path, destructive: true });
      return emit(ctx, result, { summary: `cleared ${kind} binding for user ${id}` });
    }
    case "reset-passkey": {
      const id = requireId(rest[0] ?? flags.id, "user id");
      const result = await call(ctx, { method: "DELETE", path: `/api/user/${id}/reset_passkey`, destructive: true });
      return emit(ctx, result, { summary: `reset passkey for user ${id}` });
    }
    case "disable-2fa": {
      const id = requireId(rest[0] ?? flags.id, "user id");
      const result = await call(ctx, { method: "DELETE", path: `/api/user/${id}/2fa`, destructive: true });
      return emit(ctx, result, { summary: `disabled 2FA for user ${id}` });
    }
    case "2fa-stats": {
      const result = await call(ctx, { method: "GET", path: "/api/user/2fa/stats" });
      return emit(ctx, result);
    }
    case "self": {
      const result = await call(ctx, { method: "GET", path: "/api/user/self" });
      return emit(ctx, result);
    }
    case "me": {
      const result = await call(ctx, { method: "GET", path: "/api/user/self" });
      const data = result.data ?? {};
      const unit = await quotaPerUnit(ctx);
      return emit(ctx, result, {
        summary: [
          `id         ${data.id}`,
          `username   ${data.username}`,
          `role       ${ROLE_NAMES[data.role] ?? data.role}`,
          `group      ${data.group}`,
          `quota      ${data.quota} (= $${quotaToUsd(data.quota ?? 0, unit).toFixed(4)})`,
          `used       ${data.used_quota}`,
          `requests   ${data.request_count}`,
        ].join("\n"),
      });
    }
    default:
      throw new UsageError(`unknown users subcommand "${action}". See \`newapi-admin help users\`.`);
  }
}

function isoToIsoSafe(seconds) {
  const value = Number(seconds);
  if (!value) return "";
  return new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// tokens (self-scoped: the API has no admin route for another user's tokens)
// ---------------------------------------------------------------------------

async function cmdTokens(ctx, action, rest) {
  const flags = ctx.flags;
  const NOTE = "note: token routes are self-scoped (UserAuth); an admin cannot manage another user's tokens over HTTP.";
  switch (action) {
    case "list":
    case "search": {
      const path = action === "search" ? "/api/token/search" : "/api/token/";
      const query = pageQuery(flags, { keyword: flags.keyword, token: flags.token });
      const result = await call(ctx, { method: "GET", path, query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, {
        summary: `${items.length} of ${result.data?.total ?? "?"} token(s)  [key is masked]`,
        table: items,
        columns: [
          { key: "id", label: "id", width: 6 },
          { key: "name", label: "name", width: 24 },
          { key: "key", label: "key (masked)", width: 22 },
          { get: (row) => ["", "enabled", "disabled", "expired", "exhausted"][row.status] ?? row.status, label: "status", width: 10 },
          { get: (row) => (row.unlimited_quota ? "unlimited" : row.remain_quota), label: "remain", width: 11 },
          { get: (row) => (row.expired_time === -1 ? "never" : isoToIsoSafe(row.expired_time)), label: "expires", width: 20 },
          { key: "group", label: "group", width: 12 },
          { key: "model_limits", label: "model_limits", width: 30 },
        ],
      });
    }
    case "get": {
      const id = requireId(rest[0] ?? flags.id, "token id");
      const result = await call(ctx, { method: "GET", path: `/api/token/${id}` });
      return emit(ctx, result);
    }
    case "create": {
      const body = pickDefined({
        name: requireId(flags.name ?? rest[0], "--name"),
        expired_time: flags["expired-time"] !== undefined ? isoToUnixSafe(flags["expired-time"]) : undefined,
        remain_quota: flags.usd !== undefined ? usdToQuota(numeric(flags.usd, "--usd"), await quotaPerUnit(ctx)) : flagInt(flags["remain-quota"], "remain-quota"),
        unlimited_quota: flagBool(flags["unlimited-quota"]),
        model_limits_enabled: flagBool(flags["model-limits-enabled"]),
        model_limits: flags["model-limits"],
        allow_ips: flags["allow-ips"],
        group: flags.group,
        cross_group_retry: flagBool(flags["cross-group-retry"]),
        auto_groups: flagList(flags["auto-groups"]),
      });
      const result = await call(ctx, { method: "POST", path: "/api/token/", body });
      return emit(ctx, result, { summary: `created token ${body.name}; the key is not returned — read it with \`tokens key <id>\`. ${NOTE}` });
    }
    case "update": {
      const id = flagInt(rest[0] ?? flags.id, "id");
      const body = pickDefined({
        id: requireId(id, "token id"),
        name: flags.name,
        status: flagInt(flags.status, "status"),
        expired_time: flags["expired-time"] !== undefined ? isoToUnixSafe(flags["expired-time"]) : undefined,
        remain_quota: flags.usd !== undefined ? usdToQuota(numeric(flags.usd, "--usd"), await quotaPerUnit(ctx)) : flagInt(flags["remain-quota"], "remain-quota"),
        unlimited_quota: flagBool(flags["unlimited-quota"]),
        model_limits_enabled: flagBool(flags["model-limits-enabled"]),
        model_limits: flags["model-limits"],
        allow_ips: flags["allow-ips"],
        group: flags.group,
        cross_group_retry: flagBool(flags["cross-group-retry"]),
      });
      const query = pickDefined({ status_only: flagBool(flags["status-only"]) });
      const result = await call(ctx, { method: "PUT", path: "/api/token/", body, query });
      return emit(ctx, result, { summary: `updated token ${body.id}` });
    }
    case "delete": {
      const id = requireId(rest[0] ?? flags.id, "token id");
      const result = await call(ctx, { method: "DELETE", path: `/api/token/${id}`, destructive: true });
      return emit(ctx, result, { summary: `deleted token ${id}` });
    }
    case "batch-delete": {
      const ids = (flagList(rest[0] ?? flags.ids) ?? []).map((value) => numeric(value, "id"));
      if (!ids.length) throw new UsageError("tokens batch-delete needs --ids 1,2,3");
      const result = await call(ctx, { method: "POST", path: "/api/token/batch", body: { ids }, destructive: true });
      return emit(ctx, result, { summary: `deleted ${result.data ?? 0} token(s)` });
    }
    case "key": {
      const id = requireId(rest[0] ?? flags.id, "token id");
      const result = await call(ctx, { method: "POST", path: `/api/token/${id}/key` });
      return emit(ctx, result, { summary: `token ${id} key: ${result.data?.key ?? "<not returned>"}` });
    }
    case "keys": {
      const ids = (flagList(rest[0] ?? flags.ids) ?? []).map((value) => numeric(value, "id"));
      if (!ids.length) throw new UsageError("tokens keys needs --ids 1,2,3 (max 100)");
      const result = await call(ctx, { method: "POST", path: "/api/token/batch/keys", body: { ids } });
      return emit(ctx, result);
    }
    case "auto-groups": {
      const result = await call(ctx, { method: "GET", path: "/api/token/auto-groups" });
      return emit(ctx, result);
    }
    case "usage": {
      // Authenticates with the token key itself, not the panel token.
      const key = requireId(flags.key ?? rest[0], "token key");
      const response = await fetch(`${ctx.config.baseUrl}/api/usage/token/`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(ctx.config.timeoutMs),
      });
      const data = await response.json();
      if (!data.code) throw new ApiError(String(data.message ?? "usage request failed"), { status: response.status });
      return emit(ctx, { data: data.data }, { summary: JSON.stringify(data.data, null, 2) });
    }
    default:
      throw new UsageError(`unknown tokens subcommand "${action}". See \`newapi-admin help tokens\`.`);
  }
}

function isoToUnixSafe(value) {
  if (value === "never" || value === "-1") return -1;
  return isoToUnix(value);
}

// ---------------------------------------------------------------------------
// redemptions
// ---------------------------------------------------------------------------

async function cmdRedemptions(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "list":
    case "search": {
      const path = action === "search" ? "/api/redemption/search" : "/api/redemption/";
      const query = pageQuery(flags, { keyword: flags.keyword, status: flags.status });
      const result = await call(ctx, { method: "GET", path, query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, {
        summary: `${items.length} of ${result.data?.total ?? "?"} redemption code(s)`,
        table: items,
        columns: [
          { key: "id", label: "id", width: 6 },
          { key: "name", label: "name", width: 22 },
          { key: "key", label: "code", width: 36 },
          { get: (row) => ["", "unused", "disabled", "used"][row.status] ?? row.status, label: "status", width: 9 },
          { key: "quota", label: "quota", width: 12 },
          { get: (row) => (row.expired_time ? isoToIsoSafe(row.expired_time) : "never"), label: "expires", width: 20 },
          { get: (row) => (row.redeemed_time ? isoToIsoSafe(row.redeemed_time) : ""), label: "redeemed", width: 20 },
        ],
      });
    }
    case "get": {
      const id = requireId(rest[0] ?? flags.id, "redemption id");
      const result = await call(ctx, { method: "GET", path: `/api/redemption/${id}` });
      return emit(ctx, result);
    }
    case "create": {
      const unit = await quotaPerUnit(ctx);
      const quota = flags.usd !== undefined ? usdToQuota(numeric(flags.usd, "--usd"), unit) : flagInt(flags.quota, "quota");
      const body = pickDefined({
        name: requireId(flags.name ?? rest[0], "--name"),
        count: flagInt(flags.count, "count") ?? 1,
        quota: requireId(quota, "--quota or --usd"),
        expired_time: flags["expired-time"] !== undefined ? isoToUnixSafe(flags["expired-time"]) : 0,
      });
      const result = await call(ctx, { method: "POST", path: "/api/redemption/", body });
      const codes = result.data ?? [];
      return emit(ctx, result, { summary: `${codes.length} code(s) created (quota each = ${body.quota} = $${quotaToUsd(body.quota, unit).toFixed(4)}):\n${codes.join("\n")}` });
    }
    case "update": {
      const id = flagInt(rest[0] ?? flags.id, "id");
      const unit = await quotaPerUnit(ctx);
      const body = pickDefined({
        id: requireId(id, "redemption id"),
        name: flags.name,
        quota: flags.usd !== undefined ? usdToQuota(numeric(flags.usd, "--usd"), unit) : flagInt(flags.quota, "quota"),
        status: flagInt(flags.status, "status"),
        expired_time: flags["expired-time"] !== undefined ? isoToUnixSafe(flags["expired-time"]) : undefined,
      });
      const query = pickDefined({ status_only: flagBool(flags["status-only"]) });
      const result = await call(ctx, { method: "PUT", path: "/api/redemption/", body, query });
      return emit(ctx, result, { summary: `updated redemption ${body.id}` });
    }
    case "delete": {
      const id = requireId(rest[0] ?? flags.id, "redemption id");
      const result = await call(ctx, { method: "DELETE", path: `/api/redemption/${id}`, destructive: true });
      return emit(ctx, result, { summary: `deleted redemption ${id}` });
    }
    case "batch-delete": {
      const ids = (flagList(rest[0] ?? flags.ids) ?? []).map((value) => numeric(value, "id"));
      if (!ids.length) throw new UsageError("redemptions batch-delete needs --ids 1,2,3 (max 1000)");
      const result = await call(ctx, { method: "POST", path: "/api/redemption/batch", body: { ids }, destructive: true });
      return emit(ctx, result, { summary: `deleted ${result.data ?? 0} code(s)` });
    }
    case "delete-invalid": {
      requireYes(ctx, "Deleting every used, disabled and expired redemption code");
      const result = await call(ctx, { method: "DELETE", path: "/api/redemption/invalid", destructive: true });
      return emit(ctx, result, { summary: `deleted ${result.data ?? 0} invalid code(s)` });
    }
    case "redeem": {
      const code = requireId(flags.key ?? rest[0], "--key");
      const result = await call(ctx, { method: "POST", path: "/api/user/topup", body: { key: code } });
      return emit(ctx, result, { summary: `redeemed ${code}` });
    }
    default:
      throw new UsageError(`unknown redemptions subcommand "${action}". See \`newapi-admin help redemptions\`.`);
  }
}

// ---------------------------------------------------------------------------
// logs and data
// ---------------------------------------------------------------------------

async function cmdLogs(ctx, action, rest) {
  const flags = ctx.flags;
  const filterParams = (extra = {}) =>
    pickDefined({
      type: flags.type !== undefined ? resolveLogType(flags.type) : undefined,
      start_timestamp: flags.start !== undefined ? isoToUnix(flags.start) : undefined,
      end_timestamp: flags.end !== undefined ? isoToUnix(flags.end) : undefined,
      username: flags.username,
      token_name: flags["token-name"],
      model_name: flags.model,
      channel: flagInt(flags.channel, "channel"),
      group: flags.group,
      request_id: flags["request-id"],
      upstream_request_id: flags["upstream-request-id"],
      ...extra,
    });
  switch (action) {
    case "list": {
      if (flags.search) {
        process.stderr.write("note: /api/log/search is deprecated and always fails; using GET /api/log/ with filters.\n");
      }
      const query = pageQuery(flags, filterParams());
      if (ctx.all) {
        const items = await fetchAllPages(ctx, { path: "/api/log/", query });
        return emit(ctx, { data: { items, total: items.length } }, { summary: `${items.length} log row(s)`, table: items, columns: LOG_COLUMNS });
      }
      const result = await call(ctx, { method: "GET", path: "/api/log/", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, { summary: `${items.length} of ${result.data?.total ?? "?"} log row(s)`, table: items, columns: LOG_COLUMNS });
    }
    case "self": {
      const query = pageQuery(flags, pickDefined({
        type: flags.type !== undefined ? resolveLogType(flags.type) : undefined,
        start_timestamp: flags.start !== undefined ? isoToUnix(flags.start) : undefined,
        end_timestamp: flags.end !== undefined ? isoToUnix(flags.end) : undefined,
        token_name: flags["token-name"],
        model_name: flags.model,
        group: flags.group,
        request_id: flags["request-id"],
      }));
      const result = await call(ctx, { method: "GET", path: "/api/log/self", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, { summary: `${items.length} of ${result.data?.total ?? "?"} own log row(s)`, table: items, columns: LOG_COLUMNS });
    }
    case "stat":
    case "self-stat": {
      const path = action === "stat" ? "/api/log/stat" : "/api/log/self/stat";
      const query = filterParams();
      const result = await call(ctx, { method: "GET", path, query });
      const data = result.data ?? {};
      const unit = await quotaPerUnit(ctx);
      return emit(ctx, result, {
        summary: [
          `quota   ${data.quota ?? 0}  ($${quotaToUsd(data.quota ?? 0, unit).toFixed(4)} in the requested window)`,
          `rpm     ${data.rpm ?? 0}    (always the last 60 seconds, ignores start/end)`,
          `tpm     ${data.tpm ?? 0}    (always the last 60 seconds, ignores start/end)`,
        ].join("\n"),
      });
    }
    case "cleanup": {
      requireYes(ctx, "Creating a log cleanup task");
      const query = pickDefined({ target_timestamp: flags.before !== undefined ? isoToUnix(flags.before) : flagInt(flags["target-timestamp"], "target-timestamp") });
      const result = await call(ctx, { method: "POST", path: "/api/system-task/log-cleanup", query, destructive: true });
      return emit(ctx, result, { summary: `log cleanup task created: ${JSON.stringify(result.data)}` });
    }
    default:
      throw new UsageError(`unknown logs subcommand "${action}". See \`newapi-admin help logs\`.`);
  }
}

const LOG_COLUMNS = [
  { key: "id", label: "id", width: 8 },
  { get: (row) => isoToIsoSafe(row.created_at), label: "time", width: 20 },
  { get: (row) => LOG_TYPES[row.type] ?? row.type, label: "type", width: 8 },
  { key: "username", label: "user", width: 14 },
  { key: "model_name", label: "model", width: 26 },
  { key: "channel_name", label: "channel", width: 16 },
  { key: "quota", label: "quota", width: 10 },
  { get: (row) => `${row.prompt_tokens ?? 0}+${row.completion_tokens ?? 0}`, label: "tokens", width: 12 },
  { key: "use_time", label: "s", width: 5 },
  { key: "content", label: "content", width: 40 },
];

function resolveLogType(value) {
  if (value === undefined) return undefined;
  const text = String(value).toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  for (const [code, label] of Object.entries(LOG_TYPES)) if (label === text) return Number(code);
  throw new UsageError(`--type "${value}" is not a known log type (all,topup,consume,manage,system,error,refund,login or 0-7)`);
}

async function cmdData(ctx, action, rest) {
  const flags = ctx.flags;
  const range = pickDefined({
    start_timestamp: flags.start !== undefined ? isoToUnix(flags.start) : undefined,
    end_timestamp: flags.end !== undefined ? isoToUnix(flags.end) : undefined,
    username: flags.username,
  });
  switch (action) {
    case "usage": {
      const result = await call(ctx, { method: "GET", path: "/api/data/", query: range });
      const rows = result.data ?? [];
      return emit(ctx, result, { summary: `${rows.length} aggregated row(s)`, table: rows, columns: QUOTA_DATA_COLUMNS });
    }
    case "by-user": {
      const result = await call(ctx, { method: "GET", path: "/api/data/users", query: range });
      const rows = result.data ?? [];
      return emit(ctx, result, { summary: `${rows.length} user aggregate row(s)`, table: rows, columns: QUOTA_DATA_COLUMNS });
    }
    case "flow": {
      if (range.start_timestamp === undefined || range.end_timestamp === undefined) {
        throw new UsageError("data flow requires --start and --end (the server rejects an unbounded range)");
      }
      const result = await call(ctx, { method: "GET", path: "/api/data/flow", query: range });
      const rows = result.data ?? [];
      return emit(ctx, result, { summary: `${rows.length} flow row(s)`, table: rows, columns: FLOW_COLUMNS });
    }
    case "self": {
      const result = await call(ctx, { method: "GET", path: "/api/data/self", query: range });
      const rows = result.data ?? [];
      return emit(ctx, result, { summary: `${rows.length} row(s) (window capped at 30 days)`, table: rows, columns: QUOTA_DATA_COLUMNS });
    }
    case "self-flow": {
      const result = await call(ctx, { method: "GET", path: "/api/data/flow/self", query: range });
      const rows = result.data ?? [];
      return emit(ctx, result, { summary: `${rows.length} row(s) (window capped at 30 days)`, table: rows, columns: FLOW_COLUMNS });
    }
    default:
      throw new UsageError("usage: newapi-admin data usage|by-user|flow|self|self-flow [--start t --end t]");
  }
}

const QUOTA_DATA_COLUMNS = [
  { key: "username", label: "username", width: 18 },
  { key: "model_name", label: "model", width: 30 },
  { key: "use_group", label: "group", width: 14 },
  { key: "channel_id", label: "channel", width: 8 },
  { key: "count", label: "count", width: 8 },
  { key: "token_used", label: "tokens", width: 12 },
  { key: "quota", label: "quota", width: 12 },
  { get: (row) => isoToIsoSafe(row.created_at), label: "created", width: 20 },
];

const FLOW_COLUMNS = [
  { key: "username", label: "username", width: 16 },
  { key: "token_name", label: "token", width: 16 },
  { key: "model_name", label: "model", width: 28 },
  { key: "channel_name", label: "channel", width: 16 },
  { key: "use_group", label: "group", width: 12 },
  { key: "count", label: "count", width: 8 },
  { key: "token_used", label: "tokens", width: 12 },
  { key: "quota", label: "quota", width: 12 },
];

// ---------------------------------------------------------------------------
// groups / vendors / prefill groups / options / system / tasks / audit
// ---------------------------------------------------------------------------

async function cmdGroups(ctx, action, rest) {
  const flags = ctx.flags;
  if (action === "ratios" || action === "with-ratios") {
    const result = await call(ctx, { method: "GET", path: "/api/option/" });
    const row = (result.data ?? []).find((option) => option.key === "GroupRatio");
    let map = {};
    try {
      map = JSON.parse(String(row?.value ?? "{}"));
    } catch {
      map = {};
    }
    const rows = Object.entries(map).map(([group, ratio]) => ({ group, ratio, usd_multiplier: ratio }));
    return emit(ctx, { data: map }, {
      summary: `${rows.length} group(s) — GroupRatio multiplies every request's quota`,
      table: rows,
      columns: [
        { key: "group", label: "group", width: 24 },
        { key: "ratio", label: "GroupRatio", width: 12 },
      ],
    });
  }
  const result = await call(ctx, { method: "GET", path: "/api/group/" });
  const groups = result.data ?? [];
  return emit(ctx, result, { summary: `${groups.length} group(s)\n${groups.join("\n")}` });
}

async function cmdVendors(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "list":
    case "search": {
      const query = pageQuery(flags, { keyword: flags.keyword, association: flags.association });
      const result = await call(ctx, { method: "GET", path: action === "search" ? "/api/vendors/search" : "/api/vendors/", query });
      const items = result.data?.items ?? [];
      return emit(ctx, result, {
        summary: `${items.length} of ${result.data?.total ?? "?"} vendor(s)`,
        table: items,
        columns: [
          { key: "id", label: "id", width: 6 },
          { key: "name", label: "name", width: 28 },
          { key: "model_count", label: "models", width: 8 },
          { key: "icon", label: "icon", width: 18 },
          { key: "version", label: "version", width: 14 },
          { key: "description", label: "description", width: 40 },
        ],
      });
    }
    case "get": {
      const id = requireId(rest[0] ?? flags.id, "vendor id");
      const result = await call(ctx, { method: "GET", path: `/api/vendors/${id}` });
      return emit(ctx, result);
    }
    case "create": {
      const body = pickDefined({
        name: requireId(flags.name ?? rest[0], "--name"),
        description: flags.description,
        icon: flags.icon,
      });
      const result = await call(ctx, { method: "POST", path: "/api/vendors/", body });
      return emit(ctx, result, { summary: `created vendor ${body.name} -> id ${result.data?.id ?? "?"}` });
    }
    case "update": {
      const body = pickDefined({
        id: requireId(flagInt(rest[0] ?? flags.id, "id"), "vendor id"),
        name: flags.name,
        description: flags.description,
        icon: flags.icon,
        version: flags.version,
      });
      const result = await call(ctx, { method: "PUT", path: "/api/vendors/", body });
      return emit(ctx, result, { summary: `updated vendor ${body.id}` });
    }
    case "delete": {
      const id = requireId(rest[0] ?? flags.id, "vendor id");
      const result = await call(ctx, { method: "DELETE", path: `/api/vendors/${id}`, destructive: true });
      return emit(ctx, result, { summary: `deleted vendor ${id}` });
    }
    case "operations":
    case "assign":
    case "merge":
    case "delete-many": {
      // Two-step optimistic-lock flow: preview returns a version token that apply must echo.
      const op = action === "operations" ? requireId(flags.action ?? rest[0], "--action (assign|merge|delete)") : action === "delete-many" ? "delete" : action;
      const body = pickDefined({
        action: op,
        vendor_ids: (flagList(flags["vendor-ids"] ?? (op === "assign" ? undefined : rest.slice(1).join(","))) ?? []).map((value) => numeric(value, "vendor id")),
        model_ids: (flagList(flags["model-ids"]) ?? []).map((value) => numeric(value, "model id")),
        target_vendor_id: flagInt(flags["target-vendor-id"], "target-vendor-id") ?? 0,
      });
      const previewResult = await call(ctx, { method: "POST", path: "/api/vendors/operations/preview", body });
      const version = previewResult.data?.version;
      if (previewResult.dryRun) return 0;
      if (!ctx.json) {
        process.stdout.write(`preview: action=${body.action} version=${version}\n`);
        process.stdout.write(`  sources: ${JSON.stringify((previewResult.data?.sources ?? []).map((vendor) => vendor.name))}\n`);
        process.stdout.write(`  target:  ${JSON.stringify(previewResult.data?.target?.name ?? null)}\n`);
        process.stdout.write(`  models:  ${(previewResult.data?.models ?? []).length}\n`);
      }
      const result = await call(ctx, {
        method: "POST",
        path: "/api/vendors/operations",
        body: { ...body, expected_version: version },
        destructive: true,
      });
      return emit(ctx, result, { summary: `applied ${body.action}: updated_models=${JSON.stringify(result.data?.updated_models ?? [])} deleted_vendors=${JSON.stringify(result.data?.deleted_vendors ?? [])}` });
    }
    default:
      throw new UsageError(`unknown vendors subcommand "${action}". See \`newapi-admin help vendors\`.`);
  }
}

async function cmdPrefill(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "list": {
      const result = await call(ctx, { method: "GET", path: "/api/prefill_group/", query: pickDefined({ type: flags.type }) });
      const items = result.data ?? [];
      return emit(ctx, result, {
        summary: `${items.length} prefill group(s)`,
        table: items,
        columns: [
          { key: "id", label: "id", width: 6 },
          { key: "name", label: "name", width: 26 },
          { key: "type", label: "type", width: 14 },
          { get: (row) => JSON.stringify(row.items ?? []).slice(0, 60), label: "items", width: 60 },
          { key: "description", label: "description", width: 30 },
        ],
      });
    }
    case "create": {
      const body = pickDefined({
        name: requireId(flags.name ?? rest[0], "--name"),
        type: requireId(flags.type, "--type (model|tag|endpoint|...)"),
        items: readJsonArg(flags.items, { flagName: "items" }),
        description: flags.description,
      });
      const result = await call(ctx, { method: "POST", path: "/api/prefill_group/", body });
      return emit(ctx, result, { summary: `created prefill group ${body.name}` });
    }
    case "update": {
      // The server Saves the whole record, so omitted fields are written as zero values.
      const body = pickDefined({
        id: requireId(flagInt(rest[0] ?? flags.id, "id"), "prefill group id"),
        name: flags.name,
        type: flags.type,
        items: flags.items !== undefined ? readJsonArg(flags.items, { flagName: "items" }) : [],
        description: flags.description ?? "",
      });
      if (!body.name || !body.type) throw new UsageError("prefill update overwrites the whole record: pass --name and --type too");
      const result = await call(ctx, { method: "PUT", path: "/api/prefill_group/", body });
      return emit(ctx, result, { summary: `updated prefill group ${body.id}` });
    }
    case "delete": {
      const id = requireId(rest[0] ?? flags.id, "prefill group id");
      const result = await call(ctx, { method: "DELETE", path: `/api/prefill_group/${id}`, destructive: true });
      return emit(ctx, result, { summary: `deleted prefill group ${id}` });
    }
    default:
      throw new UsageError("usage: newapi-admin prefill list|create|update|delete");
  }
}

async function cmdOptions(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "get":
      return cmdPricing(ctx, "options-get", rest);
    case "set":
      return cmdPricing(ctx, "options-set", rest);
    case "request-policy-get": {
      const result = await call(ctx, { method: "GET", path: "/api/option/request_policy" });
      const options = result.data?.options ?? {};
      const rows = Object.entries(options).map(([key, value]) => ({ key, value }));
      return emit(ctx, result, {
        summary: `${rows.length} request-policy key(s)`,
        table: rows,
        columns: [
          { key: "key", label: "key", width: 46 },
          { key: "value", label: "value", width: 60 },
        ],
      });
    }
    case "request-policy-set": {
      const pairs = parsePairs(flagList(flags.set), "set");
      if (Object.keys(pairs).length === 0) throw new UsageError("options request-policy-set needs --set key=value (repeatable)");
      const result = await call(ctx, { method: "PATCH", path: "/api/option/request_policy", body: { options: pairs } });
      return emit(ctx, result, { summary: `updated ${Object.keys(pairs).length} request-policy key(s)` });
    }
    case "payment-compliance": {
      const result = await call(ctx, { method: "POST", path: "/api/option/payment_compliance" });
      return emit(ctx, result, { summary: result.message ?? "payment compliance confirmed" });
    }
    case "affinity-cache": {
      const result = await call(ctx, { method: "GET", path: "/api/option/channel_affinity_cache" });
      return emit(ctx, result);
    }
    case "affinity-cache-clear": {
      requireYes(ctx, "Clearing the channel affinity cache");
      const result = await call(ctx, { method: "DELETE", path: "/api/option/channel_affinity_cache", destructive: true });
      return emit(ctx, result, { summary: "channel affinity cache cleared" });
    }
    case "passkey-domains": {
      const domains = (flagList(flags.domains ?? rest[0]) ?? []);
      const result = await call(ctx, { method: "PUT", path: "/api/option/passkey/domains", body: { domains } });
      return emit(ctx, result, { summary: `passkey domains set to ${domains.join(", ")}` });
    }
    default:
      throw new UsageError(`unknown options subcommand "${action}". See \`newapi-admin help options\`.`);
  }
}

async function cmdSystem(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "tasks": {
      const result = await call(ctx, { method: "GET", path: "/api/system-task/list" });
      const items = result.data ?? [];
      return emit(ctx, result, { summary: `${items.length} system task(s)`, table: items, columns: [
        { key: "id", label: "id", width: 8 },
        { key: "type", label: "type", width: 18 },
        { key: "status", label: "status", width: 14 },
        { get: (row) => isoToIsoSafe(row.created_at ?? row.create_time), label: "created", width: 20 },
      ] });
    }
    case "current": {
      const result = await call(ctx, { method: "GET", path: "/api/system-task/current", query: pickDefined({ type: flags.type }) });
      return emit(ctx, result);
    }
    case "task": {
      const id = requireId(rest[0] ?? flags.id, "task id");
      const result = await call(ctx, { method: "GET", path: `/api/system-task/${id}` });
      return emit(ctx, result);
    }
    case "task-history-delete": {
      requireYes(ctx, "Deleting system task history");
      const result = await call(ctx, { method: "DELETE", path: "/api/system-task/history", destructive: true });
      return emit(ctx, result, { summary: "system task history deleted" });
    }
    case "instances": {
      const result = await call(ctx, { method: "GET", path: "/api/system-info/instances" });
      const items = result.data ?? [];
      return emit(ctx, result, { summary: `${items.length} instance(s)`, table: items, columns: [
        { key: "node_name", label: "node_name", width: 24 },
        { get: (row) => isoToIsoSafe(row.last_seen ?? row.updated_time), label: "last_seen", width: 20 },
      ] });
    }
    case "stale-instances-delete": {
      requireYes(ctx, "Deleting stale system instances");
      const result = await call(ctx, { method: "DELETE", path: "/api/system-info/stale-instances", destructive: true });
      return emit(ctx, result, { summary: "stale instances deleted" });
    }
    case "instance-delete": {
      const name = requireId(rest[0] ?? flags.node, "node name");
      const result = await call(ctx, { method: "DELETE", path: `/api/system-info/instances/${encodeURIComponent(name)}`, destructive: true });
      return emit(ctx, result, { summary: `deleted instance ${name}` });
    }
    case "perf": {
      const result = await call(ctx, { method: "GET", path: "/api/performance/stats" });
      return emit(ctx, result);
    }
    case "log-files": {
      const result = await call(ctx, { method: "GET", path: "/api/performance/logs" });
      return emit(ctx, result);
    }
    case "log-files-clean": {
      requireYes(ctx, "Cleaning up log files");
      const result = await call(ctx, { method: "DELETE", path: "/api/performance/logs", destructive: true });
      return emit(ctx, result, { summary: "log files cleaned" });
    }
    case "cache-clear": {
      requireYes(ctx, "Clearing the disk cache");
      const result = await call(ctx, { method: "DELETE", path: "/api/performance/disk_cache", destructive: true });
      return emit(ctx, result, { summary: "disk cache cleared" });
    }
    case "gc": {
      const result = await call(ctx, { method: "POST", path: "/api/performance/gc" });
      return emit(ctx, result, { summary: "GC triggered" });
    }
    case "permissions": {
      const result = await call(ctx, { method: "GET", path: "/api/authz/catalog" });
      return emit(ctx, result);
    }
    default:
      throw new UsageError(`unknown system subcommand "${action}". See \`newapi-admin help system\`.`);
  }
}

async function cmdTasks(ctx, action, rest) {
  const flags = ctx.flags;
  switch (action) {
    case "list": {
      const path = flags.mj ? "/api/mj/" : "/api/task/";
      const result = await call(ctx, { method: "GET", path });
      const items = result.data ?? [];
      return emit(ctx, result, { summary: `${items.length} task(s)`, table: Array.isArray(items) ? items.slice(0, 50) : [], columns: [
        { key: "id", label: "id", width: 8 },
        { key: "task_id", label: "task_id", width: 34 },
        { key: "status", label: "status", width: 12 },
        { key: "model", label: "model", width: 24 },
        { key: "platform", label: "platform", width: 12 },
      ] });
    }
    case "self": {
      const path = flags.mj ? "/api/mj/self" : "/api/task/self";
      const result = await call(ctx, { method: "GET", path });
      return emit(ctx, result);
    }
    case "artifacts": {
      const id = requireId(rest[0] ?? flags.id, "task id");
      const result = await call(ctx, { method: "GET", path: `/api/task/${id}/artifacts` });
      return emit(ctx, result);
    }
    default:
      throw new UsageError("usage: newapi-admin tasks list|self|artifacts [--mj]");
  }
}

async function cmdAudit(ctx, action, rest) {
  const flags = ctx.flags;
  const query = pageQuery(flags, pickDefined({
    start_timestamp: flags.start !== undefined ? isoToUnix(flags.start) : undefined,
    end_timestamp: flags.end !== undefined ? isoToUnix(flags.end) : undefined,
    username: flags.username,
    keyword: flags.keyword,
  }));
  if (action === "self") {
    const result = await call(ctx, { method: "GET", path: "/api/audit/self", query });
    return emit(ctx, result);
  }
  const result = await call(ctx, { method: "GET", path: "/api/audit", query });
  const items = result.data?.items ?? result.data ?? [];
  return emit(ctx, result, { summary: `${Array.isArray(items) ? items.length : 0} audit row(s)`, table: Array.isArray(items) ? items : [] });
}

async function cmdSubscription(ctx, action, rest) {
  const flags = ctx.flags;
  const suffix = action === "plans" ? "/plans" : `/${action}`;
  const result = await call(ctx, { method: "GET", path: `/api/subscription/admin${suffix}`, query: pageQuery(flags) });
  return emit(ctx, result);
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

function usage(topic) {
  const sections = {
    channels: `channels — upstream channel management
  channels list [--group g] [--status enabled|disabled] [--type 1] [--sort-by id|name|priority|balance] [--all]
  channels search [--keyword k] [--model m] [--group g] [--status s] [--type t]
  channels get <id>
  channels add --name N --type 1|OpenAI --key sk-... [--base-url u] [--models a,b] [--group g]
                [--priority p] [--weight w] [--test-model m] [--tag t] [--mode single|batch|multi_to_single]
                [--channel-json '<json>'|@file]
  channels update <id> [same channel flags] [--key-mode append|replace]   (status is refused; use enable/disable)
  channels enable <id> | disable <id> | enable --ids 1,2 | disable --ids 1,2
  channels status-set --ids 1,2 --status 1|2
  channels test <id> [--model m] [--stream]      |  channels test all
  channels balance <id>                          |  channels balance all
  channels fetch-models <id>                     |  channels probe-models --type 1 --key sk-...
  channels models                                 (enabled model names)
  channels catalog                                (built-in model catalog)
  channels copy <id> [--suffix s] [--reset-balance false]
  channels fix                                    (rebuild the abilities table)
  channels key <id>                               (root + X-Security-Proof required)
  channels tag set --ids 1,2 [--tag name]  |  tag enable|disable --tag name
  channels tag edit --tag name [--new-tag x] [--models a,b] [--groups g] [--priority p] [--weight w]
  channels tag models --tag name
  channels keys status --channel <id> [--page 1] [--page-size 50] [--status 1|2|3]
  channels keys enable|disable|delete --channel <id> --index <n>
  channels keys enable-all|disable-all|delete-disabled --channel <id>
  channels upstream detect|detect-all|apply|apply-all [--ids 1,2]
  channels delete <id> --yes | batch-delete --ids 1,2 --yes | delete-disabled --yes`,
    models: `models — model metadata catalogue (separate from pricing)
  models list [--keyword k] [--vendor v] [--status enabled|disabled] [--sync-official yes|no]
              [--square-state visible|unavailable|hidden|partial] [--include-channel-models] [--all]
  models search [same flags]
  models get <id>
  models create --model-name gpt-4o [--description d] [--icon i] [--tags t] [--vendor-id n]
                 [--endpoints '<json>'] [--status 1] [--sync-official 1] [--name-rule 0..3]
  models update <id> [same flags] [--status-only]
  models missing
  models sync-preview [--locale zh|en|ja] [--save preview.json]
  models sync-apply --from-preview preview.json [--kinds create,update] [--models a,b]
  models delete <id> [--remove-from-channels] [--remove-pricing] --yes
  models batch-delete --model-ids 1,2 [--remove-from-channels] [--remove-pricing] --yes

  name_rule: 0 exact, 1 prefix, 2 contains, 3 suffix`,
    pricing: `pricing — model ratios, fixed prices and the option maps (root only)
  pricing get [--model gpt-4o]
  pricing set --model gpt-4o (--ratio 1.25 | --usd-per-1m 2.5) [--completion-ratio 4] [--cache-ratio .5]
              [--create-cache-ratio 1.25] [--image-ratio 1] [--audio-ratio 1] [--audio-completion-ratio 1]
              [--price 0.04] [--billing-mode ratio|tiered_expr] [--billing-expr '<expr>'] [--reset]
  pricing preview --model m [--ratio r] [--price p] ...      (no write)
  pricing convert --model m --ratio r                        (render as tiered_expr, no write)
  pricing bulk --file changes.json                           ([{model_name,pricing|reset}])
  pricing cost --model m --prompt-tokens N --completion-tokens N [--cache-tokens N] [--group g]
  pricing options-get [--key ModelRatio] [--key ModelPrice]
  pricing options-set --key ModelRatio --value '{"gpt-4o":1.25}'
  pricing model-ratio-map --file ratios.json                  (replaces the whole ModelRatio map)
  pricing sync-channels
  pricing sync-fetch (--channel-ids 1,2 | --upstream https://host [--endpoint /api/pricing])
  pricing reset-model-ratio --yes                             (ModelRatio only; destructive)

  Units: 1 ratio = $0.002/1K tokens = $2/1M tokens  =>  ratio = USD_per_1M / 2.
          ModelPrice is a fixed USD amount per request and bypasses all ratios.
          1 USD = QuotaPerUnit quota (default 500000).`,
    users: `users — user administration
  users list [--page 1] [--page-size 20] [--sort-by id|username|quota|group|created_at] [--all]
  users search [--keyword k] [--group g] [--role 1|10|100] [--status 1|2|-1] [--all]
  users get <id>
  users create --username u --password p [--display-name d] [--role 1|10]
  users update <id> [--username u] [--display-name d] [--group g] [--remark r] [--password p]
  users manage <id> --action enable|disable|delete|promote|demote
  users manage <id> --action add_quota --mode add|subtract|override (--value N | --usd N)
  users quota <id> [--mode add|subtract|override] (--value N | --usd N)
  users topups [--keyword t]
  users topup-complete --trade-no T
  users bindings <id> | users unbind <id> --type email|github|... [--provider-id n]
  users reset-passkey <id> | users disable-2fa <id> | users 2fa-stats
  users me | users self
  users delete <id> --yes        (HARD delete; "manage --action delete" is the soft one)

  role: 0 guest, 1 user, 10 admin, 100 root. status: 1 enabled, 2 disabled.`,
    tokens: `tokens — API tokens (self-scoped: no admin route for other users' tokens)
  tokens list | tokens search [--keyword k] [--token sk-...]
  tokens get <id>
  tokens create --name n [--expired-time '<date>'|never] (--usd 10 | --remain-quota N) [--unlimited-quota]
                [--model-limits a,b --model-limits-enabled] [--allow-ips '1.2.3.4'] [--group g]
  tokens update <id> [same flags] [--status 1|2] [--status-only]
  tokens key <id> | tokens keys --ids 1,2
  tokens auto-groups
  tokens usage --key sk-...            (authenticates with the token itself)
  tokens delete <id> --yes | tokens batch-delete --ids 1,2 --yes`,
    redemptions: `redemptions — redemption codes
  redemptions list | redemptions search [--keyword k] [--status 1|2|3|expired]
  redemptions get <id>
  redemptions create --name n [--count 10] (--usd 5 | --quota N) [--expired-time '<date>'|never]
                     (requires payment compliance to be confirmed)
  redemptions update <id> [--name n] [--quota N] [--usd N] [--expired-time t] [--status 1|2] [--status-only]
  redemptions redeem --key CODE
  redemptions delete <id> --yes | batch-delete --ids 1,2 --yes | delete-invalid --yes`,
    logs: `logs — request logs and statistics
  logs list [--type consume|error|...|0-7] [--start t] [--end t] [--username u] [--model m]
            [--token-name t] [--channel id] [--group g] [--request-id r] [--all]
  logs self  [same filters minus username/channel]
  logs stat | logs self-stat
  logs cleanup --before '<date>' --yes

  Note: GET /api/log/search is deprecated server-side and always fails. The CLI uses GET /api/log/.
  In logs stat, quota respects --start/--end but rpm and tpm always describe the last 60 seconds.`,
    data: `data — aggregated usage
  data usage [--start t] [--end t] [--username u]
  data by-user [--start t] [--end t]
  data flow --start t --end t [--username u]        (both bounds required by the server)
  data self [--start t] [--end t]                   (window capped at 30 days)
  data self-flow --start t --end t`,
    vendors: `vendors — model vendor records
  vendors list | search [--keyword k] [--association linked|unlinked]
  vendors get <id>
  vendors create --name n [--description d] [--icon i]
  vendors update <id> [--name n] [--description d] [--icon i] [--version v]
  vendors assign --model-ids 1,2 --target-vendor-id 3      (target 0 clears the assignment)
  vendors merge --vendor-ids 3,4 --target-vendor-id 1
  vendors delete-many --vendor-ids 3,4
  vendors delete <id> --yes

  assign/merge/delete run preview -> apply automatically, echoing the preview version token;
  apply is rejected with VENDOR_CONFLICT if anything changed in between.`,
    groups: `groups — group names and their quota multipliers
  groups list                     (plain group-name array from GET /api/group/)
  groups ratios                   (the GroupRatio map: group -> quota multiplier)

  There is no create-group route: a group starts existing the moment it appears as a key
  of GroupRatio. Assign users to it with \`users update <id> --group <name>\`.`,
    prefill: `prefill — prefill groups used as admin form defaults
  prefill list [--type model]
  prefill create --name n --type t [--items '<json>'] [--description d]
  prefill update <id> --name n --type t [--items '<json>']   (overwrites the whole record)
  prefill delete <id> --yes`,
    options: `options — root-only system options
  options get [--key ModelRatio] | options set --key K --value V
  options request-policy-get | options request-policy-set --set key=value [--set k2=v2]
  options payment-compliance
  options affinity-cache | options affinity-cache-clear --yes
  options passkey-domains '.example.com'

  Values travel as strings; setting a JSON object needs --value '<json string>'.`,
    system: `system — tasks, instances, performance, permissions
  system tasks | system current [--type t] | system task <id> | system task-history-delete --yes
  system instances | system stale-instances-delete --yes | system instance-delete <node> --yes
  system perf | system log-files | system log-files-clean --yes | system cache-clear --yes | system gc
  system permissions              (the authz permission catalogue)`,
    tasks: `tasks — generation tasks
  tasks list [--mj] | tasks self [--mj] | tasks artifacts <task_id>`,
    audit: `audit — who changed what
  audit [--start t] [--end t] [--username u] | audit self`,
    subscription: `subscription — subscription plans, admin view
  subscription plans | subscription self

  Creating and editing plans lives under /api/subscription/admin/*, which has no typed
  command; reach it with \`api POST /api/subscription/admin/plans --body @plan.json\`.`,
    api: `api — the universal passthrough
  api <METHOD> <PATH> [--query k=v ...] [--body '<json>' | --body @file | --body -]

  Reaches every mounted route, including the subsystems that have no typed command:
  task plugins (/api/plugin/task/*), deployments (/api/deployments/*), subscription admin
  (/api/subscription/admin/*), custom OAuth (/api/custom-oauth-provider/*).

  Destructive methods and delete/reset/cleanup paths still require --yes.`,
    routes: `routes — the bundled route index
  routes [term]      search by keyword, path fragment or group id
  routes --stats     route counts per permission tier

  Encoded from the router in the new-api source. Use it to find the right endpoint
  before reaching for \`api\`.`,
    config: `config — the resolved connection settings

  Prints the resolved base URL, a masked token, the user id, the timeout and which config
  file was read. Precedence: flags, then environment, then the config file.`,
    ping: `ping — health summary

  Calls the public GET /api/status and the admin GET /api/status/test, then prints the
  version, the setup state and QuotaPerUnit (the USD-to-quota rate every conversion uses).`,
    other: `available help topics:
  channels models pricing users tokens redemptions logs data groups vendors
  prefill options system tasks audit subscription api routes config ping

  run \`newapi-admin help <topic>\`, or \`newapi-admin <group>\` with no arguments to see
  that group's own usage text.`,
  };

  const root = `newapi-admin ${VERSION} — full-surface client for the New API management API

usage: newapi-admin <group> <subcommand> [args] [flags]

connection
  --base-url URL     New API base URL        (env NEWAPI_BASE_URL)
  --token TOKEN      access token (PAT/JWT)  (env NEWAPI_ACCESS_TOKEN)
  --user-id ID       value for the deprecated New-Api-User header (env NEWAPI_USER_ID)
  --security-proof P value for X-Security-Proof (env NEWAPI_SECURITY_PROOF)
  --timeout MS       per-request timeout, default 30000
  --config PATH      config file, default ~/.config/newapi-admin/config.json

output and safety
  --json             print the raw response \`data\` instead of a summary table
  --dry-run          print the request and send nothing
  --yes              confirm a destructive command
  --all              follow pagination and return every row

core commands
  config             show the resolved configuration (token is masked)
  ping               health summary: /api/status + /api/status/test
  api <METHOD> <PATH> reach ANY route, including ones with no typed command
                     [--query k=v ...] [--body '<json>' | --body @file | --body -]
  routes [term]      search the bundled route index (all 295 management routes)
  routes --stats     route counts per auth tier

domain groups
  channels  models  pricing  users  tokens  redemptions  logs  data  groups  vendors
  prefill   options system   tasks   audit  subscription

help
  newapi-admin help <topic>    one group's subcommands, e.g. \`newapi-admin help pricing\`
  newapi-admin <group>         with no arguments, prints that group's usage text

  topics: channels models pricing users tokens redemptions logs data groups vendors
          prefill options system tasks audit subscription api routes config ping

Response envelope: every route answers {success, message, data}; failures usually still
return HTTP 200 with success:false, so the CLI reports the message rather than the status.`;

  if (!topic || topic === "help") return root;
  if (sections[topic]) return `${sections[topic]}\n`;
  return `unknown help topic: ${topic}\n\n${sections.other}\n`;
}

// ---------------------------------------------------------------------------

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(2);
    }
    if (error instanceof ApiError) {
      process.stderr.write(`api error: ${error.message}${error.code ? ` (code=${error.code})` : ""}\n`);
      process.exit(1);
    }
    process.stderr.write(`unexpected error: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
