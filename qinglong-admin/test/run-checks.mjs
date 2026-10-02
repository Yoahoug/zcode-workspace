// Checks for the qinglong-admin CLI: run it against the mock panel and assert both the HTTP
// request shapes it emits and the answers it renders. Each check names the panel trap it pins
// down, so a future edit that breaks a contract fails loudly here instead of on a real panel.
//
// Run: node test/run-checks.mjs

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startMockServer } from "./mock-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(here, "..", "scripts", "qinglong-admin.mjs");
const CONFIG_PATH = join(mkdtempSync(join(tmpdir(), "ql-admin-checks-")), "config.json");
const OUT_DIR = mkdtempSync(join(tmpdir(), "ql-admin-out-"));

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

const mock = await startMockServer();

function baseEnv(extra = {}) {
  const env = { ...process.env, QL_URL: mock.baseUrl, QL_ACCESS_TOKEN: mock.token, QL_ADMIN_CONFIG: CONFIG_PATH };
  delete env.QL_CLIENT_ID;
  delete env.QL_CLIENT_SECRET;
  delete env.QL_TIMEOUT_MS;
  return { ...env, ...extra };
}

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { env: baseEnv(extraEnv), timeout: 20000 }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const requests = (method, path) => mock.state.requests.filter((request) => request.method === method && request.path === path).pop();

// ---------------------------------------------------------------------------

process.stdout.write("\nconnection and status\n");
{
  const result = await run(["status", "--json"]);
  const data = parseJson(result.stdout);
  check("status reports the panel version", data?.system?.version === "2.20.0-1", result.stdout.slice(0, 300));
  check("status reports health", data?.health?.ok === true, result.stdout.slice(0, 300));
  check("status checks health before system info", mock.state.requests.some((r) => r.path === "/open/health"));
}
{
  const result = await run(["status", "--scope", "crons", "--json"]);
  const data = parseJson(result.stdout);
  check("scope probe reports an authorized scope", data?.[0]?.result === "ok", result.stdout.slice(0, 300));
}
{
  const result = await run(["status", "--scope", "apps", "--json"], { QL_ACCESS_TOKEN: mock.narrowToken });
  const data = parseJson(result.stdout);
  check("scope probe reports a denied scope with the panel message", data?.[0]?.result === "denied" && /403|权限/.test(data[0].message), result.stdout.slice(0, 300));
}
{
  const result = await run(["status", "--json"], { QL_ACCESS_TOKEN: "wrong-token" });
  check("a rejected access token explains the fix", result.code === 1 && /rejected/.test(result.stderr) && /应用设置/.test(result.stderr), result.stderr.slice(0, 300));
}
{
  const result = await run(["status", "--json"], { QL_ACCESS_TOKEN: "", QL_CLIENT_ID: "test-client", QL_CLIENT_SECRET: "test-secret" });
  const data = parseJson(result.stdout);
  check("credentials mode exchanges a token first", mock.state.requests.some((r) => r.path === "/open/auth/token" && r.query.client_id === "test-client"), "no token exchange seen");
  check("credentials mode still reaches the panel", data?.system?.version === "2.20.0-1", result.stdout.slice(0, 300));
}
{
  const result = await run(["config"]);
  const data = parseJson(result.stdout);
  check("config redacts the credential", data?.auth === "token" && !result.stdout.includes(mock.token), result.stdout.slice(0, 300));
}
{
  const result = await run(["version"]);
  check("version matches the manifest", result.stdout.trim() === "0.2.0", result.stdout.trim());
}

process.stdout.write("\nroutes index\n");
{
  const result = await run(["routes", "--json"]);
  const data = parseJson(result.stdout);
  check("routes indexes 143 routes", data?.total === 143, `total=${data?.total}`);
}
{
  const result = await run(["routes", "retention", "--json"]);
  const data = parseJson(result.stdout);
  check("routes finds retention routes", data?.routes?.some((route) => route.path.endsWith("storage-retention/cleanup")), result.stdout.slice(0, 300));
}
{
  const result = await run(["routes"]);
  check("routes text mode names the extras", result.stdout.includes("/open/dashboard/successes"), result.stdout.slice(-300));
}

