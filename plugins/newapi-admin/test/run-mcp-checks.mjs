// Checks for the MCP adapter: spawn server/index.mjs over stdio, speak JSON-RPC to it, and
// assert the tool surface and its answers against the mock server.
//
// Run: node test/run-mcp-checks.mjs

import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startMockServer } from "./mock-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const SERVER = join(here, "..", "server", "index.mjs");
const TOKEN = "test-token";

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures.push({ name, detail });
    process.stdout.write(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}\n`);
  }
}

const mock = await startMockServer({ token: TOKEN });

const child = spawn("node", [SERVER], {
  env: { ...process.env, NEWAPI_BASE_URL: mock.baseUrl, NEWAPI_ACCESS_TOKEN: TOKEN, NEWAPI_USER_ID: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const pending = new Map();
let nextId = 1;
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function callTool(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
  const content = response.result?.content?.[0]?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = content;
  }
  return { text: content, data: parsed, isError: response.result?.isError === true };
}

try {
  process.stdout.write("\nMCP handshake and tool surface\n");

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "checks", version: "1" } });
  check("initialize negotiates a protocol version", init.result?.protocolVersion === "2025-06-18", JSON.stringify(init.result));
  check("initialize advertises tool capability", Boolean(init.result?.capabilities?.tools), JSON.stringify(init.result?.capabilities));
  check("initialize reports the server name", init.result?.serverInfo?.name === "newapi-admin", JSON.stringify(init.result?.serverInfo));

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  check("tools/list returns the tool surface", tools.length >= 12, `count=${tools.length}`);
  check("every tool declares an input schema", tools.every((tool) => tool.inputSchema?.type === "object"), "a tool is missing inputSchema");
  check("every tool has a description", tools.every((tool) => typeof tool.description === "string" && tool.description.length > 40), "a tool description is too short");
  check("a generic request tool exists for full coverage", tools.some((tool) => tool.name === "newapi_request"), "missing newapi_request");
  check("a route-discovery tool exists", tools.some((tool) => tool.name === "newapi_routes"), "missing newapi_routes");
  check("a reference reader exists", tools.some((tool) => tool.name === "newapi_reference"), "missing newapi_reference");

  process.stdout.write("\ndocumentation tools\n");
  {
    const result = await callTool("newapi_routes", { term: "ratio" });
    check("newapi_routes finds ratio endpoints", result.text.includes("/api/ratio_sync/fetch"), result.text.slice(0, 300));
    check("newapi_routes shows permission tiers", /root/.test(result.text), result.text.slice(0, 300));
  }
  {
    const result = await callTool("newapi_routes", {});
    check("newapi_routes lists the whole index when unfiltered", /of \d+ routes/.test(result.text), result.text.slice(0, 200));
  }
  {
    const result = await callTool("newapi_reference", { topic: "models-and-pricing" });
    check("newapi_reference returns the pricing reference", result.text.includes("ModelRatio"), result.text.slice(0, 200));
  }
  {
    const result = await callTool("newapi_reference", { topic: "nope" });
    check("newapi_reference lists valid topics for a bad topic", result.text.includes("Available:"), result.text.slice(0, 200));
  }

  process.stdout.write("\ntyped tools\n");
  {
    const result = await callTool("newapi_status", {});
    check("newapi_status reports the conversion rate", result.data?.conversion === "1 USD = 500000 quota", JSON.stringify(result.data));
  }
  {
    const result = await callTool("newapi_channels_list", { status: "enabled" });
    check("newapi_channels_list returns channels", Array.isArray(result.data?.channels) && result.data.channels.length > 0, JSON.stringify(result.data).slice(0, 300));
    check("newapi_channels_list resolves provider names", result.data.channels.some((channel) => channel.provider === "OpenAI"), JSON.stringify(result.data.channels?.[0]));
    check("newapi_channels_list resolves status names", result.data.channels.every((channel) => channel.status === "enabled"), JSON.stringify(result.data.channels?.map((c) => c.status)));
    check("newapi_channels_list never exposes secrets", !result.text.includes("sk-"), result.text.slice(0, 200));
  }
  {
    const result = await callTool("newapi_channels_list", { type: "not-a-provider" });
    check("newapi_channels_list rejects an unknown provider name", result.isError && /Unknown channel type/.test(result.text), result.text);
  }
  {
    const result = await callTool("newapi_channel_test", { id: 1 });
    check("newapi_channel_test reads the top-level time field", result.data?.ok === true && result.data?.time_seconds === 1.234, JSON.stringify(result.data));
  }
  {
    const result = await callTool("newapi_models_list", {});
    check("newapi_models_list decodes the name rule", result.data?.models?.some((model) => model.name_rule === "prefix"), JSON.stringify(result.data).slice(0, 300));
  }
  {
    const preview = await callTool("newapi_models_sync_preview", { locale: "zh" });
    check("sync preview groups candidates by kind", preview.data?.candidate_counts?.create === 1, JSON.stringify(preview.data?.candidate_counts));
    check("sync preview surfaces per-record versions", preview.data?.candidates?.every((candidate) => candidate.record_version), JSON.stringify(preview.data?.candidates));
    check("sync preview explains the next step", typeof preview.data?.next_step === "string", String(preview.data?.next_step));

    const selections = preview.data.candidates
      .filter((candidate) => candidate.kind === "create" || candidate.kind === "update")
      .map((candidate) => ({ model_name: candidate.model_name, record_version: candidate.record_version, create: candidate.kind === "create", fields: candidate.changed_fields }));
    const applied = await callTool("newapi_models_sync_apply", { locale: "zh", source_version: preview.data.source.version, selections });
    check("sync apply echoes the source version and succeeds", applied.data?.created_models?.includes("o3-mini"), JSON.stringify(applied.data));

    const stale = await callTool("newapi_models_sync_apply", { locale: "zh", source_version: "stale-version", selections });
    check("sync apply rejects a stale source version with the server message", stale.isError && /preview again|409/.test(stale.text), stale.text.slice(0, 300));
  }
  {
    const result = await callTool("newapi_pricing_get", { model: "gpt-4o" });
    check("pricing get states the ratio unit rule", /1 ratio = \$0\.002 per 1K tokens/.test(String(result.data?.unit_notes?.ModelRatio)), JSON.stringify(result.data?.unit_notes));
    check("pricing get converts the ratio to a USD rate", result.data?.models?.[0]?.ratio_as_usd_per_1m === 2.5, JSON.stringify(result.data?.models?.[0]));
  }
  {
    const result = await callTool("newapi_pricing_set", { model: "gpt-4o", usd_per_1m: 4 });
    check("pricing set converts USD-per-1M into the ratio", result.data?.applied?.ModelRatio === 2, JSON.stringify(result.data));
    check("pricing set restates the change in USD", result.data?.expressed_as === "$4 per 1M tokens", String(result.data?.expressed_as));
    const request_ = mock.state.requests.filter((r) => r.path === "/api/option/model_pricing" && r.method === "PATCH").pop();
    check("pricing set sends an optimistic-lock version", typeof request_?.body?.changes?.[0]?.expected_version === "string", JSON.stringify(request_?.body));
  }
  {
    const result = await callTool("newapi_pricing_set", { model: "gpt-4o" });
    check("pricing set refuses an empty change", result.isError && /Nothing to change/.test(result.text), result.text);
  }
  {
    const result = await callTool("newapi_pricing_cost", { model: "gpt-4o", prompt_tokens: 1000, completion_tokens: 500 });
    check("pricing cost returns quota and USD", Number.isFinite(result.data?.quota) && Number.isFinite(result.data?.usd), JSON.stringify(result.data));
    check("pricing cost states its caveat", /does not cover/.test(String(result.data?.caveat)), String(result.data?.caveat));
  }
  {
    const result = await callTool("newapi_users_list", { keyword: "alice" });
    check("users list converts quota to USD", result.data?.users?.[0]?.balance_usd === 2, JSON.stringify(result.data?.users?.[0]));
    check("users list decodes the role", /user \(1\)/.test(String(result.data?.users?.[0]?.role)), String(result.data?.users?.[0]?.role));
  }
  {
    const result = await callTool("newapi_user_quota", { id: 2, mode: "add", usd: 5 });
    check("user quota converts USD to quota units", result.data?.quota === 2500000, JSON.stringify(result.data));
    const request_ = mock.state.requests.filter((r) => r.path === "/api/user/manage").pop();
    check("user quota sends the documented manage payload", request_?.body?.action === "add_quota" && request_?.body?.mode === "add", JSON.stringify(request_?.body));
  }
  {
    const result = await callTool("newapi_user_quota", { id: 2, mode: "add", value: -5 });
    check("user quota rejects a negative amount for add", result.isError && /positive/.test(result.text), result.text);
  }
  {
    const result = await callTool("newapi_logs", { type: "consume" });
    check("logs maps the type name to its code", mock.state.requests.filter((r) => r.path === "/api/log/").pop()?.query?.type === "2", "wrong type code");
    check("logs returns rows", result.data?.returned >= 1, JSON.stringify(result.data).slice(0, 200));
  }

  process.stdout.write("\ngeneric passthrough and safety\n");
  {
    const result = await callTool("newapi_request", { method: "GET", path: "/api/group/" });
    check("newapi_request reaches an untyped route", result.text.includes("default"), result.text.slice(0, 200));
  }
  {
    const result = await callTool("newapi_request", { method: "GET", path: "/api/channel/", query: { status: "enabled", page_size: "5" } });
    check("newapi_request forwards query parameters", mock.state.requests.filter((r) => r.path === "/api/channel/").pop()?.query?.status === "enabled", "query not forwarded");
  }
  {
    const result = await callTool("newapi_request", { method: "DELETE", path: "/api/channel/1" });
    check("newapi_request refuses a destructive call without confirm", result.isError && /confirm:true/.test(result.text), result.text.slice(0, 300));
    check("the refused destructive call sent no request", !mock.state.requests.some((r) => r.method === "DELETE" && r.path === "/api/channel/1"));
  }
  {
    const result = await callTool("newapi_request", { method: "DELETE", path: "/api/redemption/31", confirm: true });
    check("newapi_request runs a destructive call once confirmed", !result.isError, result.text.slice(0, 200));
    check("the confirmed destructive call reached the server", mock.state.requests.some((r) => r.method === "DELETE" && r.path === "/api/redemption/31"));
  }
  {
    const result = await callTool("newapi_request", { method: "GET", path: "/api/definitely-not-real" });
    check("an unknown route is reported as a tool error", result.isError, result.text.slice(0, 200));
  }
  {
    const response = await rpc("tools/call", { name: "not_a_tool", arguments: {} });
    check("an unknown tool is reported as a tool error", response.result?.isError === true, JSON.stringify(response.result).slice(0, 200));
  }
  {
    const response = await rpc("nonexistent/method", {});
    check("an unknown method is a JSON-RPC error", response.error?.code === -32601, JSON.stringify(response.error));
  }
  {
    check("the server does not echo the access token on stderr", !stderr.includes(TOKEN), stderr.slice(0, 300));
    check("the server logs its readiness on stderr only", /ready: \d+ tools, \d+ routes indexed/.test(stderr), stderr.slice(0, 300));
  }
} finally {
  child.kill();
  await mock.close();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write("\nfailures:\n");
  for (const failure of failures) process.stdout.write(`  - ${failure.name}: ${failure.detail ?? ""}\n`);
  process.exit(1);
}
