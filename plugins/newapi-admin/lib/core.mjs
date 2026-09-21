// Shared core for the newapi-admin CLI and its MCP adapter.
//
// Everything here is transport and arithmetic: resolving which instance to talk to,
// turning a method/path/query/body into a request, unwrapping New API's response
// envelope, and converting between USD and quota units. No command knowledge lives here,
// so the CLI and the MCP server stay thin and cannot drift apart.
//
// Node builtins only, no dependencies. Global fetch requires Node >= 18.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_QUOTA_PER_UNIT = 500000; // 1 USD = 500000 quota (common.QuotaPerUnit)
export const MAX_WALLET_QUOTA = Number.MAX_SAFE_INTEGER; // 1<<53-1

/** User role values, from common/constants.go. */
export const ROLE = { guest: 0, user: 1, admin: 10, root: 100 };
export const ROLE_NAMES = { 0: "guest", 1: "user", 10: "admin", 100: "root" };

/** User status values, from common/constants.go. */
export const USER_STATUS = { 1: "enabled", 2: "disabled" };

/** Channel status values, from common/constants.go. Note 0 is "unknown" and must never be written. */
export const CHANNEL_STATUS = {
  0: "unknown",
  1: "enabled",
  2: "manually-disabled",
  3: "auto-disabled",
};

/** Channel type code -> provider name. From constant/channel.go (ChannelTypeNames). */
export const CHANNEL_TYPES = {
  0: "Unknown",
  1: "OpenAI",
  2: "Midjourney",
  3: "Azure",
  4: "Ollama",
  5: "MidjourneyPlus",
  6: "OpenAIMax",
  7: "OhMyGPT",
  8: "Custom",
  9: "AILS",
  10: "AIProxy",
  11: "PaLM",
  12: "API2GPT",
  13: "AIGC2D",
  14: "Anthropic",
  15: "Baidu",
  16: "Zhipu",
  17: "Ali",
  18: "Xunfei",
  19: "360",
  20: "OpenRouter",
  21: "AIProxyLibrary",
  22: "FastGPT",
  23: "Tencent",
  24: "Gemini",
  25: "Moonshot",
  26: "ZhipuV4",
  27: "Perplexity",
  31: "LingYiWanWu",
  33: "AWS",
  34: "Cohere",
  35: "MiniMax",
  36: "SunoAPI",
  37: "Dify",
  38: "Jina",
  39: "Cloudflare",
  40: "SiliconFlow",
  41: "VertexAI",
  42: "Mistral",
  43: "DeepSeek",
  44: "MokaAI",
  45: "VolcEngine",
  46: "BaiduV2",
  47: "Xinference",
  48: "xAI",
  49: "Coze",
  50: "Kling",
  51: "Jimeng",
  52: "Vidu",
  53: "Submodel",
  54: "Doubao",
  55: "Sora",
  56: "Replicate",
  57: "Codex",
  58: "AdvancedCustom",
  59: "Sub2API",
  60: "NewAPI",
  61: "TaskPlugin",
  62: "VLLM",
  63: "SGLang",
};

export function channelTypeName(code) {
  return CHANNEL_TYPES[code] ?? `Unknown(${code})`;
}

export function channelTypeCode(name) {
  if (name === undefined || name === null || name === "") return undefined;
  if (/^\d+$/.test(String(name))) return Number(name);
  const wanted = String(name).toLowerCase();
  for (const [code, label] of Object.entries(CHANNEL_TYPES)) {
    if (label.toLowerCase() === wanted) return Number(code);
  }
  return undefined;
}