process.stdout.write("\ntasks\n");
{
  const result = await run(["task", "list", "--json"]);
  const data = parseJson(result.stdout);
  check("task list returns the panel rows", Array.isArray(data) && data.length === 2, result.stdout.slice(0, 300));
}
{
  const result = await run(["task", "list", "--search", "hello", "--json"]);
  const data = parseJson(result.stdout);
  check("task list forwards searchValue", data?.length === 1 && data[0].id === 1, result.stdout.slice(0, 300));
  check("task list sent searchValue as a query param", requests("GET", "/open/crons")?.query?.searchValue === "hello", JSON.stringify(requests("GET", "/open/crons")?.query));
}
{
  const result = await run(["task", "get", "1", "--json"]);
  const data = parseJson(result.stdout);
  check("task get fetches by id", data?.name === "hello 测试", result.stdout.slice(0, 300));
}
{
  const result = await run(["task", "get", "hello", "--json"]);
  const data = parseJson(result.stdout);
  check("task get resolves a name to matches with ids", Array.isArray(data) && data.length === 1 && data[0].id === 1, result.stdout.slice(0, 300));
}
{
  const result = await run(["task", "create", "--name", "no schedule", "--command", "task hello.js"]);
  check("task create refuses a missing schedule", result.code === 2 && /--schedule/.test(result.stderr), result.stderr.slice(0, 200));
}
{
  const result = await run(["task", "create", "--name", "nightly", "--command", "task nightly.js", "--schedule", "0 3 * * *", "--json"]);
  check("task create succeeds", result.code === 0, result.stderr.slice(0, 300));
  const request = requests("POST", "/open/crons");
  check("task create sends command and schedule", request?.body?.command === "task nightly.js" && request?.body?.schedule === "0 3 * * *", JSON.stringify(request?.body));
}
{
  const result = await run(["task", "update", "1", "--schedule", "0 10 * * *"]);
  check("task update refuses a partial whole-record submit", result.code === 2 && /whole record/.test(result.stderr), result.stderr.slice(0, 300));
}
{
  const result = await run(["task", "update", "1", "--command", "task hello.js", "--schedule", "0 10 * * *", "--json"]);
  check("task update succeeds with both mandatory fields", result.code === 0, result.stderr.slice(0, 300));
  const request = requests("PUT", "/open/crons");
  check("task update injects id and both fields", request?.body?.id === 1 && request?.body?.command === "task hello.js" && request?.body?.schedule === "0 10 * * *", JSON.stringify(request?.body));
}
{
  const result = await run(["task", "run", "1", "--json"]);
  const data = parseJson(result.stdout);
  check("task run takes an ID array body", JSON.stringify(requests("PUT", "/open/crons/run")?.body) === "[1]", JSON.stringify(requests("PUT", "/open/crons/run")?.body));
  check("task run reports accepted as submitted-only", data?.accepted === true, result.stdout.slice(0, 200));
  const text = await run(["task", "run", "1"]);
  check("task run says accepted≠success in prose", /accepted≠success|instances/.test(text.stdout), text.stdout.slice(0, 300));
}
{
  const result = await run(["task", "stop", "1", "2", "--json"]);
  check("task stop accepts multiple IDs", JSON.stringify(requests("PUT", "/open/crons/stop")?.body) === "[1,2]", JSON.stringify(requests("PUT", "/open/crons/stop")?.body));
}
{
  await run(["task", "disable", "2"]);
  const list = await run(["task", "list", "--json"]);
  const row = parseJson(list.stdout)?.find((task) => task.id === 2);
  check("task disable flips isDisabled through the panel", row?.isDisabled === 1, JSON.stringify(row));
}
{
  const result = await run(["task", "logs", "1", "--offset", "0", "--limit", "10", "--json"]);
  const data = parseJson(result.stdout);
  check("task logs reads a byte chunk", data?.data === "hello worl", JSON.stringify(data));
  check("task logs returns nextOffset for continuation", data?.nextOffset === 10 && data?.truncated === true, JSON.stringify(data));
}
{
  const result = await run(["task", "instances", "1", "--json"]);
  const data = parseJson(result.stdout);
  check("task instances returns the run evidence", Array.isArray(data) && data[0]?.instanceId === "i-1001" && data[0]?.elapsed === 2, result.stdout.slice(0, 300));
}

