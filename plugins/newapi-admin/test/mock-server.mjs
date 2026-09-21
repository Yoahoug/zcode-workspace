// A mock New API management server, faithful to the contracts documented in
// skills/newapi-admin/references/. Used by test/run-checks.mjs to verify that the CLI
// emits the request shapes the real server expects, and to let a reader see the
// envelope/pagination/auth rules in runnable form.
//
// Fidelity that matters (each of these is a trap the CLI must respect):
//   * failures are HTTP 200 with {success:false,message}, not HTTP error codes
//   * channel reads never return `key` (it serializes as "")
//   * PUT /api/channel/ rejects a body containing `status`
//   * POST /api/channel/{id}/key needs X-Security-Proof and root role
//   * GET /api/channel/update_balance/{id} puts `balance` at the top level, not in `data`
//   * GET /api/log/search is a deprecated stub that always fails
//   * PATCH /api/option/model_pricing is optimistic-locked on expected_version
//   * POST /api/models/sync_upstream is optimistic-locked on source_version
//   * POST /api/vendors/operations requires expected_version
//   * page_size is capped at 100

import { createServer } from "node:http";

const QUOTA_PER_UNIT = 500000;

export function startMockServer({ port = 0, token = "test-token", role = 100 } = {}) {
  const state = {
    requests: [],
    channels: [
      { id: 1, name: "openai-main", type: 1, status: 1, models: "gpt-4o,gpt-4o-mini", group: "default", priority: 10, weight: 1, base_url: "https://api.openai.com", balance: 12.5, response_time: 320, tag: "prod", test_model: "gpt-4o-mini" },
      { id: 2, name: "anthropic", type: 14, status: 2, models: "claude-sonnet-4", group: "default,vip", priority: 5, weight: 1, base_url: "https://api.anthropic.com", balance: 3.25, response_time: 480, tag: "prod", test_model: "claude-sonnet-4" },
      { id: 3, name: "gemini", type: 24, status: 3, models: "gemini-2.0-flash", group: "vip", priority: 1, weight: 1, base_url: "https://generativelanguage.googleapis.com", balance: 0, response_time: 0, tag: "", test_model: "gemini-2.0-flash" },
    ],
    models: [
      { id: 11, model_name: "gpt-4o", name_rule: 0, vendor_id: 1, status: 1, sync_official: 1, configured_channel_count: 1, square_state: "visible", tags: "vision" },
      { id: 12, model_name: "claude", name_rule: 1, vendor_id: 2, status: 1, sync_official: 1, configured_channel_count: 1, square_state: "partial", tags: "" },
    ],
    pricing: new Map([
      ["gpt-4o", { ModelRatio: 1.25, CompletionRatio: 4, CacheRatio: 0.5 }],
      ["gpt-4o-mini", { ModelRatio: 0.075, CompletionRatio: 4 }],
    ]),
    options: new Map([
      ["ModelRatio", JSON.stringify({ "gpt-4o": 1.25, "gpt-4o-mini": 0.075 })],
      ["ModelPrice", JSON.stringify({ "dall-e-3": 0.04 })],
      ["CompletionRatio", JSON.stringify({ "gpt-4o": 4 })],
      ["GroupRatio", JSON.stringify({ default: 1, vip: 0.9 })],
      ["QuotaPerUnit", String(QUOTA_PER_UNIT)],
    ]),
    users: [
      { id: 1, username: "root", display_name: "root", role: 100, status: 1, group: "default", quota: 5000000, used_quota: 120000, email: "root@example.com", request_count: 42 },
      { id: 2, username: "alice", display_name: "Alice", role: 1, status: 1, group: "vip", quota: 1000000, used_quota: 250000, email: "a@example.com", request_count: 7 },
    ],
    tokens: [
      { id: 21, user_id: 1, name: "ci", key: "abcd****************wxyz", status: 1, expired_time: -1, remain_quota: 500000, unlimited_quota: false, group: "default", model_limits: "", model_limits_enabled: false },
    ],
    redemptions: [
      { id: 31, name: "welcome", key: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", status: 1, quota: 5000000, expired_time: 0, redeemed_time: 0 },
    ],
    vendors: [
      { id: 1, name: "OpenAI", description: "First party", icon: "OpenAI", status: 1, model_count: 1, version: "v1" },
    ],
    prefillGroups: [{ id: 41, name: "flagship", type: "model", items: ["gpt-4o"], description: "flagship models" }],
    syncVersion: "sync-v1",
    logs: [
      { id: 51, created_at: 1700000000, type: 2, username: "alice", model_name: "gpt-4o", channel_name: "openai-main", quota: 1250, prompt_tokens: 100, completion_tokens: 200, use_time: 2, content: "ok" },
    ],
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      let parsedBody;
      if (body) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body;
        }
      }
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsedBody, headers: req.headers };
      state.requests.push(record);
      const result = route(record, state, { token, role });
      const payload = JSON.stringify(result.body);
      res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
      res.end(payload);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const ok = (data, message = "") => ({ body: { success: true, message, ...(data === undefined ? {} : { data }) } });
const fail = (message, extra = {}) => ({ body: { success: false, message, ...extra } });