/** Log type values, from model/log.go. */
export const LOG_TYPES = {
  0: "all",
  1: "topup",
  2: "consume",
  3: "manage",
  4: "system",
  5: "error",
  6: "refund",
  7: "login",
};

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readConfigFile(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new UsageError(`config file ${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * Resolve connection settings. Precedence, highest first:
 *   1. explicit flags
 *   2. environment (NEWAPI_BASE_URL / NEWAPI_ACCESS_TOKEN / NEWAPI_SESSION_TOKEN / NEWAPI_USER_ID)
 *   3. environment-supplied config path (NEWAPI_ADMIN_CONFIG)
 *   4. ~/.config/newapi-admin/config.json
 *
 * The env var names match the official `newapi` skill so one shell profile configures both.
 *
 * A *session* credential (the dashboard JWT a browser holds) is accepted anywhere an access
 * token is, and additionally carries a session identity — which is what security-verified
 * operations such as reading a channel key require. It is deliberately flag/env-only: it
 * expires, so keeping it in a config file would only invite stale failures.
 */
export function resolveConfig({ flags = {}, env = process.env } = {}) {
  const configPath =
    flags.config || env.NEWAPI_ADMIN_CONFIG || join(homedir(), ".config", "newapi-admin", "config.json");
  const file = readConfigFile(configPath);

  const baseUrl = firstNonEmpty(flags.baseUrl, env.NEWAPI_BASE_URL, file.baseUrl, file.base_url);
  const accessToken = firstNonEmpty(flags.token, env.NEWAPI_ACCESS_TOKEN, file.token, file.accessToken);
  const sessionToken = firstNonEmpty(flags.sessionToken, env.NEWAPI_SESSION_TOKEN);
  const userId = firstNonEmpty(flags.userId, env.NEWAPI_USER_ID, file.userId, file.user_id);
  const securityProof = firstNonEmpty(flags.securityProof, env.NEWAPI_SECURITY_PROOF, file.securityProof);
  const timeoutRaw = firstNonEmpty(flags.timeout, env.NEWAPI_TIMEOUT_MS, file.timeoutMs);

  return {
    baseUrl: baseUrl ? normalizeBaseUrl(baseUrl) : undefined,
    token: sessionToken ?? accessToken,
    session: Boolean(sessionToken),
    userId: userId === undefined ? undefined : String(userId),
    securityProof,
    timeoutMs: toPositiveInt(timeoutRaw, 30000),
    configPath,
  };
}

export function assertConfigured(config) {
  const missing = [];
  if (!config.baseUrl) missing.push("base URL (NEWAPI_BASE_URL or --base-url)");
  if (!config.token) {
    missing.push("credential (NEWAPI_ACCESS_TOKEN or --token, or a session credential via --session-token)");
  }
  if (missing.length) {
    throw new UsageError(
      `missing ${missing.join(" and ")}. Set the environment variables, create ${config.configPath}, or pass the flags.`,
    );
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text !== "") return text;
  }
  return undefined;
}

export function normalizeBaseUrl(url) {
  return String(url).trim().replace(/\/+$/, "");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Config with the token reduced to a fingerprint, safe to print. */
export function redactConfig(config) {
  return {
    baseUrl: config.baseUrl ?? null,
    token: config.token ? maskSecret(config.token) : null,
    credential: config.session ? "session" : config.token ? "access-token" : null,
    userId: config.userId ?? null,
    securityProof: config.securityProof ? "<set>" : null,
    timeoutMs: config.timeoutMs,
    configPath: config.configPath,
  };
}

export function maskSecret(value) {
  const text = String(value);
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}${"*".repeat(10)}${text.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Headers every request carries. The token never appears in output, only here. */
export function buildHeaders(config, extra = {}) {
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
    ...extra,
  };
  // Deprecated upstream but harmless and still expected by some older builds/proxies.
  if (config.userId) headers["New-Api-User"] = String(config.userId);
  if (config.securityProof) headers["X-Security-Proof"] = String(config.securityProof);
  return headers;
}

export function buildUrl(baseUrl, path, query) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${cleanPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
      continue;
    }
    url.searchParams.append(key, String(value));
  }
  return url;
}

/**
 * Perform one request against the management API and unwrap the envelope.
 *
 * New API answers almost every failure with HTTP 200 and `{"success": false, "message": ...}`,
 * so the envelope — not the status code — decides success. A non-2xx status is only treated as
 * a transport-level failure when the body is not a usable envelope.
 */
export async function request(config, { method = "GET", path, query, body, headers, timeoutMs, raw = false } = {}) {
  assertConfigured(config);
  const url = buildUrl(config.baseUrl, path, query);
  const init = {
    method: method.toUpperCase(),
    headers: buildHeaders(config, {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    }),
    signal: AbortSignal.timeout(timeoutMs ?? config.timeoutMs),
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(`request timed out after ${init.signal ? timeoutMs ?? config.timeoutMs : "?"}ms: ${method} ${path}`);
    }
    throw new ApiError(`cannot reach ${config.baseUrl}: ${error.message}`, { status: 0 });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    // Not JSON: a proxy, an HTML error page, or a wrong base URL.
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new ApiError(
      `expected JSON from ${method.toUpperCase()} ${path} but got HTTP ${response.status}: ${snippet || "<empty body>"}`,
      { status: response.status },
    );
  }

  if (raw) return { status: response.status, body: parsed, path, method: method.toUpperCase() };

  // `code` is used instead of `success` by /api/usage/token/.
  const succeeded = parsed.success === true || parsed.code === true;
  if (!succeeded) {
    const message = parsed.message || parsed.error?.message || `request failed with HTTP ${response.status}`;
    if (!response.ok && parsed.success === undefined && parsed.code === undefined) {
      throw new ApiError(`${method.toUpperCase()} ${path} -> HTTP ${response.status}: ${message}`, {
        status: response.status,
        body: parsed,
      });
    }
    throw new ApiError(String(message), { status: response.status, code: parsed.code, body: parsed });
  }

  return { status: response.status, data: parsed.data, message: parsed.message, envelope: parsed, path, method: method.toUpperCase() };
}

// ---------------------------------------------------------------------------
// Quota arithmetic
// ---------------------------------------------------------------------------

export function usdToQuota(usd, quotaPerUnit = DEFAULT_QUOTA_PER_UNIT) {
  return Math.round(Number(usd) * Number(quotaPerUnit));
}

export function quotaToUsd(quota, quotaPerUnit = DEFAULT_QUOTA_PER_UNIT) {
  return Number(quota) / Number(quotaPerUnit);
}

/**
 * ModelRatio unit conversion.
 *
 * One ratio unit is $0.002 per 1K tokens, i.e. $2 per 1M tokens, so
 * ratio = USD_per_1M / 2. This is the single most confusing number in the
 * system; the CLI always prints both forms so an operator never has to remember it.
 */
export const USD_PER_MILLION_PER_RATIO = 2;

export function ratioToUsdPerMillion(ratio) {
  return Number(ratio) * USD_PER_MILLION_PER_RATIO;
}

export function usdPerMillionToRatio(usd) {
  return Number(usd) / USD_PER_MILLION_PER_RATIO;
}

/**
 * Reproduce the request cost formula for ratio-billed text models
 * (service/text_quota.go). Returns quota units.
 *
 * Parameters keep the API's own field names (ModelRatio, CompletionRatio, ...) so a value
 * straight from `GET /api/option/model_pricing` can be passed in without translation.
 *
 * This is an estimate: it does not model tiered `billing_expr` models, tool-call
 * surcharges, or provider-specific audio pricing, and it is the CLI's own arithmetic
 * rather than the server's. Use it to sanity-check a price change before applying it.
 */
export function estimateTextQuota(
  { ModelRatio, CompletionRatio = 1, CacheRatio = 1, CreateCacheRatio = 1, ImageRatio = 1, ModelPrice, groupRatio = 1 },
  { promptTokens = 0, completionTokens = 0, cacheTokens = 0, createCacheTokens = 0, imageTokens = 0 } = {},
  quotaPerUnit = DEFAULT_QUOTA_PER_UNIT,
) {
  if (ModelPrice !== undefined && ModelPrice !== null && Number(ModelPrice) > 0) {
    // Fixed price wins outright; ratios are ignored for that model.
    return Number(ModelPrice) * Number(quotaPerUnit) * Number(groupRatio);
  }
  const base = Math.max(Number(promptTokens) - Number(cacheTokens) - Number(createCacheTokens) - Number(imageTokens), 0);
  const promptQuota = base + Number(cacheTokens) * Number(CacheRatio) + Number(imageTokens) * Number(ImageRatio) + Number(createCacheTokens) * Number(CreateCacheRatio);
  const completionQuota = Number(completionTokens) * Number(CompletionRatio);
  const quota = (promptQuota + completionQuota) * Number(ModelRatio) * Number(groupRatio);
  return quota <= 0 ? 0 : quota;
}

// ---------------------------------------------------------------------------
// Argument parsing and output
// ---------------------------------------------------------------------------

/**
 * Parse argv into `{ positionals, flags }`.
 *
 * Supports `--flag value`, `--flag=value`, `--bool`, `--no-bool`, repeated flags
 * (collected into arrays) and `--` to end flag parsing. Command-specific aliases are
 * resolved by the caller so this stays generic.
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const repeated = new Set();
  let i = 0;
  let flagsDone = false;
  while (i < argv.length) {
    const token = argv[i];
    if (flagsDone) {
      positionals.push(token);
      i += 1;
      continue;
    }
    if (token === "--") {
      flagsDone = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      let name;
      let value;
      if (eq !== -1) {
        name = token.slice(2, eq);
        value = token.slice(eq + 1);
      } else {
        name = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      if (name.startsWith("no-")) {
        flags[name.slice(3)] = false;
      } else if (repeated.has(name)) {
        if (!Array.isArray(flags[name])) flags[name] = [flags[name]];
        flags[name].push(value);
      } else if (flags[name] !== undefined) {
        repeated.add(name);
        flags[name] = [flags[name], value];
      } else {
        flags[name] = value;
      }
      i += 1;
      continue;
    }
    positionals.push(token);
    i += 1;
  }
  return { positionals, flags };
}

export function flagList(value) {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value : String(value).split(",");
  return items.map((item) => String(item).trim()).filter((item) => item !== "");
}

export function flagInt(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number, got "${value}"`);
  return parsed;
}

