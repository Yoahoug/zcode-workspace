// Checks for the MCP adapter: spawn server/index.mjs over stdio, speak JSON-RPC to it, and
// assert the tool surface and its answers against the mock panel.
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
  env: { ...process.env, QL_URL: mock.baseUrl, QL_ACCESS_TOKEN: TOKEN, QL_ADMIN_CONFIG: "/nonexistent/config.json" },
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
  check("initialize reports the server name", init.result?.serverInfo?.name === "qinglong-admin", JSON.stringify(init.result?.serverInfo));

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  check("tools/list returns the tool surface", tools.length >= 18, `count=${tools.length}`);
  check("every tool declares an input schema", tools.every((tool) => tool.inputSchema?.type === "object"), "a tool is missing inputSchema");
  check("every tool has a description", tools.every((tool) => typeof tool.description === "string" && tool.description.length > 40), "a tool description is too short");
  check("a generic request tool exists for full coverage", tools.some((tool) => tool.name === "qinglong_request"), "missing qinglong_request");
  check("a route-discovery tool exists", tools.some((tool) => tool.name === "qinglong_routes"), "missing qinglong_routes");
  check("a reference reader exists", tools.some((tool) => tool.name === "qinglong_reference"), "missing qinglong_reference");

  process.stdout.write("\ndocumentation tools\n");
  {
    const result = await callTool("qinglong_routes", { term: "retention" });
    check("qinglong_routes finds retention endpoints", result.text.includes("/open/system/storage-retention/cleanup"), result.text.slice(0, 300));
    check("qinglong_routes shows scopes and destructive marks", /system/.test(result.text) && /destructive/.test(result.text), result.text.slice(0, 400));
  }
  {
    const result = await callTool("qinglong_routes", {});
    check("qinglong_routes lists the whole index when unfiltered", /of 143 routes/.test(result.text), result.text.slice(0, 200));
  }
  {
    const result = await callTool("qinglong_reference", { topic: "pitfalls" });
    check("qinglong_reference returns the pitfalls doc", result.text.includes("accepted") && result.text.includes("410"), result.text.slice(0, 200));
  }
  {
    const result = await callTool("qinglong_reference", { topic: "nope" });
    check("qinglong_reference lists valid topics for a bad topic", result.text.includes("Available:"), result.text.slice(0, 200));
  }

  process.stdout.write("\nstatus and tasks\n");
  {
    const result = await callTool("qinglong_status", {});
    check("qinglong_status reports the panel version", result.data?.version === "2.20.0-1", JSON.stringify(result.data));
    check("qinglong_status reports the auth mode", result.data?.auth_mode === "token", JSON.stringify(result.data));
  }
  {
    const result = await callTool("qinglong_status", { scope: "crons" });
    check("qinglong_status probes a scope", result.data?.scope_probe?.result === "ok", JSON.stringify(result.data));
  }
  {
    const result = await callTool("qinglong_tasks_list", { search: "hello" });
    check("qinglong_tasks_list filters by searchValue", result.data?.returned === 1 && result.data.tasks[0].id === 1, JSON.stringify(result.data).slice(0, 300));
    check("qinglong_tasks_list passes task objects through", result.data.tasks[0].command === "task hello.js", JSON.stringify(result.data.tasks[0]));
  }
  {
    const result = await callTool("qinglong_task_get", { id: 1 });
    check("qinglong_task_get fetches by id", result.data?.name === "hello 测试", JSON.stringify(result.data).slice(0, 200));
  }
  {
    const result = await callTool("qinglong_task_get", { name: "hello" });
    check("qinglong_task_get resolves names", result.data?.id === 1, JSON.stringify(result.data).slice(0, 200));
  }
  {
    const result = await callTool("qinglong_task_get", { name: "does-not-exist" });
    check("qinglong_task_get reports a miss as a tool error", result.isError && /No task matches/.test(result.text), result.text.slice(0, 200));
  }
  {
    const result = await callTool("qinglong_task_create", { name: "mcp task", command: "task mcp.js", schedule: "0 4 * * *" });
    check("qinglong_task_create succeeds", !result.isError && result.data?.created === true, result.text.slice(0, 200));
    check("qinglong_task_create explains the id re-read", /capture the real id/.test(String(result.data?.next_step)), String(result.data?.next_step));
    const request = mock.state.requests.filter((r) => r.method === "POST" && r.path === "/open/crons").pop();
    check("qinglong_task_create sent command and schedule", request?.body?.command === "task mcp.js" && request?.body?.schedule === "0 4 * * *", JSON.stringify(request?.body));
  }
  {
    const result = await callTool("qinglong_task_update", { id: 1, command: "task hello.js", schedule: "0 11 * * *" });
    check("qinglong_task_update submits the whole record", !result.isError, result.text.slice(0, 200));
    const request = mock.state.requests.filter((r) => r.method === "PUT" && r.path === "/open/crons").pop();
    check("qinglong_task_update injected id + both fields", request?.body?.id === 1 && request?.body?.schedule === "0 11 * * *", JSON.stringify(request?.body));
  }
  {
    const result = await callTool("qinglong_task_action", { action: "run", ids: [1, 2] });
    check("qinglong_task_action sends an ID array", JSON.stringify(mock.state.runRequests.filter((r) => r.kind === "task").pop()?.ids) === "[1,2]", JSON.stringify(mock.state.runRequests));
    check("qinglong_task_action restates accepted≠success", /accepted≠success/.test(String(result.data?.note)), String(result.data?.note));
  }
  {
    const result = await callTool("qinglong_task_action", { action: "launch", ids: [1] });
    check("qinglong_task_action rejects an unknown action", result.isError && /run, stop, enable/.test(result.text), result.text.slice(0, 200));
  }
  {
    const result = await callTool("qinglong_task_logs", { id: 1, offset: 0, limit: 10 });
    check("qinglong_task_logs returns a byte chunk with meta", result.text.includes("hello worl") && /"nextOffset":10/.test(result.text) && /"truncated":true/.test(result.text), result.text.slice(0, 300));
  }
  {
    const result = await callTool("qinglong_task_instances", { id: 1 });
    check("qinglong_task_instances returns run evidence", result.data?.returned === 1 && result.data.instances[0].instanceId === "i-1001", JSON.stringify(result.data));
  }

  process.stdout.write("\nenvironments, subscriptions, dependencies\n");
  {
    const result = await callTool("qinglong_envs_list", {});
    check("qinglong_envs_list returns rows", result.data?.returned === 2, JSON.stringify(result.data).slice(0, 200));
  }
  {
    const result = await callTool("qinglong_env_create", { entries: [{ name: "MCP_KEY", value: "1" }] });
    check("qinglong_env_create posts the object array", JSON.stringify(mock.state.requests.filter((r) => r.method === "POST" && r.path === "/open/envs").pop()?.body) === '[{"name":"MCP_KEY","value":"1"}]', JSON.stringify(mock.state.requests.filter((r) => r.method === "POST" && r.path === "/open/envs").pop()?.body));
  }
  {
    const result = await callTool("qinglong_env_create", { entries: [{ name: "bad-name", value: "1" }] });
    check("qinglong_env_create enforces the name rule", result.isError && /letter\/underscore|letter or underscore/i.test(result.text), result.text.slice(0, 200));
  }
  {
    const result = await callTool("qinglong_env_update", { id: 1, name: "EXAMPLE_KEY", value: "v3" });
    check("qinglong_env_update restates id/name/value", !result.isError && mock.state.requests.filter((r) => r.method === "PUT" && r.path === "/open/envs").pop()?.body?.value === "v3", result.text.slice(0, 200));
  }
  {
    const result = await callTool("qinglong_env_delete", { ids: [2] });
    check("qinglong_env_delete refuses without confirm", result.isError && /confirm:true/.test(result.text), result.text.slice(0, 200));
    const confirmed = await callTool("qinglong_env_delete", { ids: [2], confirm: true });
    check("qinglong_env_delete runs once confirmed", !confirmed.isError, confirmed.text.slice(0, 200));
    check("the confirmed delete reached the panel", JSON.stringify(mock.state.requests.filter((r) => r.method === "DELETE" && r.path === "/open/envs").pop()?.body) === "[2]", "no DELETE body");
  }
  {
    const result = await callTool("qinglong_subscription_create", { type: "public-repo", url: "https://example.com/repo.git", alias: "mcp", schedule_type: "crontab", schedule: "0 0 * * *" });
    check("qinglong_subscription_create posts the mandatory four", !result.isError, result.text.slice(0, 200));
    const request = mock.state.requests.filter((r) => r.method === "POST" && r.path === "/open/subscriptions").pop();
    check("subscription body carries type/url/alias/schedule_type", request?.body?.type === "public-repo" && request?.body?.schedule_type === "crontab", JSON.stringify(request?.body));
    check("subscription create explains the pull-then-check step", /files appeared/.test(String(result.data?.next_step)), String(result.data?.next_step));
  }
  {
    const result = await callTool("qinglong_subscription_action", { action: "run", ids: [1] });
    check("qinglong_subscription_action runs the pull route", JSON.stringify(mock.state.runRequests.filter((r) => r.kind === "subscription").pop()?.ids) === "[1]", JSON.stringify(mock.state.runRequests));
  }
  {
    const result = await callTool("qinglong_dependencies_list", { type: "nodejs" });
    check("qinglong_dependencies_list filters by enum name", result.data?.returned === 1 && result.data.dependencies[0].name === "axios", JSON.stringify(result.data).slice(0, 300));
    check("dependency rows carry decoded names", result.data.dependencies[0].type_name === "nodejs" && result.data.dependencies[0].status_name === "installed", JSON.stringify(result.data.dependencies[0]));
  }
  {
    const result = await callTool("qinglong_dependency_install", { entries: [{ name: "requests", type: "python3" }] });
    check("qinglong_dependency_install converts the enum to a number", JSON.stringify(mock.state.requests.filter((r) => r.method === "POST" && r.path === "/open/dependencies").pop()?.body) === '[{"name":"requests","type":1}]', JSON.stringify(mock.state.requests.filter((r) => r.method === "POST" && r.path === "/open/dependencies").pop()?.body));
    check("dependency install restates queued≠installed", /Queued ≠ installed/.test(String(result.data?.note)), String(result.data?.note));
  }

  process.stdout.write("\nlogs, dashboard, generic passthrough and safety\n");
  {
    const result = await callTool("qinglong_log_read", { file: "2026-10-01-09-00-00.log", path: "hello", offset: 0, limit: 10 });
    check("qinglong_log_read returns a byte chunk with continuation", result.text.includes("hello worl") && /"nextOffset":10/.test(result.text), result.text.slice(0, 300));
  }
  {
    const result = await callTool("qinglong_dashboard", { view: "overview" });
    check("qinglong_dashboard returns the overview", result.data?.successRate === 80, JSON.stringify(result.data));
  }
  {
    const result = await callTool("qinglong_dashboard", { view: "failures" });
    check("qinglong_dashboard reaches the unindexed failures view", !result.isError && Array.isArray(result.data), result.text.slice(0, 200));
  }
  {
    const result = await callTool("qinglong_request", { method: "GET", path: "/open/configs/config.sh" });
    check("a retired route explains its replacement", result.isError && /\/open\/configs\/detail/.test(result.text), result.text.slice(0, 300));
  }
  {
    const result = await callTool("qinglong_request", { method: "GET", path: "/open/dashboard/successes" });
    check("qinglong_request reaches unindexed routes", !result.isError, result.text.slice(0, 200));
    check("qinglong_request notes unindexed paths", /not in the bundled route index/.test(result.text), result.text.slice(0, 300));
  }
  {
    const result = await callTool("qinglong_request", { method: "DELETE", path: "/open/envs", body: [1] });
    check("qinglong_request refuses a destructive call without confirm", result.isError && /confirm:true/.test(result.text), result.text.slice(0, 300));
  }
  {
    const before = mock.state.requests.filter((r) => r.method === "DELETE" && r.path === "/open/envs").length;
    const result = await callTool("qinglong_request", { method: "DELETE", path: "/open/envs", body: [1], confirm: true });
    check("qinglong_request runs a confirmed destructive call", !result.isError, result.text.slice(0, 200));
    check("the confirmed call reached the panel", mock.state.requests.filter((r) => r.method === "DELETE" && r.path === "/open/envs").length === before + 1, "no DELETE seen");
  }
  {
    const result = await callTool("qinglong_request", { method: "GET", path: "/open/definitely-not-real" });
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
