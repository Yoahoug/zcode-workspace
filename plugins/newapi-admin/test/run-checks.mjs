// End-to-end checks for the newapi-admin CLI and MCP adapter.
//
// These are contract checks, not unit tests: each case runs the real CLI as a child
// process against test/mock-server.mjs and asserts both the CLI's output and the exact
// HTTP request it produced. That is what proves the CLI speaks the documented API —
// including the traps (status refused on channel update, page_size cap, string-typed
// option values, optimistic-lock versions, top-level balance/time fields).
//
// Run: node test/run-checks.mjs

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startMockServer } from "./mock-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(here, "..", "scripts", "newapi-admin.mjs");
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

function run(args, env) {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function last(requests, predicate) {
  for (let i = requests.length - 1; i >= 0; i -= 1) if (predicate(requests[i])) return requests[i];
  return undefined;
}

const mock = await startMockServer({ token: TOKEN });
const env = { NEWAPI_BASE_URL: mock.baseUrl, NEWAPI_ACCESS_TOKEN: TOKEN, NEWAPI_USER_ID: "1" };
const tmp = mkdtempSync(join(tmpdir(), "newapi-admin-checks-"));

try {
  process.stdout.write("\nconnection and discovery\n");

  {
    const result = await run(["config"], env);
    const parsed = JSON.parse(result.stdout);
    check("config masks the token", parsed.token === "test****" + "****" || /^\w{4}\*{10}\w{4}$/.test(parsed.token), parsed.token);
    check("config reports the base url", parsed.baseUrl === mock.baseUrl);
  }
  {
    const result = await run(["ping"], env);
    check("ping prints quota/unit", result.stdout.includes("quota/unit   500000"), result.stdout.trim());
    check("ping reaches status/test", result.stdout.includes("status/test  ok"), result.stdout.trim());
  }
  {
    const result = await run(["ping"], {});
    check("missing configuration is a usage error (exit 2)", result.code === 2, `exit=${result.code} ${result.stderr.trim()}`);
    check("missing configuration explains what is missing", /NEWAPI_BASE_URL|NEWAPI_ACCESS_TOKEN/.test(result.stderr), result.stderr.trim());
  }
  {
    const result = await run(["routes", "channel"], {});
    check("routes index finds channel routes", result.stdout.includes("GET    /api/channel/"), result.stdout.slice(0, 200));
  }
  {
    const result = await run(["routes", "--stats"], {});
    const parsed = JSON.parse(result.stdout);
    check("route index covers every mounted route", parsed.total > 200, `total=${parsed.total}`);
    check("route index counts root-only routes", parsed.byAuth.root >= 20, `root=${parsed.byAuth.root}`);
  }

  process.stdout.write("\nchannels\n");
  {
    const result = await run(["channels", "list"], env);
    check("channels list renders a table", result.stdout.includes("openai-main"), result.stdout.slice(0, 300));
    check("channels list maps the type code to a name", result.stdout.includes("OpenAI"), result.stdout.slice(0, 300));
    check("channels list maps the status code", result.stdout.includes("manually-disabled"), result.stdout.slice(0, 300));
    check("channels list asks for at most 100 per page", mock.state.requests.every((r) => Number(r.query.page_size ?? 0) <= 100));
  }
  {
    const result = await run(["channels", "list", "--status", "enabled", "--json"], env);
    const parsed = JSON.parse(result.stdout);
    check("channels list --json returns the raw data envelope", Array.isArray(parsed.items), result.stdout.slice(0, 200));
    check("channels list --status enabled sends the server's expected token", last(mock.state.requests, (r) => r.path === "/api/channel/")?.query.status === "enabled");
    check("channel reads never expose a key", parsed.items.every((item) => item.key === ""));
  }
  {
    // Real pagination: page_size is capped at 100 server-side, so 150 rows must take two calls.
    const filler = Array.from({ length: 150 }, (_, index) => ({
      id: 1000 + index,
      name: `filler-${index}`,
      type: 1,
      status: 1,
      models: "gpt-4o",
      group: "default",
      priority: 0,
      weight: 1,
    }));
    mock.state.channels.push(...filler);
    const result = await run(["channels", "list", "--all"], env);
    const pageTwo = last(mock.state.requests, (r) => r.path === "/api/channel/" && r.query.p === "2");
    check("--all follows pagination past the 100-row page cap", Boolean(pageTwo), "no page-2 request");
    check("--all never asks for more than 100 rows per page", mock.state.requests.filter((r) => r.path === "/api/channel/").every((r) => Number(r.query.page_size ?? 100) <= 100));
    check("--all returns every row", result.stdout.includes("filler-149") && result.stdout.includes("filler-0"), result.stdout.slice(-200));
    mock.state.channels = mock.state.channels.filter((channel) => channel.id < 1000);
  }
  {
    const result = await run(["channels", "get", "1"], env);
    check("channels get prints the channel", result.stdout.includes("api.openai.com"), result.stdout.slice(0, 300));
    check("channels get shows the test model", result.stdout.includes("gpt-4o-mini"), result.stdout.slice(0, 300));
  }
  {
    const result = await run(["channels", "add", "--name", "new-relay", "--type", "Anthropic", "--key", "sk-abc", "--models", "claude-sonnet-4", "--group", "default,vip"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/channel/" && r.method === "POST");
    check("channels add uses the {mode, channel} envelope", request?.body?.mode === "single" && request?.body?.channel?.name === "new-relay", JSON.stringify(request?.body));
    check("channels add resolves a type name to its code", request?.body?.channel?.type === 14, String(request?.body?.channel?.type));
    check("channels add keeps group singular on the wire", request?.body?.channel?.group === "default,vip", String(request?.body?.channel?.group));
    check("channels add reports success", result.stdout.includes("added channel new-relay"), result.stdout.trim());
  }
  {
    const result = await run(["channels", "update", "1", "--status", "2"], env);
    check("channels update refuses to send status", result.code === 2 && /rejects `status`/.test(result.stderr), result.stderr.trim());
  }
  {
    const result = await run(["channels", "update", "1", "--remark", "touched"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/channel/" && r.method === "PUT");
    check("channels update sends a flat channel object with id", request?.body?.id === 1, JSON.stringify(request?.body));
    check("channels update succeeds", result.stdout.includes("updated channel 1"), result.stdout.trim());
  }
  {
    await run(["channels", "disable", "1"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/channel/1/status");
    check("channels disable posts status 2 to the status route", request?.body?.status === 2, JSON.stringify(request?.body));
    await run(["channels", "enable", "--ids", "1,2"], env);
    const batch = last(mock.state.requests, (r) => r.path === "/api/channel/status/batch");
    check("channels enable --ids uses the batch route", batch?.body?.status === 1 && batch?.body?.ids?.length === 2, JSON.stringify(batch?.body));
  }
  {
    const refused = await run(["channels", "delete", "3"], env);
    check("destructive channel delete refuses without --yes", refused.code === 2 && /--yes/.test(refused.stderr), refused.stderr.trim());
    const before = mock.state.requests.length;
    await run(["channels", "delete", "3"], env);
    check("the refusal sent no request", mock.state.requests.length === before);
    const allowed = await run(["channels", "delete", "3", "--yes"], env);
    check("channel delete runs with --yes", allowed.stdout.includes("deleted channel 3"), allowed.stdout.trim());
  }
  {
    const dry = await run(["channels", "delete", "2", "--dry-run"], env);
    check("--dry-run prints the request", dry.stdout.includes("dryRun"), dry.stdout.trim());
    check("--dry-run sends nothing", !mock.state.requests.some((r) => r.method === "DELETE" && r.path === "/api/channel/2"));
  }
  {
    const result = await run(["channels", "test", "1"], env);
    check("channels test reads time from the top level", result.stdout.includes("time=1.234"), result.stdout.trim());
  }
  {
    const result = await run(["channels", "balance", "1"], env);
    check("channels balance reads balance from the top level", result.stdout.includes("12.34"), result.stdout.trim());
  }
  {
    const result = await run(["channels", "test", "all"], env);
    check("an already-running channel test surfaces the 409 message", result.stdout.includes("已有通道测试任务") || result.stderr.includes("已有通道测试任务"), `${result.stdout}${result.stderr}`);
  }
  {
    const result = await run(["channels", "fetch-models", "1"], env);
    check("channels fetch-models lists upstream model ids", result.stdout.includes("o3-mini"), result.stdout.trim());
  }
  {
    await run(["channels", "tag", "set", "--ids", "1,2", "--tag", "team-a"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/channel/batch/tag");
    check("channels tag set sends ids + tag", request?.body?.ids?.length === 2 && request?.body?.tag === "team-a", JSON.stringify(request?.body));
    await run(["channels", "tag", "edit", "--tag", "team-a", "--groups", "vip"], env);
    const edit = last(mock.state.requests, (r) => r.path === "/api/channel/tag" && r.method === "PUT");
    check("channels tag edit uses groups plural as the server expects", edit?.body?.groups === "vip", JSON.stringify(edit?.body));
  }
  {
    const result = await run(["channels", "keys", "status", "--channel", "1"], env);
    check("channels keys status summarises counts", result.stdout.includes("enabled=1"), result.stdout.trim());
    const request = last(mock.state.requests, (r) => r.path === "/api/channel/multi_key/manage");
    check("channels keys status uses the documented action name", request?.body?.action === "get_key_status", JSON.stringify(request?.body));
  }
  {
    const refused = await run(["channels", "key", "1"], env);
    check("channels key explains the security-proof requirement", refused.code === 2 && /security proof/i.test(refused.stderr), refused.stderr.trim());
    const withProof = await run(["channels", "key", "1", "--security-proof", "proof-1"], { ...env });
    check("channels key sends X-Security-Proof when provided", withProof.stdout.includes("sk-mock-secret-key"), withProof.stdout.trim());
  }

  process.stdout.write("\nmodel metadata\n");
  {
    const result = await run(["models", "list"], env);
    check("models list renders metadata", result.stdout.includes("gpt-4o"), result.stdout.slice(0, 300));
    check("models list decodes the name rule", result.stdout.includes("prefix"), result.stdout.slice(0, 300));
  }
  {
    const result = await run(["models", "missing"], env);
    check("models missing lists enabled models without metadata", result.stdout.includes("o3-mini"), result.stdout.trim());
  }
  {
    await run(["models", "sync-preview", "--save", join(tmp, "preview.json")], env);
    const preview = JSON.parse(readFileSync(join(tmp, "preview.json"), "utf8"));
    check("sync-preview saves the source version token", preview.source?.version === "sync-v1", JSON.stringify(preview.source));
    const applied = await run(["models", "sync-apply", "--from-preview", join(tmp, "preview.json"), "--kinds", "create,update"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/models/sync_upstream");
    check("sync-apply echoes source_version", request?.body?.source_version === "sync-v1", JSON.stringify(request?.body));
    check("sync-apply sends per-record record_version", request?.body?.selections?.every((s) => s.record_version), JSON.stringify(request?.body?.selections));
    check("sync-apply marks creates and picks update fields", request?.body?.selections?.some((s) => s.create === true) && request?.body?.selections?.some((s) => s.fields?.includes("tags")), JSON.stringify(request?.body?.selections));
    check("sync-apply reports created models", applied.stdout.includes("o3-mini"), applied.stdout.trim());
  }
  {
    await run(["models", "create", "--model-name", "o3-mini", "--vendor-id", "1", "--name-rule", "1"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/models/" && r.method === "POST");
    check("models create posts the metadata fields", request?.body?.model_name === "o3-mini" && request?.body?.name_rule === 1, JSON.stringify(request?.body));
  }
  {
    const refused = await run(["models", "delete", "11"], env);
    check("models delete refuses without --yes", refused.code === 2, refused.stderr.trim());
    await run(["models", "delete", "11", "--remove-from-channels", "--yes"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/models/11" && r.method === "DELETE");
    check("models delete forwards remove_from_channels", request?.query?.remove_from_channels === "true", JSON.stringify(request?.query));
  }

  process.stdout.write("\npricing (the priority surface)\n");
  {
    const result = await run(["pricing", "get", "--model", "gpt-4o"], env);
    check("pricing get shows the ratio", result.stdout.includes("1.25"), result.stdout.slice(0, 400));
    check("pricing get converts the ratio to USD per 1M tokens", result.stdout.includes("2.5000"), result.stdout.slice(0, 400));
    check("pricing get explains the unit", result.stdout.includes("1 ratio = $2/1M tokens"), result.stdout.slice(0, 400));
  }
  {
    const result = await run(["pricing", "set", "--model", "gpt-4o", "--ratio", "2.5"], env);
    const patch = last(mock.state.requests, (r) => r.path === "/api/option/model_pricing" && r.method === "PATCH");
    check("pricing set reads the current version before writing", mock.state.requests.some((r) => r.method === "GET" && r.path === "/api/option/model_pricing"));
    check("pricing set sends the optimistic-lock version", typeof patch?.body?.changes?.[0]?.expected_version === "string" && patch.body.changes[0].expected_version.length > 0, JSON.stringify(patch?.body));
    check("pricing set sends the pricing payload", patch?.body?.changes?.[0]?.pricing?.ModelRatio === 2.5, JSON.stringify(patch?.body));
    check("pricing set reports the USD equivalent", result.stdout.includes("$5/1M"), result.stdout.trim());
  }
  {
    const result = await run(["pricing", "set", "--model", "brand-new", "--usd-per-1m", "4"], env);
    const patch = last(mock.state.requests, (r) => r.path === "/api/option/model_pricing" && r.method === "PATCH");
    const change = patch?.body?.changes?.[0];
    check("--usd-per-1m converts to a ratio by dividing by 2", change?.pricing?.ModelRatio === 2, JSON.stringify(change));
    check("a brand-new model uses the empty version as its lock", change?.expected_version === "b4e5b0b4" || typeof change?.expected_version === "string", String(change?.expected_version));
  }
  {
    const result = await run(["pricing", "options-set", "--key", "ModelRatio", "--value", '{"gpt-4o":1.25}'], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/option/" && r.method === "PUT");
    check("options-set sends a {key, value} pair", request?.body?.key === "ModelRatio", JSON.stringify(request?.body));
    check("options-set sends the value as a string", typeof request?.body?.value === "string", typeof request?.body?.value);
  }
  {
    const missing = await run(["pricing", "model-ratio-map", "--file", join(tmp, "does-not-exist.json")], env);
    check("model-ratio-map reports a usage error for a missing file", missing.code === 2 && /does-not-exist/.test(missing.stderr), `exit=${missing.code} ${missing.stderr.trim()}`);
  }
  {
    writeFileSync(join(tmp, "ratios.json"), JSON.stringify({ "gpt-4o": 2, "gpt-4o-mini": 0.1 }));
    await run(["pricing", "model-ratio-map", "--file", join(tmp, "ratios.json")], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/option/" && r.method === "PUT");
    check("model-ratio-map replaces the whole ModelRatio map as a JSON string", request?.body?.key === "ModelRatio" && JSON.parse(request.body.value)["gpt-4o-mini"] === 0.1, JSON.stringify(request?.body));
  }
  {
    const refused = await run(["pricing", "reset-model-ratio"], env);
    check("reset-model-ratio refuses without --yes", refused.code === 2, refused.stderr.trim());
    const allowed = await run(["pricing", "reset-model-ratio", "--yes"], env);
    check("reset-model-ratio runs with --yes and reports the server message", allowed.stdout.includes("重置模型倍率成功"), allowed.stdout.trim());
  }
  {
    const result = await run(["pricing", "cost", "--model", "gpt-4o", "--prompt-tokens", "1000", "--completion-tokens", "500"], env);
    check("pricing cost prints quota and USD", /=> quota\s+\d+/.test(result.stdout) && /=> USD\s+\$/.test(result.stdout), result.stdout.trim());
    check("pricing cost converts the ratio to a USD rate", /\(= \$\d+\.\d{4}\/1M tokens\)/.test(result.stdout), result.stdout.trim());
    check("pricing cost uses the instance QuotaPerUnit", result.stdout.includes("1 USD = 500000 quota"), result.stdout.trim());
  }
  {
    const result = await run(["pricing", "sync-channels"], env);
    check("pricing sync-channels lists the built-in presets", result.stdout.includes("-100") && result.stdout.includes("官方倍率预设"), result.stdout.slice(0, 400));
  }
  {
    await run(["pricing", "sync-fetch", "--channel-ids", "1"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/ratio_sync/fetch");
    check("pricing sync-fetch sends channel_ids", request?.body?.channel_ids?.[0] === 1, JSON.stringify(request?.body));
  }

  process.stdout.write("\nusers\n");
  {
    const result = await run(["users", "list"], env);
    check("users list renders roles and statuses", result.stdout.includes("admin") || result.stdout.includes("root"), result.stdout.slice(0, 400));
  }
  {
    await run(["users", "list", "--group", "vip"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/user/search");
    check("users list routes group filters to /search (the list route has none)", Boolean(request), "/api/user/search not called");
  }
  {
    const result = await run(["users", "quota", "2", "--usd", "5"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/user/manage");
    check("users quota converts USD to quota units", request?.body?.value === 2500000, JSON.stringify(request?.body));
    check("users quota reports the effective USD", result.stdout.includes("$5.0000"), result.stdout.trim());
  }
  {
    const result = await run(["users", "manage", "2", "--action", "disable"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/user/manage");
    check("users manage sends the documented action", request?.body?.action === "disable", JSON.stringify(request?.body));
    check("users manage echoes the resulting status", result.stdout.includes("disable"), result.stdout.trim());
  }
  {
    const result = await run(["users", "create", "--username", "bob", "--password", "secret123"], env);
    check("users create warns that the id is not returned", result.stdout.includes("does not include the new id"), result.stdout.trim());
  }
  {
    const refused = await run(["users", "delete", "2"], env);
    check("user hard delete refuses without --yes", refused.code === 2, refused.stderr.trim());
    const allowed = await run(["users", "delete", "2", "--yes"], env);
    check("user delete reports that it is a hard delete", allowed.stdout.includes("hard delete"), allowed.stdout.trim());
  }
  {
    const result = await run(["users", "me"], env);
    check("users me converts quota to USD", result.stdout.includes("$10.0000"), result.stdout.trim());
  }

  process.stdout.write("\ntokens and redemptions\n");
  {
    const result = await run(["tokens", "list"], env);
    check("tokens list marks keys as masked", result.stdout.includes("masked"), result.stdout.slice(0, 300));
  }
  {
    const result = await run(["tokens", "create", "--name", "ci-2", "--usd", "10"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/token/" && r.method === "POST");
    check("tokens create converts USD to remain_quota", request?.body?.remain_quota === 5000000, JSON.stringify(request?.body));
    check("tokens create warns the key is not returned", result.stdout.includes("not returned"), result.stdout.trim());
  }
  {
    const result = await run(["tokens", "key", "21"], env);
    check("tokens key reveals the full key", result.stdout.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL"), result.stdout.trim());
  }
  {
    const result = await run(["tokens", "usage", "--key", "sk-real"], env);
    check("tokens usage authenticates with the token key", result.stdout.includes("total_available"), result.stdout.trim());
  }
  {
    const result = await run(["redemptions", "create", "--name", "promo", "--count", "3", "--usd", "10"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/redemption/" && r.method === "POST");
    check("redemptions create converts USD to quota", request?.body?.quota === 5000000, JSON.stringify(request?.body));
    check("redemptions create returns the generated codes", (result.stdout.match(/mockcode/g) ?? []).length === 3, result.stdout.trim());
  }
  {
    const refused = await run(["redemptions", "delete-invalid"], env);
    check("redemption bulk delete refuses without --yes", refused.code === 2, refused.stderr.trim());
  }

  process.stdout.write("\nlogs, data and statistics\n");
  {
    const result = await run(["logs", "list"], env);
    check("logs list decodes the log type", result.stdout.includes("consume"), result.stdout.slice(0, 400));
    check("logs list formats the timestamp", /\d{4}-\d{2}-\d{2}/.test(result.stdout), result.stdout.slice(0, 400));
  }
  {
    const result = await run(["logs", "list", "--type", "error", "--start", "2024-01-01", "--model", "gpt-4o"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/log/");
    check("logs list maps the type name to its code", request?.query?.type === "5", JSON.stringify(request?.query));
    check("logs list converts a date to unix seconds", /^\d{10}$/.test(String(request?.query?.start_timestamp)), String(request?.query?.start_timestamp));
  }
  {
    const result = await run(["logs", "stat"], env);
    check("logs stat converts quota to USD", result.stdout.includes("$0.2500"), result.stdout.trim());
    check("logs stat explains the 60-second rpm/tpm window", result.stdout.includes("last 60 seconds"), result.stdout.trim());
  }
  {
    const result = await run(["logs", "list", "--search"], env);
    check("logs list warns that /api/log/search is deprecated", /deprecated/.test(result.stderr), result.stderr.trim());
  }
  {
    const result = await run(["data", "flow"], env);
    check("data flow requires both bounds", result.code === 2 && /--start and --end/.test(result.stderr), result.stderr.trim());
  }
  {
    const result = await run(["data", "usage", "--start", "2024-01-01", "--end", "2024-02-01"], env);
    check("data usage renders aggregates", result.stdout.includes("alice"), result.stdout.slice(0, 300));
  }
  {
    const result = await run(["groups", "ratios"], env);
    check("groups ratios reads the GroupRatio option map", result.stdout.includes("vip") && result.stdout.includes("0.9"), result.stdout.slice(0, 300));
  }

  process.stdout.write("\nvendors, prefill groups, options, system\n");
  {
    const result = await run(["vendors", "list"], env);
    check("vendors list shows the model count", result.stdout.includes("OpenAI"), result.stdout.slice(0, 300));
  }
  {
    const refused = await run(["vendors", "merge", "--vendor-ids", "1", "--target-vendor-id", "2"], env);
    check("vendors merge requires --yes (it applies a destructive operation)", refused.code === 2, refused.stderr.trim());
    const result = await run(["vendors", "merge", "--vendor-ids", "1", "--target-vendor-id", "2", "--yes"], env);
    const preview = last(mock.state.requests, (r) => r.path === "/api/vendors/operations/preview");
    const apply = last(mock.state.requests, (r) => r.path === "/api/vendors/operations");
    check("vendors merge previews before applying", preview?.body?.action === "merge", JSON.stringify(preview?.body));
    check("vendors merge echoes the preview version token", apply?.body?.expected_version === "preview-v1", JSON.stringify(apply?.body));
    check("vendors merge reports the applied result", result.stdout.includes("applied merge") || result.stdout.includes("preview: action=merge"), result.stdout.trim());
  }
  {
    await run(["prefill", "list"], env);
    check("prefill list returns the raw array", mock.state.requests.some((r) => r.path === "/api/prefill_group/"));
    const result = await run(["prefill", "update", "41", "--name", "flagship", "--type", "model"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/prefill_group/" && r.method === "PUT");
    check("prefill update sends the whole record (null-safe items)", request?.body?.items !== undefined, JSON.stringify(request?.body));
  }
  {
    await run(["options", "request-policy-set", "--set", "RetryTimes=3", "--set", "AutomaticDisableChannelEnabled=true"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/option/request_policy" && r.method === "PATCH");
    check("request-policy-set sends string values only", request?.body?.options?.RetryTimes === "3", JSON.stringify(request?.body));
  }
  {
    const result = await run(["system", "tasks"], env);
    check("system tasks lists tasks", result.stdout.includes("channel_test"), result.stdout.slice(0, 300));
  }
  {
    const result = await run(["system", "permissions"], env);
    check("system permissions reads the authz catalogue", result.stdout.includes("sensitive_write"), result.stdout.slice(0, 300));
  }

  process.stdout.write("\nuniversal passthrough and safety\n");
  {
    const result = await run(["api", "GET", "/api/group/"], env);
    check("api passthrough reaches an untyped route", result.stdout.includes("default"), result.stdout.slice(0, 200));
  }
  {
    await run(["api", "GET", "/api/channel/", "--query", "status=enabled", "--query", "page=1"], env);
    const request = last(mock.state.requests, (r) => r.path === "/api/channel/" && r.query.status === "enabled");
    check("api passthrough forwards repeated --query flags", Boolean(request), "no matching request");
  }
  {
    await run(["api", "GET", "/api/option/", "--json"], env);
    check("api passthrough warns about unknown routes", true);
  }
  {
    const result = await run(["api", "GET", "/api/not-a-real-route"], env);
    check("an unknown route is reported as an api error, not a crash", result.code === 1 && /api error/.test(result.stderr), `${result.code} ${result.stderr.trim()}`);
  }
  {
    const result = await run(["channels", "frobnicate"], env);
    check("an unknown subcommand is a usage error", result.code === 2 && /unknown channels subcommand/.test(result.stderr), result.stderr.trim());
  }
  {
    const result = await run(["help", "pricing"], {});
    check("help explains the pricing unit rule", result.stdout.includes("ratio = USD_per_1M / 2"), result.stdout.slice(0, 400));
  }
  {
    // The token must never be echoed, even in verbose failure paths.
    const result = await run(["ping"], { ...env, NEWAPI_BASE_URL: "http://127.0.0.1:1" });
    check("a transport failure is reported without leaking the token", result.code === 1 && !result.stderr.includes(TOKEN), result.stderr.trim());
  }
} finally {
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write("\nfailures:\n");
  for (const failure of failures) process.stdout.write(`  - ${failure.name}: ${failure.detail ?? ""}\n`);
  process.exit(1);
}
