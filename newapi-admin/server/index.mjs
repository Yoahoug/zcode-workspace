#!/usr/bin/env node
// MCP stdio server exposing the New API management API to a model.
//
// Shape of the surface, and why:
//   * `newapi_request` is the escape hatch that reaches every mounted route, so the tool
//     list never has to grow to keep coverage complete. Destructive requests must set
//     confirm:true.
//   * `newapi_routes` and `newapi_reference` make the sedimented documentation readable
//     inside the conversation, so the model can look up an exact field name or permission
//     tier instead of guessing or reading files.
//   * A handful of typed tools cover the everyday workflows (channels, model metadata,
//     pricing, users, logs) with the units already converted, because those are where a
//     model most often gets the arithmetic wrong (ratio vs USD-per-1M, quota vs USD).
//
// Protocol: JSON-RPC 2.0, one JSON message per line on stdin/stdout. stdout carries
// protocol traffic only; diagnostics go to stderr. Node >= 18, no dependencies.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiError,
  CHANNEL_STATUS,
  channelTypeCode,
  channelTypeName,
  estimateTextQuota,
  quotaToUsd,
  ratioToUsdPerMillion,
  request,
  resolveConfig,
  ROLE_NAMES,
  usdPerMillionToRatio,
  usdToQuota,
} from "../lib/core.mjs";
import { findRoutes, matchRoute, routeStats, ROUTES } from "../lib/routes.mjs";

const SERVER_NAME = "newapi-admin";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const referencesDir = join(pluginRoot, "skills", "newapi-admin", "references");

const REFERENCE_TOPICS = {
  conventions: "auth, response envelope, pagination, quota units, permission tiers, safety rules",
  channels: "channel CRUD, field-by-field payload reference, type and status code tables, tags, multi-key",
  "models-and-pricing": "model metadata, upstream metadata sync, ratios, fixed prices, the cost formula, option maps",
  users: "user CRUD, roles, statuses, quota adjustments, top-ups, bindings",
  "tokens-and-redemptions": "API tokens (self-scoped) and redemption codes",
  "logs-and-stats": "request logs, log statistics, aggregated usage data",
  "system-and-options": "system options, request policy, system tasks, instances, performance, vendors, groups",
  endpoints: "every mounted management route with its permission tier",
};

const config = resolveConfig({
  flags: {},
  env: {
    NEWAPI_BASE_URL: process.env.NEWAPI_BASE_URL,
    NEWAPI_ACCESS_TOKEN: process.env.NEWAPI_ACCESS_TOKEN,
    NEWAPI_USER_ID: process.env.NEWAPI_USER_ID,
    NEWAPI_SECURITY_PROOF: process.env.NEWAPI_SECURITY_PROOF,
    NEWAPI_TIMEOUT_MS: process.env.NEWAPI_TIMEOUT_MS,
  },
});

// An unexpanded ${...} placeholder means the host could not resolve the user's config.
function resolved(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.includes("${") ? "" : trimmed;
}

const missingConfig = !resolved(config.baseUrl) || !resolved(config.token);
if (!missingConfig) {
  config.baseUrl = resolved(config.baseUrl).replace(/\/+$/, "");
  config.token = resolved(config.token);
  const userId = resolved(config.userId ?? "");
  config.userId = userId || undefined;
  const proof = resolved(config.securityProof ?? "");
  config.securityProof = proof || undefined;
}

const CONFIG_HINT =
  "This plugin is not configured. Set the plugin's base URL and access token (plugin settings), " +
  "or export NEWAPI_BASE_URL and NEWAPI_ACCESS_TOKEN. The token is an admin or root access token " +
  "created in the New API panel under Personal settings -> Security -> system access token.";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const json = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });

const TOOLS = [
  {
    name: "newapi_request",
    description:
      "Call any New API management route directly. Use this for anything the typed tools do not cover — it reaches every mounted route. " +
      "Paths are API-relative, e.g. '/api/channel/' or '/api/redemption/12'. Query values must be strings. " +
      "Destructive requests (DELETE, PATCH, or a delete/reset/cleanup path) are refused unless confirm is true.",
    inputSchema: json(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method" },
        path: str("API path, e.g. /api/token/"),
        query: { type: "object", description: "Query parameters as strings", additionalProperties: { type: "string" } },
        body: { description: "JSON request body (object or array)" },
        confirm: bool("Must be true to run a destructive request"),
      },
      ["method", "path"],
    ),
  },
  {
    name: "newapi_routes",
    description:
      "Search the bundled index of every New API management route (method, path, permission tier, purpose). " +
      "Use it to discover which endpoint to call. Omit term to list everything, or pass a keyword, path fragment, or group id.",
    inputSchema: json({ term: str("Keyword, path fragment, or group id (e.g. 'channel', 'ratio', 'pricing')") }),
  },
  {
    name: "newapi_reference",
    description:
      "Read a New API admin reference document from this plugin. Call it before making non-trivial changes: " +
      "the docs carry exact field names, units and permission tiers that are easy to get wrong.",
    inputSchema: json({ topic: { type: "string", enum: Object.keys(REFERENCE_TOPICS), description: "Which reference to read" } }, ["topic"]),
  },
  {
    name: "newapi_status",
    description: "Health and instance summary: version, setup state, and the QuotaPerUnit used for USD/quota conversions.",
    inputSchema: json({}),
  },
  {
    name: "newapi_channels_list",
    description:
      "List upstream channels. Returns id, name, provider, status, priority, weight, group, model count, balance and tag. Channel secrets are never returned by the API.",
    inputSchema: json({
      group: str("Filter by group name"),
      status: { type: "string", enum: ["enabled", "disabled"], description: "Filter by enabled state" },
      type: { type: "string", description: "Channel type code or provider name, e.g. 1 or OpenAI" },
      keyword: str("Search by id, name, key or base URL"),
      limit: int("Maximum rows to return (default 50)"),
    }),
  },
  {
    name: "newapi_channel_test",
    description: "Test one channel's connectivity. Returns the round-trip time in seconds and the upstream error when it fails.",
    inputSchema: json({ id: int("Channel id"), model: str("Override the test model") }, ["id"]),
  },
  {
    name: "newapi_models_list",
    description:
      "List model metadata records (the catalogue: description, vendor, endpoints, visibility). This is separate from pricing, which newapi_pricing_get reads.",
    inputSchema: json({
      keyword: str("Match model_name, description or tags"),
      vendor: str("Vendor name or numeric vendor id"),
      status: { type: "string", enum: ["enabled", "disabled"], description: "enabled = status 1 (catalogue-visible)" },
      limit: int("Maximum rows to return (default 50)"),
    }),
  },
  {
    name: "newapi_models_sync_preview",
    description:
      "Preview the upstream official metadata sync. Returns candidates with a kind (create/update/unchanged/missing_upstream/missing_vendor/blocked) " +
      "and a source_version token. This writes nothing.",
    inputSchema: json({ locale: { type: "string", enum: ["zh", "en", "ja"], description: "Metadata language (default zh)" } }),
  },
  {
    name: "newapi_models_sync_apply",
    description:
      "Apply the metadata sync. Requires the source_version from newapi_models_sync_preview plus the per-record record_version, so the apply fails " +
      "loudly (HTTP 409) if the upstream catalogue changed since the preview. Sync creates and updates metadata only; it never deletes and never sets prices.",
    inputSchema: json(
      {
        locale: { type: "string", enum: ["zh", "en", "ja"] },
        source_version: str("source.version from the preview"),
        selections: {
          type: "array",
          description: "One entry per model to apply",
          items: json(
            {
              model_name: str("Model name"),
              record_version: str("record_version from the preview candidate"),
              create: bool("True to create the record; false to update selected fields"),
              fields: { type: "array", items: { type: "string" }, description: "For updates: which fields to write (description, icon, tags, vendor, endpoints, name_rule, status)" },
            },
            ["model_name", "record_version"],
          ),
        },
      },
      ["source_version", "selections"],
    ),
  },
  {
    name: "newapi_pricing_get",
    description:
      "Read model pricing. Per model it returns the configured values, the effective values (with engine defaults resolved) and a version token. " +
      "Units: ModelRatio is USD-per-1M-tokens divided by 2; ModelPrice is a fixed USD amount per request and bypasses all ratios.",
    inputSchema: json({ model: str("Model name; omit to read every configured model") }),
  },
  {
    name: "newapi_pricing_set",
    description:
      "Set model pricing. Reads the current version first and sends it as the optimistic lock, so a concurrent change fails instead of being overwritten. " +
      "Pass usd_per_1m to express the ratio as a price. Setting ModelPrice makes the model bill a fixed USD amount per request regardless of tokens.",
    inputSchema: json(
      {
        model: str("Model name"),
        ModelRatio: num("Per-token multiplier; equals USD per 1M tokens / 2"),
        usd_per_1m: num("Convenience: USD per 1M tokens, converted to ModelRatio (overrides ModelRatio)"),
        ModelPrice: num("Fixed USD price per request; bypasses ratios"),
        CompletionRatio: num("Output-token multiplier"),
        CacheRatio: num("Cached-input-token multiplier"),
        CreateCacheRatio: num("Cache-write-token multiplier"),
        ImageRatio: num("Image-input-token multiplier"),
        reset: bool("Replace this model's pricing with the built-in defaults"),
      },
      ["model"],
    ),
  },
  {
    name: "newapi_pricing_cost",
    description:
      "Estimate the quota and USD cost of one request under a model's current pricing. This is this plugin's own arithmetic, not the server's, " +
      "so treat it as a sanity check before changing a price rather than as a bill.",
    inputSchema: json(
      {
        model: str("Model name"),
        prompt_tokens: int("Prompt tokens"),
        completion_tokens: int("Completion tokens"),
        cache_tokens: int("Cached prompt tokens"),
        create_cache_tokens: int("Cache-write prompt tokens"),
        group: str("Group name, to apply its GroupRatio"),
      },
      ["model"],
    ),
  },
  {
    name: "newapi_users_list",
    description: "List or search users. Returns id, username, role, status, group, quota and used quota. Use newapi_reference('users') for role and quota semantics.",
    inputSchema: json({
      keyword: str("Match username, email, display name or exact id"),
      group: str("Exact group filter"),
      role: int("0 guest, 1 user, 10 admin, 100 root"),
      status: int("1 enabled, 2 disabled, -1 deleted"),
      limit: int("Maximum rows to return (default 50)"),
    }),
  },
  {
    name: "newapi_user_quota",
    description:
      "Adjust a user's balance. Prefer usd over value: the quota unit is QuotaPerUnit per USD (default 1 USD = 500000 quota), which is easy to get wrong by hand. " +
      "mode 'override' sets the absolute balance; 'add' and 'subtract' require a positive amount.",
    inputSchema: json(
      {
        id: int("User id"),
        mode: { type: "string", enum: ["add", "subtract", "override"], description: "How to apply the amount" },
        usd: num("Amount in USD, converted to quota"),
        value: int("Amount in raw quota units (used only when usd is absent)"),
      },
      ["id", "mode"],
    ),
  },
  {
    name: "newapi_logs",
    description:
      "Query request logs. Note the server's own quirk: `type` filters log rows, and log statistics count rpm/tpm over the last 60 seconds only.",
    inputSchema: json({
      type: { type: "string", description: "all, topup, consume, manage, system, error, refund, login, or 0-7" },
      start_timestamp: int("Unix seconds, inclusive lower bound"),
      end_timestamp: int("Unix seconds, inclusive upper bound"),
      username: str("Exact username, or a value containing % for a LIKE match"),
      model_name: str("Exact model name, or a value containing % for a LIKE match"),
      channel: int("Channel id"),
      limit: int("Maximum rows to return (default 50)"),
    }),
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function requireConfig() {
  if (missingConfig) throw new ApiError(CONFIG_HINT);
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

async function callTool(name, args = {}) {
  if (name === "newapi_routes") {
    const matches = findRoutes(args.term);
    if (!matches.length) return text(`No route matches "${args.term}".`);
    const lines = matches.map((route) => {
      const guard = route.auth === "admin" && route.perm ? `admin+${route.perm}` : route.auth;
      return `${route.method.padEnd(6)} ${route.path.padEnd(52)} ${guard.padEnd(30)} ${route.purpose}${route.destructive ? "  [destructive]" : ""}`;
    });
    const stats = routeStats();
    return text(`${matches.length} of ${stats.total} routes.\n\n${lines.join("\n")}`);
  }

  if (name === "newapi_reference") {
    const topic = args.topic;
    if (!REFERENCE_TOPICS[topic]) {
      return text(`Unknown topic "${topic}". Available: ${Object.keys(REFERENCE_TOPICS).join(", ")}`);
    }
    try {
      return text(readFileSync(join(referencesDir, `${topic}.md`), "utf8"));
    } catch (error) {
      return text(`Could not read reference "${topic}": ${error.message}`);
    }
  }

  requireConfig();

  if (name === "newapi_request") {
    const method = String(args.method ?? "GET").toUpperCase();
    const query = {};
    for (const [key, value] of Object.entries(args.query ?? {})) query[key] = String(value);
    const destructive = ["DELETE", "PATCH"].includes(method) || /delete|reset|clear|cleanup|revoke|invalid|batch$/i.test(String(args.path));
    if (destructive && args.confirm !== true) {
      const known = matchRoute(method, args.path);
      throw new ApiError(
        `Refusing ${method} ${args.path} without confirm:true${known ? ` (${known.purpose})` : ""}. ` +
          "Re-issue the call with confirm:true if this change is intended.",
      );
    }
    const result = await request(config, { method, path: args.path, query, body: args.body });
    const known = matchRoute(method, args.path);
    const note = known ? "" : `\n(note: ${method} ${args.path} is not in the bundled route index; the server answered anyway.)`;
    return text(`${JSON.stringify(result.data ?? null, null, 2)}${note}`);
  }

  if (name === "newapi_status") {
    const status = await request(config, { method: "GET", path: "/api/status" });
    const data = status.data ?? {};
    return text({
      base_url: config.baseUrl,
      version: data.version,
      setup: data.setup,
      quota_per_unit: data.quota_per_unit,
      usd_exchange_rate: data.usd_exchange_rate,
      conversion: `1 USD = ${data.quota_per_unit} quota`,
    });
  }

  if (name === "newapi_channels_list") {
    const limit = Math.min(Number(args.limit ?? 50) || 50, 100);
    const query = {};
    if (args.group) query.group = args.group;
    if (args.status) query.status = args.status;
    if (args.type !== undefined) {
      const code = channelTypeCode(args.type);
      if (code === undefined) throw new ApiError(`Unknown channel type "${args.type}". Use a numeric code or a provider name such as OpenAI.`);
      query.type = String(code);
    }
    const result = args.keyword
      ? await request(config, { method: "GET", path: "/api/channel/search", query: { ...query, keyword: args.keyword, page_size: String(limit) } })
      : await request(config, { method: "GET", path: "/api/channel/", query: { ...query, page_size: String(limit) } });
    const items = result.data?.items ?? [];
    return text({
      total: result.data?.total ?? items.length,
      returned: items.length,
      type_counts: result.data?.type_counts,
      channels: items.map((channel) => ({
        id: channel.id,
        name: channel.name,
        provider: channelTypeName(channel.type),
        type: channel.type,
        status: CHANNEL_STATUS[channel.status] ?? channel.status,
        priority: channel.priority,
        weight: channel.weight,
        group: channel.group,
        models: channel.models ? String(channel.models).split(",").length : 0,
        balance_usd: channel.balance,
        response_time_ms: channel.response_time,
        tag: channel.tag,
      })),
    });
  }

  if (name === "newapi_channel_test") {
    const query = args.model ? { model: String(args.model) } : {};
    // This route answers with success/time at the top level rather than inside `data`.
    const raw = await request(config, { method: "GET", path: `/api/channel/test/${Number(args.id)}`, query, raw: true });
    const envelope = raw.body;
    return text({
      channel_id: Number(args.id),
      ok: envelope.success === true,
      time_seconds: envelope.time,
      message: envelope.message || undefined,
      error_code: envelope.error_code,
    });
  }

  if (name === "newapi_models_list") {
    const limit = Math.min(Number(args.limit ?? 50) || 50, 100);
    const query = { page_size: String(limit) };
    if (args.keyword) query.keyword = args.keyword;
    if (args.vendor) query.vendor = args.vendor;
    if (args.status) query.status = args.status;
    const result = await request(config, { method: "GET", path: "/api/models/search", query });
    const items = result.data?.items ?? [];
    return text({
      total: result.data?.total ?? items.length,
      returned: items.length,
      vendor_counts: result.data?.vendor_counts,
      models: items.map((model) => ({
        id: model.id,
        model_name: model.model_name,
        name_rule: ["exact", "prefix", "contains", "suffix"][model.name_rule ?? 0],
        vendor_id: model.vendor_id,
        status: model.status === 1 ? "visible" : "hidden",
        sync_official: model.sync_official === 1,
        configured_channels: model.configured_channel_count,
        square_state: model.square_state,
        tags: model.tags || undefined,
      })),
    });
  }

  if (name === "newapi_models_sync_preview") {
    const query = args.locale ? { locale: String(args.locale) } : {};
    const result = await request(config, { method: "GET", path: "/api/models/sync_upstream/preview", query });
    const candidates = result.data?.candidates ?? [];
    const counts = {};
    for (const candidate of candidates) counts[candidate.kind] = (counts[candidate.kind] ?? 0) + 1;
    return text({
      source: result.data?.source,
      candidate_counts: counts,
      // `record_version` is per-record and must be echoed back on apply.
      candidates: candidates.map((candidate) => ({
        model_name: candidate.model_name,
        kind: candidate.kind,
        scope: candidate.scope,
        record_version: candidate.record_version,
        changed_fields: (candidate.fields ?? []).map((field) => field.field),
        vendor_to_create: candidate.vendor_to_create,
      })),
      next_step:
        "To apply, call newapi_models_sync_apply with source_version = source.version and one selection per model " +
        "(echoing each candidate's record_version, create:true for kind=create, or fields:[...] for kind=update).",
    });
  }

  if (name === "newapi_models_sync_apply") {
    const body = {
      locale: args.locale ?? "zh",
      source_version: args.source_version,
      selections: args.selections,
    };
    const result = await request(config, { method: "POST", path: "/api/models/sync_upstream", body });
    return text({
      created_models: result.data?.created_models ?? [],
      updated_models: (result.data?.updated_models ?? []).map((item) => item.model_name),
      created_vendors: result.data?.created_vendors ?? [],
      note: "Metadata only. Newly discovered models have no price until one is set; check with newapi_pricing_get.",
    });
  }

  if (name === "newapi_pricing_get") {
    const query = args.model ? { model: String(args.model) } : {};
    const result = await request(config, { method: "GET", path: "/api/option/model_pricing", query });
    const entries = result.data?.entries ?? [];
    return text({
      unit_notes: {
        ModelRatio: "1 ratio = $0.002 per 1K tokens = $2 per 1M tokens",
        ratio_to_usd: "usd_per_1m = ModelRatio * 2",
        ModelPrice: "fixed USD per request; when set, ratios are ignored",
      },
      empty_version: result.data?.empty_version,
      models: entries.map((entry) => ({
        model_name: entry.model_name,
        version: entry.version,
        configured: entry.configured,
        effective: entry.effective,
        ratio_as_usd_per_1m: entry.effective?.ModelRatio !== undefined ? ratioToUsdPerMillion(entry.effective.ModelRatio) : undefined,
        billing_mode: entry.billing_details?.mode ?? "ratio",
      })),
    });
  }

  if (name === "newapi_pricing_set") {
    const model = String(args.model);
    const pricing = {};
    if (args.usd_per_1m !== undefined) pricing.ModelRatio = usdPerMillionToRatio(Number(args.usd_per_1m));
    else if (args.ModelRatio !== undefined) pricing.ModelRatio = Number(args.ModelRatio);
    if (args.ModelPrice !== undefined) pricing.ModelPrice = Number(args.ModelPrice);
    for (const key of ["CompletionRatio", "CacheRatio", "CreateCacheRatio", "ImageRatio"]) {
      if (args[key] !== undefined) pricing[key] = Number(args[key]);
    }
    if (Object.keys(pricing).length === 0 && args.reset !== true) {
      throw new ApiError("Nothing to change: pass at least one pricing field, or reset:true.");
    }
    const before = await request(config, { method: "GET", path: "/api/option/model_pricing", query: { model } });
    const entry = (before.data?.entries ?? []).find((item) => item.model_name === model);
    const expected_version = entry?.version ?? before.data?.empty_version ?? "";
    const result = await request(config, {
      method: "PATCH",
      path: "/api/option/model_pricing",
      body: { changes: [{ model_name: model, expected_version, pricing, ...(args.reset ? { reset: true } : {}) }] },
    });
    return text({
      updated_models: result.data?.updated_models ?? [],
      applied: pricing,
      expressed_as: pricing.ModelPrice !== undefined ? `$${pricing.ModelPrice} per request` : pricing.ModelRatio !== undefined ? `$${ratioToUsdPerMillion(pricing.ModelRatio)} per 1M tokens` : undefined,
    });
  }

  if (name === "newapi_pricing_cost") {
    const model = String(args.model);
    const snapshot = await request(config, { method: "GET", path: "/api/option/model_pricing", query: { model } });
    const entry = (snapshot.data?.entries ?? []).find((item) => item.model_name === model);
    if (!entry) throw new ApiError(`No pricing entry for "${model}". Check newapi_pricing_get for the configured model names.`);
    const status = await request(config, { method: "GET", path: "/api/status" });
    const quotaPerUnit = Number(status.data?.quota_per_unit) || 500000;
    let groupRatio = 1;
    if (args.group) {
      const options = await request(config, { method: "GET", path: "/api/option/" });
      const row = (options.data ?? []).find((option) => option.key === "GroupRatio");
      if (row) {
        try {
          const parsed = JSON.parse(String(row.value));
          if (Number.isFinite(Number(parsed[args.group]))) groupRatio = Number(parsed[args.group]);
        } catch {
          /* leave the default in place */
        }
      }
    }
    const quota = estimateTextQuota(
      { ...entry.effective, groupRatio },
      {
        promptTokens: Number(args.prompt_tokens ?? 0),
        completionTokens: Number(args.completion_tokens ?? 0),
        cacheTokens: Number(args.cache_tokens ?? 0),
        createCacheTokens: Number(args.create_cache_tokens ?? 0),
      },
      quotaPerUnit,
    );
    return text({
      model,
      group_ratio: groupRatio,
      quota: Math.round(quota),
      usd: Number(quotaToUsd(quota, quotaPerUnit).toFixed(6)),
      quota_per_unit: quotaPerUnit,
      effective_pricing: entry.effective,
      caveat: "This is the plugin's own reproduction of the ratio formula. It does not cover tiered billing expressions, tool-call surcharges, or provider-specific audio pricing.",
    });
  }

  if (name === "newapi_users_list") {
    const limit = Math.min(Number(args.limit ?? 50) || 50, 100);
    const query = { page_size: String(limit) };
    for (const key of ["keyword", "group", "role", "status"]) if (args[key] !== undefined) query[key] = String(args[key]);
    const status = await request(config, { method: "GET", path: "/api/status" });
    const quotaPerUnit = Number(status.data?.quota_per_unit) || 500000;
    const result = await request(config, { method: "GET", path: "/api/user/search", query });
    const items = result.data?.items ?? [];
    return text({
      total: result.data?.total ?? items.length,
      returned: items.length,
      quota_per_unit: quotaPerUnit,
      users: items.map((user) => ({
        id: user.id,
        username: user.username,
        role: `${ROLE_NAMES[user.role] ?? user.role} (${user.role})`,
        status: user.status === 1 ? "enabled" : "disabled",
        group: user.group,
        quota: user.quota,
        balance_usd: Number(quotaToUsd(user.quota ?? 0, quotaPerUnit).toFixed(6)),
        used_quota: user.used_quota,
        email: user.email || undefined,
      })),
    });
  }

  if (name === "newapi_user_quota") {
    const mode = String(args.mode);
    if (!["add", "subtract", "override"].includes(mode)) throw new ApiError("mode must be add, subtract or override");
    const status = await request(config, { method: "GET", path: "/api/status" });
    const quotaPerUnit = Number(status.data?.quota_per_unit) || 500000;
    const value = args.usd !== undefined ? usdToQuota(Number(args.usd), quotaPerUnit) : Number(args.value);
    if (!Number.isFinite(value)) throw new ApiError("Provide usd or value.");
    if (mode !== "override" && value <= 0) throw new ApiError("add and subtract require a positive amount.");
    await request(config, { method: "POST", path: "/api/user/manage", body: { id: Number(args.id), action: "add_quota", mode, value } });
    return text({
      user_id: Number(args.id),
      mode,
      quota: value,
      usd: Number(quotaToUsd(value, quotaPerUnit).toFixed(6)),
      quota_per_unit: quotaPerUnit,
    });
  }

  if (name === "newapi_logs") {
    const limit = Math.min(Number(args.limit ?? 50) || 50, 100);
    const query = { page_size: String(limit) };
    if (args.type !== undefined) {
      const types = { all: 0, topup: 1, consume: 2, manage: 3, system: 4, error: 5, refund: 6, login: 7 };
      const text_ = String(args.type).toLowerCase();
      const code = /^\d+$/.test(text_) ? Number(text_) : types[text_];
      if (code === undefined) throw new ApiError(`Unknown log type "${args.type}".`);
      query.type = String(code);
    }
    for (const key of ["start_timestamp", "end_timestamp", "username", "model_name", "channel"]) {
      if (args[key] !== undefined) query[key] = String(args[key]);
    }
    const result = await request(config, { method: "GET", path: "/api/log/", query });
    const items = result.data?.items ?? [];
    return text({
      total: result.data?.total ?? items.length,
      returned: items.length,
      logs: items.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        type: row.type,
        username: row.username,
        model_name: row.model_name,
        channel_name: row.channel_name,
        quota: row.quota,
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        use_time_seconds: row.use_time,
        content: row.content,
      })),
    });
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
        const message = error instanceof ApiError ? error.message : `Unexpected error: ${error?.message ?? error}`;
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
process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready: ${TOOLS.length} tools, ${ROUTES.length} routes indexed${missingConfig ? " (unconfigured)" : ""}\n`);
