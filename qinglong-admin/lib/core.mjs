// Shared core for the qinglong-admin CLI and its MCP adapter.
//
// Everything here is transport and ceremony: resolving which panel to talk to, obtaining and
// refreshing an application token, turning a method/path/query/body into a request, and
// unwrapping Qinglong's `{code, data}` envelope. No command knowledge lives here, so the CLI
// and the MCP server stay thin and cannot drift apart.
//
// Node builtins only, no dependencies. Global fetch requires Node >= 18.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Application scopes, from the panel's 系统设置 -> 应用设置.
 * Granting a scope is not required for a route to exist; a missing scope answers business
 * code 403 at call time. Kept here so status/probing code and docs speak the same names.
 */
export const SCOPES = [
  "crons",
  "subscriptions",
  "envs",
  "scripts",
  "configs",
  "logs",
  "dependencies",
  "system",
  "dashboard",
  "apps",
  "user",
];

/** A representative *read* route per scope, used by `status --scope` and the MCP status tool. */
export const SCOPE_PROBE_ROUTES = {
  crons: { method: "GET", path: "/open/crons", query: { page: "1", size: "1" } },
  subscriptions: { method: "GET", path: "/open/subscriptions" },
  envs: { method: "GET", path: "/open/envs" },
  scripts: { method: "GET", path: "/open/scripts" },
  configs: { method: "GET", path: "/open/configs/files" },
  logs: { method: "GET", path: "/open/logs" },
  dependencies: { method: "GET", path: "/open/dependencies" },
  system: { method: "GET", path: "/open/system" },
  dashboard: { method: "GET", path: "/open/dashboard/overview" },
  apps: { method: "GET", path: "/open/apps" },
  user: { method: "GET", path: "/open/user" },
};

/** Dependency type: numeric in request bodies, enum name in list filters. Do not mix. */
export const DEPENDENCY_TYPES = { 0: "nodejs", 1: "python3", 2: "linux" };
export const DEPENDENCY_TYPE_CODES = { nodejs: 0, node: 0, python3: 1, python: 1, linux: 2 };

/** Dependency install status codes, from the panel docs. */
export const DEPENDENCY_STATUS = {
  0: "installing",
  1: "installed",
  2: "install-failed",
  3: "deleting",
  4: "deleted",
  5: "delete-failed",
  6: "queued",
  7: "cancelled",
};

/**
 * Legacy routes retired by the panel. They still answer HTTP 200 with business code 410 and
 * a message; the core rewrites the error to name the replacement so nobody "fixes" a caller
 * by retrying the dead path.
 */