process.stdout.write("\nenvironments\n");
{
  const result = await run(["env", "list", "--json"]);
  const data = parseJson(result.stdout);
  check("env list returns rows", data?.length === 2, result.stdout.slice(0, 300));
}
{
  const result = await run(["env", "create", "--name", "OK_KEY", "--value", "v1", "--json"]);
  check("env create accepts a named single entry", result.code === 0, result.stderr.slice(0, 200));
  check("env create wraps the entry in a body array", JSON.stringify(requests("POST", "/open/envs")?.body) === '[{"name":"OK_KEY","value":"v1"}]', JSON.stringify(requests("POST", "/open/envs")?.body));
}
{
  const result = await run(["env", "create", "--data", '[{"name":"bad-name","value":"1"}]']);
  check("env create validates --data entries before sending", result.code === 2 && /letter or underscore/.test(result.stderr), result.stderr.slice(0, 300));
}
{
  const result = await run(["env", "create", "--name", "BAD-NAME", "--value", "1"]);
  check("env create validates names before sending", result.code === 2 && /invalid env name/.test(result.stderr), result.stderr.slice(0, 200));
}
{
  const result = await run(["env", "update", "1", "--value", "only"]);
  check("env update refuses a patch-shaped submit", result.code === 2 && /id \+ name \+ value/.test(result.stderr), result.stderr.slice(0, 200));
}
{
  const result = await run(["env", "update", "1", "--name", "EXAMPLE_KEY", "--value", "v2", "--json"]);
  check("env update restates id/name/value", result.code === 0, result.stderr.slice(0, 200));
  const request = requests("PUT", "/open/envs");
  check("env update body carries all three fields", request?.body?.id === 1 && request?.body?.name === "EXAMPLE_KEY" && request?.body?.value === "v2", JSON.stringify(request?.body));
}
{
  const result = await run(["env", "delete", "2"]);
  check("env delete refuses without --yes", result.code === 2 && /--yes/.test(result.stderr), result.stderr.slice(0, 200));
  check("the refused delete sent no request", !mock.state.requests.some((r) => r.method === "DELETE" && r.path === "/open/envs"));
  const confirmed = await run(["env", "delete", "2", "--yes", "--json"]);
  check("env delete runs once confirmed", confirmed.code === 0, confirmed.stderr.slice(0, 200));
  check("env delete sent the ID array", JSON.stringify(requests("DELETE", "/open/envs")?.body) === "[2]", JSON.stringify(requests("DELETE", "/open/envs")?.body));
}
{
  const result = await run(["env", "rename", "--ids", "1", "--name", "RENAMED_KEY", "--json"]);
  const request = requests("PUT", "/open/envs/name");
  check("env rename sends ids + name", result.code === 0 && JSON.stringify(request?.body) === '{"ids":[1],"name":"RENAMED_KEY"}', JSON.stringify(request?.body));
}