function paginate(items, query) {
  const page = Math.max(Number(query.p ?? 1) || 1, 1);
  const rawSize = Number(query.page_size ?? query.ps ?? query.size ?? 10) || 10;
  const pageSize = Math.min(rawSize, 100);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, page_size: pageSize };
}

function route(record, state, { token, role }) {
  const { method, path, query, body, headers } = record;

  // --- public routes -------------------------------------------------------
  if (path === "/api/status" && method === "GET") {
    return ok({ version: "v0.9.9-mock", start_time: 1700000000, setup: true, quota_per_unit: QUOTA_PER_UNIT, usd_exchange_rate: 7.3 });
  }
  if (path === "/api/status/test" && method === "GET") {
    if (!authorized(headers, token)) return fail("无权进行此操作，未登录且未提供 access token");
    return ok({ http_stats: { total: 10, success: 9 } });
  }

  // --- token-key authenticated routes (must precede the panel-token gate) --
  if (path === "/api/usage/token/" && method === "GET") {
    // This route authenticates with the API token itself (`Bearer sk-...`), not the panel token.
    if (!headers.authorization?.startsWith("Bearer sk-")) return { status: 401, body: { success: false, message: "Invalid Bearer token" } };
    return { body: { code: true, message: "ok", data: { object: "token_usage", name: "ci", total_granted: 6000000, total_used: 1000000, total_available: 5000000, unlimited_quota: false, model_limits: {}, model_limits_enabled: false, expires_at: 0 } } };
  }

  // --- auth ---------------------------------------------------------------
  if (!authorized(headers, token)) {
    if (path === "/api/channel/" && method === "GET") return fail("无权进行此操作，未登录且未提供 access token");
    return fail("无权进行此操作，未登录且未提供 access token");
  }

  // --- channels -----------------------------------------------------------
  if (path === "/api/channel/" && method === "GET") {
    let items = state.channels.slice();
    if (query.status === "enabled" || query.status === "1") items = items.filter((c) => c.status === 1);
    else if (query.status === "disabled" || query.status === "0") items = items.filter((c) => c.status !== 1);
    if (query.group) items = items.filter((c) => String(c.group).split(",").includes(query.group));
    if (query.type) items = items.filter((c) => String(c.type) === String(query.type));
    const typeCounts = {};
    for (const channel of items) typeCounts[String(channel.type)] = (typeCounts[String(channel.type)] ?? 0) + 1;
    const page = paginate(items, query);
    // The real server omits the key column; it serializes as an empty string.
    return ok({ ...page, items: page.items.map(withholdKey), type_counts: typeCounts });
  }
  if (path === "/api/channel/search" && method === "GET") {
    let items = state.channels.slice();
    if (query.keyword) items = items.filter((c) => c.name.includes(query.keyword) || String(c.id) === query.keyword);
    if (query.model) items = items.filter((c) => String(c.models).includes(query.model));
    // Search defaults to page_size 20 and returns no page/page_size keys.
    const page = paginate(items, { ...query, page_size: query.page_size ?? 20 });
    return ok({ items: page.items.map(withholdKey), total: page.total });
  }
  if (path === "/api/channel/models_enabled" && method === "GET") return ok(["gpt-4o", "gpt-4o-mini", "claude-sonnet-4"]);
  if (path === "/api/channel/models" && method === "GET") return ok([{ id: "gpt-4o", object: "model", created: 1626777600, owned_by: "openai" }]);
  if (path === "/api/channel/default_base_urls" && method === "GET") return ok({ 1: "https://api.openai.com", 14: "https://api.anthropic.com" });

  const channelId = path.match(/^\/api\/channel\/(\d+)$/);
  if (channelId && method === "GET") {
    const channel = state.channels.find((c) => c.id === Number(channelId[1]));
    return channel ? ok(withholdKey(channel)) : fail("渠道不存在");
  }
  if (channelId && method === "DELETE") {
    const index = state.channels.findIndex((c) => c.id === Number(channelId[1]));
    if (index === -1) return fail("渠道不存在");
    state.channels.splice(index, 1);
    return ok(undefined);
  }
  if (path === "/api/channel/" && method === "POST") {
    if (!body?.mode || !["single", "batch", "multi_to_single"].includes(body.mode)) return fail("不支持的添加模式");
    const channel = body.channel ?? {};
    if (!channel.key) return fail("密钥不能为空");
    const created = { ...channel, id: Math.max(0, ...state.channels.map((c) => c.id)) + 1, status: 1, balance: 0, response_time: 0 };
    state.channels.push(created);
    return ok(undefined);
  }
  if (path === "/api/channel/" && method === "PUT") {
    // A channel update must not carry `status`.
    if (body && Object.prototype.hasOwnProperty.call(body, "status")) return fail("参数错误");
    const channel = state.channels.find((c) => c.id === Number(body?.id));
    if (!channel) return fail("渠道不存在");
    Object.assign(channel, body);
    return ok(withholdKey(channel));
  }
  const statusPath = path.match(/^\/api\/channel\/(\d+)\/status$/);
  if (statusPath && method === "POST") {
    if (body?.status !== 1 && body?.status !== 2) return fail("参数错误");
    const channel = state.channels.find((c) => c.id === Number(statusPath[1]));
    if (!channel) return fail("渠道不存在");
    channel.status = body.status;
    return ok(undefined);
  }
  if (path === "/api/channel/status/batch" && method === "POST") {
    if (!Array.isArray(body?.ids) || (body.status !== 1 && body.status !== 2)) return fail("参数错误");
    for (const id of body.ids) {
      const channel = state.channels.find((c) => c.id === id);
      if (channel) channel.status = body.status;
    }
    return ok(undefined);
  }
  if (path === "/api/channel/batch" && method === "POST") {
    if (!Array.isArray(body?.ids) || body.ids.length === 0) return fail("参数错误");
    let deleted = 0;
    for (const id of body.ids) {
      const index = state.channels.findIndex((c) => c.id === id);
      if (index !== -1) {
        state.channels.splice(index, 1);
        deleted += 1;
      }
    }
    return ok(deleted);
  }
  if (path === "/api/channel/disabled" && method === "DELETE") {
    const before = state.channels.length;
    state.channels = state.channels.filter((c) => c.status === 1);
    return ok(before - state.channels.length);
  }
  if (path === "/api/channel/fix" && method === "POST") return ok({ success: state.channels.length, fails: 0 });
  if (path === "/api/channel/test" && method === "GET") return { status: 409, body: { success: false, message: "已有通道测试任务正在运行或等待中，不能启动本次手动任务", data: { task_id: "t1", status: "running", type: "channel_test" } } };
  const testPath = path.match(/^\/api\/channel\/test\/(\d+)$/);
  if (testPath && method === "GET") {
    const channel = state.channels.find((c) => c.id === Number(testPath[1]));
    if (!channel) return fail("渠道不存在");
    return { body: { success: true, message: "", time: 1.234 } };
  }
  if (path === "/api/channel/update_balance" && method === "GET") return ok(undefined);
  const balancePath = path.match(/^\/api\/channel\/update_balance\/(\d+)$/);
  if (balancePath && method === "GET") {
    // Note: balance lives at the top level, NOT inside data.
    return { body: { success: true, message: "", balance: 12.34 } };
  }
  const fetchPath = path.match(/^\/api\/channel\/fetch_models\/(\d+)$/);
  if (fetchPath && method === "GET") return ok(["gpt-4o", "gpt-4o-mini", "o3-mini"]);
  if (path === "/api/channel/fetch_models" && method === "POST") {
    if (body?.type === undefined) return { status: 400, body: { success: false, message: "Invalid request" } };
    return ok(["gpt-4o", "o3-mini"]);
  }
  const keyPath = path.match(/^\/api\/channel\/(\d+)\/key$/);
  if (keyPath && method === "POST") {
    if (role < 100) return fail("无权进行此操作，权限不足");
    if (!headers["x-security-proof"]) return fail("SECURITY_PROOF_REQUIRED", { code: "SECURITY_PROOF_REQUIRED" });
    return ok({ key: "sk-mock-secret-key" });
  }
  if (path === "/api/channel/batch/tag" && method === "POST") {
    if (!Array.isArray(body?.ids) || body.ids.length === 0) return fail("参数错误");
    for (const id of body.ids) {
      const channel = state.channels.find((c) => c.id === id);
      if (channel) channel.tag = body.tag ?? "";
    }
    return ok(body.ids.length);
  }
  if ((path === "/api/channel/tag/enabled" || path === "/api/channel/tag/disabled") && method === "POST") {
    if (!body?.tag) return fail("参数错误");
    const next = path.endsWith("enabled") ? 1 : 2;
    for (const channel of state.channels) if (channel.tag === body.tag) channel.status = next;
    return ok(undefined);
  }
  if (path === "/api/channel/tag" && method === "PUT") {
    if (!body?.tag) return fail("tag不能为空");
    let touched = 0;
    for (const channel of state.channels) {
      if (channel.tag !== body.tag) continue;
      touched += 1;
      if (body.new_tag !== undefined) channel.tag = body.new_tag;
      if (body.models) channel.models = body.models;
      if (body.groups) channel.group = body.groups;
      if (body.priority !== undefined) channel.priority = body.priority;
      if (body.weight !== undefined) channel.weight = body.weight;
    }
    return ok(undefined);
  }
  if (path === "/api/channel/tag/models" && method === "GET") {
    if (!query.tag) return { status: 400, body: { success: false, message: "tag不能为空" } };
    return ok("gpt-4o,gpt-4o-mini");
  }
  const copyPath = path.match(/^\/api\/channel\/copy\/(\d+)$/);
  if (copyPath && method === "POST") return ok({ id: 99 });
  if (path === "/api/channel/multi_key/manage" && method === "POST") {
    if (!["get_key_status", "disable_key", "enable_key", "delete_key", "enable_all_keys", "disable_all_keys", "delete_disabled_keys"].includes(body?.action)) {
      return fail("不支持的操作");
    }
    if (body.action === "get_key_status") {
      return ok({
        keys: [{ index: 0, status: 1, key_preview: "sk-abcdefg..." }, { index: 1, status: 3, disabled_time: 1730000000, reason: "auth failed", key_preview: "sk-hijklmn..." }],
        total: 2,
        page: body.page ?? 1,
        page_size: body.page_size ?? 50,
        total_pages: 1,
        enabled_count: 1,
        manual_disabled_count: 0,
        auto_disabled_count: 1,
      });
    }
    if (body.action === "delete_disabled_keys") return ok(1);
    return { body: { success: true, message: "密钥已禁用" } };
  }
  if (path.startsWith("/api/channel/upstream_updates/")) return ok({ detected: 2, applied: 1 });

  // --- model metadata -----------------------------------------------------
  if ((path === "/api/models/" || path === "/api/models/search") && method === "GET") {
    const page = paginate(state.models, query);
    return ok({ ...page, vendor_counts: { 1: 1, 2: 1 } });
  }
  if (path === "/api/models/missing" && method === "GET") return ok(["o3-mini"]);
  if (path === "/api/models/sync_upstream/preview" && method === "GET") {
    return ok({
      source: { locale: query.locale || "zh", models_url: "https://basellm.github.io/llm-metadata/api/newapi/models.json", vendors_url: "https://basellm.github.io/llm-metadata/api/newapi/vendors.json", version: state.syncVersion },
      candidates: [
        { model_name: "gpt-4o", kind: "update", scope: "site", record_version: "rec-11", fields: [{ field: "tags", local: "vision", upstream: "vision,audio" }] },
        { model_name: "o3-mini", kind: "create", scope: "catalog", record_version: "rec-new", fields: [], upstream: { description: "reasoning", vendor: "OpenAI" } },
        { model_name: "gone-model", kind: "missing_upstream", scope: "site", record_version: "rec-13", fields: [] },
      ],
    });
  }
  if (path === "/api/models/sync_upstream" && method === "POST") {
    if (!body?.source_version || !Array.isArray(body.selections) || body.selections.length === 0) {
      return { status: 400, body: { success: false, message: "Preview and select metadata changes before applying" } };
    }
    // The confirmation token: reject if the upstream changed since the preview.
    if (body.source_version !== state.syncVersion) {
      return { status: 409, body: { success: false, message: "Upstream metadata changed; preview again" } };
    }
    const created = body.selections.filter((s) => s.create).map((s) => s.model_name);
    const updated = body.selections.filter((s) => !s.create).map((s) => ({ model_name: s.model_name, record_version: "rec", create: false, fields: s.fields }));
    return ok({ created_models: created, updated_models: updated, created_vendors: [] });
  }
  const modelId = path.match(/^\/api\/models\/(\d+)$/);
  if (modelId && method === "GET") {
    const model = state.models.find((m) => m.id === Number(modelId[1]));
    return model ? ok(model) : fail("模型不存在");
  }
  if (modelId && method === "DELETE") {
    const index = state.models.findIndex((m) => m.id === Number(modelId[1]));
    if (index === -1) return fail("模型不存在");
    state.models.splice(index, 1);
    return ok({ deleted_count: 1, updated_channels: 0 });
  }
  if (path === "/api/models/" && method === "POST") {
    if (!body?.model_name) return fail("模型名称不能为空");
    const created = { ...body, id: Math.max(0, ...state.models.map((m) => m.id)) + 1, has_metadata: true };
    state.models.push(created);
    return ok(created);
  }
  if (path === "/api/models/" && method === "PUT") {
    const model = state.models.find((m) => m.id === Number(body?.id));
    if (!model) return fail("缺少模型 ID");
    Object.assign(model, body);
    return ok(model);
  }
  if (path === "/api/models/delete" && method === "POST") {
    if (!Array.isArray(body?.model_ids) || body.model_ids.length === 0) return fail("参数错误");
    state.models = state.models.filter((m) => !body.model_ids.includes(m.id));
    return ok({ deleted_count: body.model_ids.length, updated_channels: 0 });
  }

  // --- options and pricing ------------------------------------------------
  if (path === "/api/option/" && method === "GET") {
    const data = [...state.options.entries()].map(([key, value]) => ({ key, value }));
    return ok(data);
  }
  if (path === "/api/option/" && method === "PUT") {
    if (!body?.key) return fail("参数错误");
    // The real server coerces non-string values with %v, so a nested object is destroyed.
    if (typeof body.value !== "string") return fail("参数错误：value 必须是字符串");
    state.options.set(body.key, body.value);
    return ok(undefined);
  }
  if (path === "/api/option/model_pricing" && method === "GET") {
    const wanted = query.model ? (Array.isArray(query.model) ? query.model : [query.model]) : [...state.pricing.keys()];
    const entries = wanted
      .filter((name) => state.pricing.has(name))
      .map((name) => {
        const configured = state.pricing.get(name);
        return {
          model_name: name,
          version: versionOf(configured),
          configured,
          effective: { ModelRatio: 1, CompletionRatio: 1, CacheRatio: 1, CreateCacheRatio: 1.25, ImageRatio: 1, ...configured },
          cache_write_mode: "none",
          billing_details: { mode: "ratio" },
          plugin_variants: [],
          usage_schema: {},
        };
      });
    return ok({ entries, options: Object.fromEntries(state.options), empty_version: versionOf({}) });
  }
  if (path === "/api/option/model_pricing" && method === "PATCH") {
    if (!Array.isArray(body?.changes)) return fail("参数错误");
    for (const change of body.changes) {
      const current = state.pricing.get(change.model_name);
      const expected = current ? versionOf(current) : versionOf({});
      if (!change.expected_version) return { status: 409, body: { success: false, message: "模型定价配置已被修改，请刷新后重试", code: "MODEL_PRICING_CONFLICT" } };
      if (change.expected_version !== expected) {
        return { status: 409, body: { success: false, message: "模型定价配置已被修改，请刷新后重试", code: "MODEL_PRICING_CONFLICT" } };
      }
      if (change.reset) state.pricing.set(change.model_name, { ModelRatio: 1, CompletionRatio: 1 });
      else state.pricing.set(change.model_name, { ...(current ?? {}), ...(change.pricing ?? {}) });
    }
    return ok({ updated_models: body.changes.map((c) => c.model_name) });
  }
  if (path === "/api/option/model_pricing/preview" && method === "POST") {
    return ok({ effective: { ModelRatio: 1, CompletionRatio: 1, CacheRatio: 1, CreateCacheRatio: 1.25, ImageRatio: 1, ...(body?.pricing ?? {}) }, cache_write_mode: "none", billing_details: { mode: "ratio" } });
  }
  if (path === "/api/option/model_pricing/convert" && method === "POST") {
    return ok({ expression: body?.model_name?.includes("video") ? undefined : "u(\"prompt_tokens\") * 1.25 / 1000000", unsupported_reason: body?.model_name?.includes("video") ? "task model not convertible" : undefined });
  }
  if (path === "/api/option/rest_model_ratio" && method === "POST") {
    state.options.set("ModelRatio", JSON.stringify({ "gpt-4o": 1, "gpt-4o-mini": 0.05 }));
    return { body: { success: true, message: "重置模型倍率成功" } };
  }
  if (path === "/api/option/request_policy" && method === "GET") {
    return ok({ options: { RetryTimes: "2", AutomaticDisableChannelEnabled: "true" } });
  }
  if (path === "/api/option/request_policy" && method === "PATCH") {
    if (!body?.options || typeof body.options !== "object") return fail("参数错误");
    return ok(undefined);
  }
  if (path === "/api/option/payment_compliance" && method === "POST") return ok(undefined);
  if (path === "/api/option/channel_affinity_cache" && method === "DELETE") return ok(undefined);
  if (path === "/api/option/channel_affinity_cache" && method === "GET") return ok({ size: 12 });

  // --- ratio sync ---------------------------------------------------------
  if (path === "/api/ratio_sync/channels" && method === "GET") {
    return ok([
      { id: -100, name: "官方倍率预设", base_url: "https://basellm.github.io", status: 1, type: 0 },
      { id: 1, name: "openai-main", base_url: "https://api.openai.com", status: 1, type: 1 },
    ]);
  }
  if (path === "/api/ratio_sync/fetch" && method === "POST") {
    if (!body?.channel_ids?.length && !body?.upstreams?.length) return fail("参数错误");
    return ok({
      differences: { "gpt-4o": { model_ratio: { current: 1.25, upstreams: { "ch(1)": 2.5 }, confidence: { "ch(1)": true } } } },
      prices: { "gpt-4o": { current: { ModelRatio: 1.25 }, upstreams: { "ch(1)": { ModelRatio: 2.5 } } } },
      test_results: [{ name: "ch(1)", status: "success" }],
    });
  }

  // --- users --------------------------------------------------------------
  if (path === "/api/user/self" && method === "GET") {
    return ok({ id: 1, username: "root", role, group: "default", quota: 5000000, used_quota: 120000, request_count: 42 });
  }
  if (path === "/api/user/" && method === "GET") return ok(paginate(state.users, query));
  if (path === "/api/user/search" && method === "GET") {
    let items = state.users.slice();
    if (query.keyword) items = items.filter((u) => u.username.includes(query.keyword) || String(u.id) === query.keyword);
    if (query.group) items = items.filter((u) => u.group === query.group);
    if (query.role) items = items.filter((u) => String(u.role) === String(query.role));
    if (query.status) items = items.filter((u) => String(u.status) === String(query.status));
    return ok(paginate(items, query));
  }
  if (path === "/api/user/topup" && method === "GET") {
    return ok(paginate([{ id: 61, user_id: 2, amount: 5000000, money: 10, trade_no: "USR2NOabc", payment_method: "stripe", payment_provider: "stripe", create_time: 1700000000, complete_time: 1700000100, status: "success" }], query));
  }
  if (path === "/api/user/topup/complete" && method === "POST") {
    if (!body?.trade_no) return fail("参数错误");
    return ok(null);
  }
  const userId = path.match(/^\/api\/user\/(\d+)$/);
  if (userId && method === "GET") {
    const user = state.users.find((u) => u.id === Number(userId[1]));
    return user ? ok(user) : fail("用户不存在");
  }
  if (userId && method === "DELETE") {
    state.users = state.users.filter((u) => u.id !== Number(userId[1]));
    return ok(undefined);
  }
  if (path === "/api/user/" && method === "POST") {
    if (!body?.username || !body?.password) return fail("参数错误");
    state.users.push({ id: Math.max(0, ...state.users.map((u) => u.id)) + 1, username: body.username, display_name: body.display_name ?? body.username, role: body.role ?? 1, status: 1, group: "default", quota: 0, used_quota: 0 });
    return ok(undefined);
  }
  if (path === "/api/user/" && method === "PUT") {
    if (!body?.id) return fail("参数错误");
    const user = state.users.find((u) => u.id === Number(body.id));
    if (!user) return fail("用户不存在");
    // Only these persist on the real server.
    for (const key of ["username", "display_name", "group", "remark", "password"]) {
      if (body[key] !== undefined) user[key] = body[key];
    }
    return ok(undefined);
  }
  if (path === "/api/user/manage" && method === "POST") {
    const user = state.users.find((u) => u.id === Number(body?.id));
    if (!user) return fail("用户不存在");
    switch (body.action) {
      case "enable":
        user.status = 1;
        return ok({ role: user.role, status: user.status });
      case "disable":
        user.status = 2;
        return ok({ role: user.role, status: user.status });
      case "promote":
        user.role = 10;
        return ok({ role: user.role, status: user.status });
      case "demote":
        user.role = 1;
        return ok({ role: user.role, status: user.status });
      case "delete":
        state.users = state.users.filter((u) => u.id !== user.id);
        return ok({ role: user.role, status: user.status });
      case "add_quota": {
        if (!["add", "subtract", "override"].includes(body.mode)) return fail("参数错误");
        if (body.mode === "override") user.quota = Number(body.value);
        else if (body.mode === "add") user.quota += Number(body.value);
        else user.quota -= Number(body.value);
        return ok(undefined);
      }
      default:
        return fail("参数错误");
    }
  }
  if (path === "/api/user/2fa/stats" && method === "GET") return ok({ enabled: 1, disabled: 1 });
  if (/^\/api\/user\/\d+\/(reset_passkey|2fa)$/.test(path) && method === "DELETE") return ok(undefined);
  if (/^\/api\/user\/\d+\/(oauth\/bindings|bindings)\//.test(path) && method === "DELETE") return ok(undefined);
  if (/^\/api\/user\/\d+\/oauth\/bindings$/.test(path) && method === "GET") return ok([{ provider: "github", provider_id: "123" }]);

  // --- tokens -------------------------------------------------------------
  if ((path === "/api/token/" || path === "/api/token/search") && method === "GET") return ok(paginate(state.tokens, query));
  const tokenId = path.match(/^\/api\/token\/(\d+)$/);
  if (tokenId && method === "GET") {
    const found = state.tokens.find((t) => t.id === Number(tokenId[1]));
    return found ? ok(found) : fail("令牌不存在");
  }
  if (tokenId && method === "DELETE") {
    state.tokens = state.tokens.filter((t) => t.id !== Number(tokenId[1]));
    return ok(undefined);
  }
  const tokenKey = path.match(/^\/api\/token\/(\d+)\/key$/);
  if (tokenKey && method === "POST") {
    return ok({ key: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL" });
  }
  if (path === "/api/token/" && method === "POST") {
    if (!body?.name) return fail("参数错误");
    if (String(body.name).length > 50) return fail("令牌名称过长");
    state.tokens.push({ id: Math.max(0, ...state.tokens.map((t) => t.id)) + 1, user_id: 1, name: body.name, key: "****", status: 1, ...body });
    return ok(undefined);
  }
  if (path === "/api/token/" && method === "PUT") {
    const found = state.tokens.find((t) => t.id === Number(body?.id));
    if (!found) return fail("令牌不存在");
    Object.assign(found, body);
    return ok(found);
  }
  if (path === "/api/token/batch" && method === "POST") {
    if (!Array.isArray(body?.ids) || body.ids.length === 0) return fail("参数错误");
    const before = state.tokens.length;
    state.tokens = state.tokens.filter((t) => !body.ids.includes(t.id));
    return ok(before - state.tokens.length);
  }
  if (path === "/api/token/batch/keys" && method === "POST") {
    if (!Array.isArray(body?.ids) || body.ids.length === 0) return fail("参数错误");
    return ok({ keys: Object.fromEntries(body.ids.map((id) => [String(id), "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL"])) });
  }
  if (path === "/api/token/auto-groups" && method === "GET") return ok({ groups: ["default", "vip"], max_count: 5 });

  // --- redemptions --------------------------------------------------------
  if ((path === "/api/redemption/" || path === "/api/redemption/search") && method === "GET") {
    let items = state.redemptions.slice();
    if (query.keyword) items = items.filter((r) => r.name.startsWith(query.keyword));
    if (query.status === "1") items = items.filter((r) => r.status === 1);
    if (query.status === "3") items = items.filter((r) => r.status === 3);
    return ok(paginate(items, query));
  }
  if (path === "/api/redemption/" && method === "POST") {
    const count = Number(body?.count ?? 0);
    if (!body?.name || body.name.length > 20) return fail("兑换码名称长度必须在 1 到 20 之间");
    if (!(count >= 1 && count <= 100)) return fail("兑换码数量必须在 1 到 100 之间");
    if (!(Number(body?.quota) > 0)) return fail("额度必须大于 0");
    const created = [];
    for (let i = 0; i < count; i += 1) {
      const code = `mockcode${String(i).padStart(24, "0")}`;
      created.push(code);
      state.redemptions.push({ id: Math.max(0, ...state.redemptions.map((r) => r.id)) + 1, name: body.name, key: code, status: 1, quota: body.quota, expired_time: body.expired_time ?? 0, redeemed_time: 0 });
    }
    return ok(created);
  }
  if (path === "/api/redemption/" && method === "PUT") {
    const found = state.redemptions.find((r) => r.id === Number(body?.id));
    if (!found) return fail("兑换码不存在");
    Object.assign(found, body);
    return ok(found);
  }
  const redemptionId = path.match(/^\/api\/redemption\/(\d+)$/);
  if (redemptionId && method === "GET") {
    const found = state.redemptions.find((r) => r.id === Number(redemptionId[1]));
    return found ? ok(found) : fail("兑换码不存在");
  }
  if (redemptionId && method === "DELETE") {
    state.redemptions = state.redemptions.filter((r) => r.id !== Number(redemptionId[1]));
    return ok(undefined);
  }
  if (path === "/api/redemption/invalid" && method === "DELETE") {
    const before = state.redemptions.length;
    state.redemptions = state.redemptions.filter((r) => r.status === 1 && (r.expired_time === 0 || r.expired_time > 1700000000));
    return ok(before - state.redemptions.length);
  }
  if (path === "/api/redemption/batch" && method === "POST") {
    if (!Array.isArray(body?.ids) || body.ids.length === 0 || body.ids.length > 1000) return fail("参数错误");
    const before = state.redemptions.length;
    state.redemptions = state.redemptions.filter((r) => !body.ids.includes(r.id));
    return ok(before - state.redemptions.length);
  }
  if (path === "/api/user/topup" && method === "POST") {
    if (!body?.key) return fail("参数错误");
    return ok(undefined);
  }

  // --- logs and data ------------------------------------------------------
  if (path === "/api/log/" && method === "GET") return ok(paginate(state.logs, query));
  if (path === "/api/log/search" && method === "GET") return fail("该接口已废弃");
  if (path === "/api/log/self" && method === "GET") return ok(paginate(state.logs, query));
  if (path === "/api/log/stat" && method === "GET") return ok({ quota: 125000, rpm: 4, tpm: 8123 });
  if (path === "/api/log/self/stat" && method === "GET") return ok({ quota: 5000, rpm: 1, tpm: 300 });
  if (path === "/api/log/token" && method === "GET") return ok(paginate(state.logs, query));
  if (path === "/api/data/" && method === "GET") return ok([{ id: 71, user_id: 2, username: "alice", model_name: "gpt-4o", created_at: 1700000000, use_group: "default", token_id: 21, channel_id: 1, token_used: 300, count: 2, quota: 2500 }]);
  if (path === "/api/data/users" && method === "GET") return ok([{ username: "alice", created_at: 1700000000, count: 2, quota: 2500 }]);
  if (path === "/api/data/flow" && method === "GET") {
    if (!query.start_timestamp || !query.end_timestamp) return fail("invalid start_timestamp");
    return ok([{ user_id: 2, username: "alice", node_name: "n1", token_id: 21, token_name: "ci", use_group: "default", channel_id: 1, channel_name: "openai-main", model_name: "gpt-4o", token_used: 300, count: 2, quota: 2500 }]);
  }
  if (path === "/api/data/self" && method === "GET") return ok([]);
  if (path === "/api/data/flow/self" && method === "GET") return ok([]);
  if (path === "/api/audit" && method === "GET") return ok(paginate([{ id: 81, username: "root", action: "channel:update", created_at: 1700000000 }], query));

  // --- groups / vendors / prefill ----------------------------------------
  if (path === "/api/group/" && method === "GET") return ok(["default", "vip", "auto"]);
  if (path === "/api/user/groups" && method === "GET") return ok({ default: { ratio: 1, desc: "默认" } });
  if (path === "/api/prefill_group/" && method === "GET") {
    const items = query.type ? state.prefillGroups.filter((g) => g.type === query.type) : state.prefillGroups;
    return ok(items);
  }
  if (path === "/api/prefill_group/" && method === "POST") {
    if (!body?.name || !body?.type) return fail("组名称和类型不能为空");
    const created = { id: Math.max(0, ...state.prefillGroups.map((g) => g.id)) + 1, ...body };
    state.prefillGroups.push(created);
    return ok(created);
  }
  if (path === "/api/prefill_group/" && method === "PUT") {
    if (!body?.id) return fail("缺少组 ID");
    const found = state.prefillGroups.find((g) => g.id === Number(body.id));
    if (!found) return fail("组不存在");
    Object.assign(found, body);
    return ok(found);
  }
  const prefillId = path.match(/^\/api\/prefill_group\/(\d+)$/);
  if (prefillId && method === "DELETE") {
    state.prefillGroups = state.prefillGroups.filter((g) => g.id !== Number(prefillId[1]));
    return ok(null);
  }
  if ((path === "/api/vendors/" || path === "/api/vendors/search") && method === "GET") return ok(paginate(state.vendors, query));
  const vendorId = path.match(/^\/api\/vendors\/(\d+)$/);
  if (vendorId && method === "GET") {
    const found = state.vendors.find((v) => v.id === Number(vendorId[1]));
    return found ? ok(found) : { status: 400, body: { success: false, message: "vendor not found" } };
  }
  if (vendorId && method === "DELETE") {
    const index = state.vendors.findIndex((v) => v.id === Number(vendorId[1]));
    if (index === -1) return { status: 400, body: { success: false, message: "vendor not found" } };
    state.vendors.splice(index, 1);
    return ok(null);
  }
  if (path === "/api/vendors/" && method === "POST") {
    if (!body?.name) return { status: 400, body: { success: false, message: "vendor name is required" } };
    const created = { id: Math.max(0, ...state.vendors.map((v) => v.id)) + 1, status: 1, created_time: 1700000000, updated_time: 1700000000, version: "v2", ...body };
    state.vendors.push(created);
    return ok(created);
  }
  if (path === "/api/vendors/" && method === "PUT") {
    if (!body?.id) return { status: 400, body: { success: false, message: "缺少供应商 ID" } };
    const found = state.vendors.find((v) => v.id === Number(body.id));
    if (!found) return { status: 400, body: { success: false, message: "vendor not found" } };
    if (body.version && body.version !== found.version) return { status: 409, body: { success: false, message: "vendor changed", code: "VENDOR_CONFLICT" } };
    Object.assign(found, body, { version: "v3" });
    return ok(found);
  }
  if (path === "/api/vendors/operations/preview" && method === "POST") {
    if (!["assign", "merge", "delete"].includes(body?.action)) return { status: 400, body: { success: false, message: "unsupported vendor operation" } };
    const sources = state.vendors.filter((v) => (body.vendor_ids ?? []).includes(v.id));
    return ok({
      action: body.action,
      sources,
      target: body.action === "delete" ? null : state.vendors.find((v) => v.id === Number(body.target_vendor_id)) ?? null,
      models: [],
      version: "preview-v1",
    });
  }
  if (path === "/api/vendors/operations" && method === "POST") {
    if (!body?.expected_version) return { status: 409, body: { success: false, message: "version is required", code: "VENDOR_CONFLICT" } };
    if (body.expected_version !== "preview-v1") return { status: 409, body: { success: false, message: "stale", code: "VENDOR_CONFLICT" } };
    return ok({ updated_models: [], deleted_vendors: body.vendor_ids ?? [] });
  }

  // --- system tasks / info ------------------------------------------------
  if (path === "/api/system-task/list" && method === "GET") return ok([{ id: "st1", type: "channel_test", status: "completed", created_at: 1700000000 }]);
  if (path === "/api/system-task/current" && method === "GET") return ok(null);
  if (path === "/api/system-task/history" && method === "DELETE") return ok(undefined);
  if (path === "/api/system-task/log-cleanup" && method === "POST") return ok({ task_id: "st2", status: "pending" });
  if (/^\/api\/system-task\/[\w-]+$/.test(path) && method === "GET") return ok({ id: path.split("/").pop(), type: "channel_test", status: "completed" });
  if (path === "/api/system-info/instances" && method === "GET") return ok([{ node_name: "node-1", last_seen: 1700000000 }]);
  if (path === "/api/system-info/stale-instances" && method === "DELETE") return ok(undefined);
  if (/^\/api\/system-info\/instances\//.test(path) && method === "DELETE") return ok(undefined);
  if (path === "/api/performance/stats" && method === "GET") return ok({ goroutines: 42, memory_mb: 128 });
  if (path === "/api/performance/logs" && method === "GET") return ok([{ name: "one-api.log", size: 1024 }]);
  if (path === "/api/performance/logs" && method === "DELETE") return ok(undefined);
  if (path === "/api/performance/disk_cache" && method === "DELETE") return ok(undefined);
  if (path === "/api/performance/gc" && method === "POST") return ok(undefined);
  if (path === "/api/authz/catalog" && method === "GET") return ok({ resources: [{ name: "channel", actions: ["read", "operate", "write", "sensitive_write"] }] });
  if (path === "/api/task/" && method === "GET") return ok([{ id: 1, task_id: "task-1", status: "SUCCESS", model: "gpt-4o", platform: "openai" }]);
  if (path === "/api/mj/" && method === "GET") return ok([{ id: 2, task_id: "mj-1", status: "SUCCESS", model: "midjourney", platform: "mj" }]);
  if (path === "/api/task/self" && method === "GET") return ok([]);
  if (path === "/api/subscription/admin/plans" && method === "GET") return ok([]);

  return { status: 404, body: { success: false, message: `mock has no route for ${method} ${path}` } };
}

function authorized(headers, token) {
  const header = headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

/** Channel reads never include the key; the server omits the column and it serializes as "". */
function withholdKey(channel) {
  return { ...channel, key: "", openai_organization: "", other_info: "", model_mapping: "", status_code_mapping: "", setting: "", settings: "", param_override: "", header_override: "", remark: "" };
}

/** Deterministic stand-in for the server's sha256-based pricing record version. */
function versionOf(value) {
  const text = JSON.stringify(value ?? {});
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}