export const RETIRED_ROUTES = {
  "GET /open/configs/:file": "GET /open/configs/detail?path=config.sh",
  "GET /open/scripts/:file": "GET /open/scripts/detail?file=...",
  "GET /open/logs/:file": "GET /open/logs/detail?file=...",
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
 *   2. environment (QL_URL / QL_ACCESS_TOKEN / QL_CLIENT_ID / QL_CLIENT_SECRET / QL_TIMEOUT_MS)
 *   3. environment-supplied config path (QL_ADMIN_CONFIG)
 *   4. ~/.config/qinglong-admin/config.json
 *
 * The env names QL_URL / QL_ACCESS_TOKEN / QL_CLIENT_ID / QL_CLIENT_SECRET deliberately match
 * the official @whyour/qinglong-cli, so one shell profile configures both tools.
 *
 * Two credential modes, mirroring the official CLI:
 *   * access token  — a valid application or session token; not persisted, not refreshed;
 *   * client credentials — client_id + client_secret exchange for a 30-day application token
 *     on demand; the token is cached in memory and re-fetched once on a 401.
 * A single-use command-line flag can supply either, but secrets belong in config/env.
 */
export function resolveConfig({ flags = {}, env = process.env } = {}) {
  const configPath =
    flags.config || env.QL_ADMIN_CONFIG || join(homedir(), ".config", "qinglong-admin", "config.json");
  const file = readConfigFile(configPath);

  const baseUrl = firstNonEmpty(flags.url, env.QL_URL, file.url, file.baseUrl, file.base_url);
  const accessToken = firstNonEmpty(flags.token, env.QL_ACCESS_TOKEN, file.accessToken, file.token);
  const clientId = firstNonEmpty(flags.clientId, env.QL_CLIENT_ID, file.clientId, file.client_id);
  const clientSecret = firstNonEmpty(flags.clientSecret, env.QL_CLIENT_SECRET, file.clientSecret, file.client_secret);
  const timeoutRaw = firstNonEmpty(flags.timeout, env.QL_TIMEOUT_MS, file.timeoutMs);

  return {
    baseUrl: baseUrl ? normalizeBaseUrl(baseUrl) : undefined,
    accessToken,
    clientId,
    clientSecret,
    timeoutMs: toPositiveInt(timeoutRaw, 30000),
    configPath,
  };
}

export function authMode(config) {
  if (config.accessToken) return "token";
  if (config.clientId && config.clientSecret) return "credentials";
  return "none";
}

export function assertConfigured(config) {
  const missing = [];
  if (!config.baseUrl) missing.push("panel URL (QL_URL or --url)");
  const mode = authMode(config);
  if (mode === "none") {
    missing.push(
      "credential (QL_ACCESS_TOKEN, or QL_CLIENT_ID + QL_CLIENT_SECRET from 面板 系统设置 → 应用设置)",
    );
  } else if (mode === "credentials" && !config.clientSecret) {
    missing.push("client secret (QL_CLIENT_SECRET or --client-secret)");
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

/** Config with secrets reduced to fingerprints, safe to print. */
export function redactConfig(config) {
  return {
    baseUrl: config.baseUrl ?? null,
    auth: authMode(config),
    token: config.accessToken ? maskSecret(config.accessToken) : null,
    clientId: config.clientId ?? null,
    clientSecret: config.clientSecret ? "<set>" : null,
    timeoutMs: config.timeoutMs,
    configPath: config.configPath,
  };
}

export function maskSecret(value) {
  const text = String(value);
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}${"*".repeat(10)}${text.slice(-4)}`;
}

/**
 * A token can be a 30-day application token from GET /open/auth/token or a panel session
 * token. Their shapes differ but the header is the same; only the expiration we learn from
 * the credential exchange is tracked here.
 */
export function tokenFingerprint(value) {
  return value ? maskSecret(value) : null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function buildHeaders(config, token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...extra,
  };
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

// In-memory token cache for the credentials mode. Per process, so a short-lived CLI run
// fetches once and a long-lived MCP server refreshes when the token nears expiry.
let cachedToken;
let cachedExpiration = 0;

export function resetTokenCache() {
  cachedToken = undefined;
  cachedExpiration = 0;
}

/**
 * Return a bearer token, exchanging client credentials when that is the configured mode.
 * Application tokens live 30 days and the panel keeps only the newest 5 per app, so
 * refreshing is cheap and safe; a 401 triggers exactly one forced refresh in `request`.
 */
export async function ensureToken(config, { force = false } = {}) {
  if (config.accessToken) return config.accessToken;
  if (!config.clientId || !config.clientSecret) {
    throw new UsageError("no credential configured: set QL_ACCESS_TOKEN or QL_CLIENT_ID + QL_CLIENT_SECRET");
  }
  const now = Date.now() / 1000;
  if (!force && cachedToken && cachedExpiration - 60 > now) return cachedToken;

  const url = buildUrl(config.baseUrl, "/open/auth/token", {
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new ApiError(`cannot reach ${config.baseUrl} to obtain a token: ${error.message}`, { status: 0 });
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(`token endpoint returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, {
      status: response.status,
    });
  }
  const token = parsed?.data?.token;
  if (Number(parsed?.code) !== 200 || !token) {
    throw new ApiError(
      `could not obtain a token: ${parsed?.message ?? `HTTP ${response.status}`}. ` +
        "Check the application's client_id / client_secret in 面板 系统设置 → 应用设置.",
      { status: response.status, code: parsed?.code, body: parsed },
    );
  }
  cachedToken = token;
  cachedExpiration = Number(parsed?.data?.expiration) || now + 86400;
  return token;
}

/**
 * Perform one request and unwrap the envelope.
 *
 * Qinglong answers errors inside a `{code, message}` body, so the envelope's code decides
 * success — HTTP 200 alone proves nothing. A 401 on a credentials-mode call forces one token
 * refresh and retries; a 401 on an access-token call is final and explains itself.
 */