process.stdout.write("\nsubscriptions, dependencies, scripts, configs\n");
{
  const result = await run(["sub", "create", "--type", "public-repo", "--url", "https://example.com/r.git", "--schedule-type", "crontab", "--json"]);
  check("sub create enforces alias as mandatory", result.code === 2 && /alias/.test(result.stderr), result.stderr.slice(0, 200));
}
{
  const result = await run(["sub", "create", "--type", "public-repo", "--url", "https://example.com/r.git", "--alias", "r", "--schedule-type", "crontab", "--schedule", "0 0 * * *", "--json"]);
  check("sub create succeeds with the mandatory four", result.code === 0, result.stderr.slice(0, 300));
  const request = requests("POST", "/open/subscriptions");
  check("sub create sends type/url/alias/schedule_type", request?.body?.type === "public-repo" && request?.body?.schedule_type === "crontab", JSON.stringify(request?.body));
}
{
  await run(["sub", "run", "1", "--json"]);
  check("sub run sends an ID array to the run route", JSON.stringify(requests("PUT", "/open/subscriptions/run")?.body) === "[1]", JSON.stringify(requests("PUT", "/open/subscriptions/run")?.body));
}
{
  const result = await run(["dep", "list", "--type", "nodejs", "--json"]);
  const data = parseJson(result.stdout);
  check("dep list filters by enum name", data?.length === 1 && data[0].name === "axios", result.stdout.slice(0, 300));
}
{
  const result = await run(["dep", "list", "--type", "0", "--json"]);
  check("dep list rejects the numeric form the panel rejects", result.code === 1 && /one of \[nodejs/.test(result.stderr), result.stderr.slice(0, 300));
}
{
  const result = await run(["dep", "create", "--name", "lodash", "--type", "nodejs", "--json"]);
  check("dep create converts the enum name to a numeric type", JSON.stringify(requests("POST", "/open/dependencies")?.body) === '[{"name":"lodash","type":0}]', JSON.stringify(requests("POST", "/open/dependencies")?.body));
}
{
  const result = await run(["dep", "create", "--name", "x", "--type", "ruby"]);
  check("dep create rejects an unknown type before sending", result.code === 2, result.stderr.slice(0, 200));
}
{
  const result = await run(["script", "get", "--file", "hello.js", "--json"]);
  check("script get returns the content", result.stdout.includes("console.log"), result.stdout.slice(0, 200));
}
{
  const result = await run(["script", "run", "--file", "hello.js"]);
  check("script run demands --filename, teaching the swap semantics", result.code === 2 && /swap|debug/.test(result.stderr), result.stderr.slice(0, 300));
}
{
  const result = await run(["script", "run", "--filename", "hello.js", "--json"]);
  check("script run uses the debug route", result.code === 0 && requests("PUT", "/open/scripts/run")?.body?.filename === "hello.js", result.stderr.slice(0, 200));
}
{
  const result = await run(["configs", "get", "--path", "config.sh", "--json"]);
  check("configs get reads via /detail", result.stdout.includes("# config"), result.stdout.slice(0, 200));
}
{
  const result = await run(["configs", "save", "--name", "config.sh", "--content", "# new\n", "--json"]);
  check("configs save overwrites whole-file", result.code === 0 && requests("POST", "/open/configs/save")?.body?.content === "# new\n", result.stderr.slice(0, 200));
}

process.stdout.write("\nlogs\n");
{
  const result = await run(["log", "get", "--path", "hello", "--file", "2026-10-01-09-00-00.log", "--offset", "0", "--limit", "10", "--json"]);
  const data = parseJson(result.stdout);
  check("log get returns a byte chunk with continuation", data?.data === "hello worl" && data?.nextOffset === 10 && data?.truncated === true, result.stdout.slice(0, 300));
}
{
  const output = join(OUT_DIR, "downloaded.log");
  const result = await run(["log", "download", "--path", "hello", "--file", "2026-10-01-09-00-00.log", "--output", output]);
  check("log download writes the file", result.code === 0 && readFileSync(output, "utf8").startsWith("hello world"), result.stderr.slice(0, 200));
  const again = await run(["log", "download", "--path", "hello", "--file", "2026-10-01-09-00-00.log", "--output", output]);
  check("log download refuses to overwrite", again.code === 2 && /overwrite/.test(again.stderr), again.stderr.slice(0, 200));
}

process.stdout.write("\nsystem and dashboard\n");
{
  const result = await run(["system", "command-run", "--command", "echo hi"]);
  check("system command-run prints the text stream", result.stdout.includes("command output line"), result.stdout.slice(0, 200));
}
{
  const result = await run(["system", "log"]);
  check("system log prints text, not JSON", result.stdout.includes("panel ready"), result.stdout.slice(0, 200));
}
{
  await run(["system", "notify", "--title", "t", "--content", "c", "--json"]);
  check("system notify reaches the panel", mock.state.notifications.length === 1 && mock.state.notifications[0].title === "t");
}
{
  const output = join(OUT_DIR, "backup.tgz");
  const result = await run(["system", "data-export", "--output", output]);
  check("data export writes the stream", result.code === 0 && readFileSync(output, "utf8") === "FAKE-TGZ-CONTENT", result.stderr.slice(0, 200));
  check("data export omits type when not asked (db+upload only)", mock.state.dataExports[0] === undefined || mock.state.dataExports[0] === null, JSON.stringify(mock.state.dataExports[0]));
  const withType = join(OUT_DIR, "backup-full.tgz");
  await run(["system", "data-export", "--output", withType, "--type", "scripts,config,log"]);
  check("data export forwards the requested types", JSON.stringify(mock.state.dataExports[1]) === '{"type":["scripts","config","log"]}', JSON.stringify(mock.state.dataExports[1]));
}
{
  const result = await run(["system", "retention-cleanup", "--running-days", "30", "--cron-stat-days", "90"]);
  check("retention cleanup demands the CLEAN confirmation", result.code === 2 && /CLEAN/.test(result.stderr), result.stderr.slice(0, 300));
}
{
  const result = await run(["dashboard", "overview", "--json"]);
  const data = parseJson(result.stdout);
  check("dashboard overview returns the totals", data?.total >= 2 && data?.successRate === 80, result.stdout.slice(0, 300));
}
{
  const result = await run(["dashboard", "failures", "--json"]);
  check("dashboard reads the unindexed failures view", result.code === 0 && parseJson(result.stdout) !== undefined, result.stderr.slice(0, 200));
}

process.stdout.write("\ngeneric request and safety\n");
{
  const result = await run(["api", "request", "GET", "/open/configs/config.sh"]);
  check("a retired route is explained with its replacement", result.code === 1 && /\/open\/configs\/detail/.test(result.stderr), result.stderr.slice(0, 300));
}
{
  const result = await run(["api", "request", "GET", "/open/dashboard/successes", "--query", "x=1", "--json"]);
  check("api request reaches unindexed routes", result.code === 0, result.stderr.slice(0, 300));
}
{
  const result = await run(["api", "request", "DELETE", "/open/envs", "--data", "[1]"]);
  check("api request refuses DELETE without --yes", result.code === 2 && /--yes/.test(result.stderr), result.stderr.slice(0, 200));
}
{
  await run(["api", "request", "DELETE", "/open/envs", "--data", "[1]", "--yes"]);
  check("api request runs the confirmed DELETE", requests("DELETE", "/open/envs")?.body?.[0] === 1, JSON.stringify(requests("DELETE", "/open/envs")?.body));
}
{
  const before = mock.state.requests.length;
  const result = await run(["task", "create", "--name", "dry", "--command", "task hello.js", "--schedule", "0 0 * * *", "--dry-run"]);
  const data = parseJson(result.stdout);
  check("dry-run prints the request", data?.dryRun === true && data?.body?.command === "task hello.js", result.stdout.slice(0, 200));
  check("dry-run sends nothing", mock.state.requests.length === before, `${mock.state.requests.length - before} request(s) leaked`);
}
{
  const result = await run(["task", "__no_such_action__"]);
  check("an unknown subcommand names the group", result.code === 2 && /unknown task subcommand/.test(result.stderr), result.stderr.slice(0, 200));
}
{
  const result = await run(["nope", "list"]);
  check("an unknown group points at the help", result.code === 2 && /unknown command group/.test(result.stderr), result.stderr.slice(0, 200));
}
{
  const result = await run(["help"]);
  check("root help lists the groups", /task\s+env\s+sub/.test(result.stdout.replace(/\n/g, " ")) || /scheduled tasks \(crons\)/.test(result.stdout), result.stdout.slice(0, 400));
}
{
  const result = await run(["help", "task"]);
  check("group help resolves", result.stdout.startsWith("task —"), result.stdout.slice(0, 120));
}

// ---------------------------------------------------------------------------

await mock.close();

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write("\nfailures:\n");
  for (const failure of failures) process.stdout.write(`  - ${failure.name}: ${failure.detail ?? ""}\n`);
  process.exit(1);
}