export function flagBool(value) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no", ""].includes(String(value).toLowerCase());
}

export function pickDefined(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) out[key] = value;
  return out;
}

/** Parse `key=value` pairs given as repeated flags, e.g. `--query a=1 --query b=2`. */
export function parsePairs(values, name) {
  const out = {};
  for (const item of values ?? []) {
    const text = String(item);
    const eq = text.indexOf("=");
    if (eq === -1) throw new UsageError(`--${name} expects key=value, got "${text}"`);
    out[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return out;
}

export function readJsonArg(value, { flagName = "body" } = {}) {
  if (value === undefined) return undefined;
  const text = String(value);
  const source = text === "-" ? readFileSync(0, "utf8") : text.startsWith("@") ? readFileSync(text.slice(1), "utf8") : text;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new UsageError(`--${flagName} is not valid JSON: ${error.message}`);
  }
}

/** Read JSON from a file path (as opposed to readJsonArg, which takes inline JSON or @path). */
export function readJsonFile(path, { flagName = "file" } = {}) {
  if (path === undefined || path === null || path === "") {
    throw new UsageError(`--${flagName} needs a path to a JSON file`);
  }
  let source;
  try {
    source = readFileSync(String(path), "utf8");
  } catch (error) {
    throw new UsageError(`--${flagName} ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new UsageError(`--${flagName} ${path} is not valid JSON: ${error.message}`);
  }
}

export function printJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Fixed-width table for humans. Values are stringified; `columns` are `{key,label,width?}`. */
export function formatTable(rows, columns) {
  if (!rows.length) return "(no rows)";
  const cells = rows.map((row) => columns.map((col) => stringifyCell(typeof col.get === "function" ? col.get(row) : row[col.key])));
  const widths = columns.map((col, index) =>
    Math.min(Math.max(col.label.length, ...cells.map((line) => line[index].length)), col.width ?? 48),
  );
  const line = (values) =>
    values
      .map((value, index) => truncate(value, widths[index]).padEnd(widths[index]))
      .join("  ")
      .replace(/\s+$/, "");
  const out = [line(columns.map((col) => col.label)), line(widths.map((width) => "-".repeat(width)))];
  for (const row of cells) out.push(line(row));
  return out.join("\n");
}

function stringifyCell(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncate(value, width) {
  return value.length > width ? `${value.slice(0, Math.max(width - 1, 0))}…` : value;
}

export function unixToIso(seconds) {
  const value = Number(seconds);
  if (!value) return "";
  return new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export function isoToUnix(text) {
  const value = Number(text);
  if (Number.isFinite(value) && String(text).trim() !== "") return Math.floor(value);
  const parsed = Date.parse(String(text));
  if (Number.isNaN(parsed)) throw new UsageError(`cannot parse time "${text}" as unix seconds or a date`);
  return Math.floor(parsed / 1000);
}