export async function request(config, { method = "GET", path, query, body, headers, timeoutMs, raw = false, allowText = false, retryOn401 = true } = {}) {
  assertConfigured(config);
  const call = async (token) =>
    fetch(buildUrl(config.baseUrl, path, query), {
      method: method.toUpperCase(),
      headers: buildHeaders(config, token, {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      }),
      signal: AbortSignal.timeout(timeoutMs ?? config.timeoutMs),
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });

  let token = await ensureToken(config);
  let response;
  try {
    response = await call(token);
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(`request timed out after ${timeoutMs ?? config.timeoutMs}ms: ${method} ${path}`);
    }
    throw new ApiError(`cannot reach ${config.baseUrl}: ${error.message}`, { status: 0 });
  }

  let text = await response.text();
  if (response.status === 401 && retryOn401 && !config.accessToken) {
    resetTokenCache();
    token = await ensureToken(config, { force: true });
    response = await call(token);
    text = await response.text();
  }

  let parsed;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    if (raw) return { status: response.status, text, headers: response.headers, path, method: method.toUpperCase() };
    // Some documented routes answer with plain text rather than an envelope: the system log
    // reader, the command-run stream, and binary downloads. Callers that expect that ask for
    // allowText and receive the raw body instead of a parse error.
    if (allowText) {
      return { status: response.status, text, nonJson: true, headers: response.headers, path, method: method.toUpperCase() };
    }
    const snippet = text.slice(0, 300).replace(/\s+/g, " ").trim();
    throw new ApiError(
      `expected JSON from ${method.toUpperCase()} ${path} but got HTTP ${response.status}: ${snippet || "<empty body>"}`,
      { status: response.status },
    );
  }

  if (raw) {
    return { status: response.status, body: parsed, text, headers: response.headers, path, method: method.toUpperCase() };
  }

  const code = parsed.code === undefined ? undefined : Number(parsed.code);
  if (code !== 200) {
    const message = explainFailure({ method, path, status: response.status, parsed, config });
    throw new ApiError(message, { status: response.status, code: parsed.code, body: parsed });
  }

  return { status: response.status, data: parsed.data, message: parsed.message, envelope: parsed, path, method: method.toUpperCase() };
}

/**
 * Turn a failed envelope into a message that says what to do next. The panel distinguishes
 * "no token at all" (HTTP 401, code 401), "token lacks this scope" (403), and retired routes
 * (410); each has a different fix.
 */
function explainFailure({ method, path, status, parsed, config }) {
  const raw = String(parsed?.message ?? `request failed with HTTP ${status}`);
  const code = Number(parsed?.code);
  if (code === 401 || status === 401) {
    if (config.accessToken) {
      return `${raw}\nThe access token was rejected. Tokens live 30 days and are never auto-refreshed in token mode; refresh it in 面板 系统设置 → 应用设置, or switch to QL_CLIENT_ID + QL_CLIENT_SECRET so this plugin can refresh automatically.`;
    }
    return `${raw}\nAuthentication failed even after refreshing the application token. Check the application's client_id / client_secret and that it still exists.`;
  }
  if (code === 403 || status === 403) {
    return `${raw}\nThe application is missing the scope this route needs (or the path is restricted). Scopes are managed in 面板 系统设置 → 应用设置.`;
  }
  if (code === 410) {
    const replacement = RETIRED_ROUTES[`${method.toUpperCase()} ${path}`];
    return replacement
      ? `${raw}\nThis route was retired by the panel. Use ${replacement} instead.`
      : `${raw}\nThis route was retired by the panel; check the route index for its replacement.`;
  }
  return raw;
}

export function extractStatusText(result) {
  return result?.text ?? "";
}

// ---------------------------------------------------------------------------
// Argument parsing and output
// ---------------------------------------------------------------------------

/**
 * Parse argv into `{ positionals, flags }`.
 *
 * Supports `--flag value`, `--flag=value`, `--bool`, `--no-bool`, repeated flags (collected
 * into arrays) and `--` to end flag parsing. Command-specific aliases are resolved by the
 * caller so this stays generic.
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

export function readJsonArg(value, { flagName = "data" } = {}) {
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

/** Milliseconds → a compact human duration, used by dashboard summaries. */
export function formatMillis(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/** Seconds → a compact human duration, used for running-instance elapsed. */
export function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}
