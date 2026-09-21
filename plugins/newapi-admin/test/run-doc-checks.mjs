// Documentation drift guard.
//
// The docs in this plugin spell out concrete `newapi-admin ...` invocations. Those are the
// thing a reader copies, so a renamed or removed subcommand silently turns the docs into
// fiction. This walks every command mentioned in SKILL.md, README.md, the reference docs and
// the built-in help, then runs each against the mock server with --dry-run and asserts the
// CLI recognised it (an unrecognised subcommand fails with "unknown ... subcommand").
//
// Run: node test/run-doc-checks.mjs

import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startMockServer } from "./mock-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pluginRoot = join(here, "..");
const CLI = join(pluginRoot, "scripts", "newapi-admin.mjs");
const TOKEN = "test-token";

// subcommand -> the args that make it get past its own argument validation
const ARGS_FOR = {
  get: ["1"],
  search: [],
  update: ["1"],
  delete: ["1"],
  enable: ["1"],
  disable: ["1"],
  test: ["1"],
  balance: ["1"],
  copy: ["1"],
  "fetch-models": ["1"],
  "delete-invalid": [],
  delete_any: [],
  create: [],
  list: [],
  redeem: [],
  "topup-complete": [],
  unbind: ["1"],
  "reset-passkey": ["1"],
  "disable-2fa": ["1"],
  artifacts: ["t1"],
  me: [],
  self: [],
  "self-stat": [],
  stat: [],
  current: [],
  task: ["t1"],
  instances: [],
  perf: [],
  gc: [],
  "log-files": [],
  "affinity-cache": [],
  missions: [],
  sync: ["1"],
  fetch: ["1"],
};
const DEFAULT_ARGS = {
  channels: [],
  models: [],
  pricing: [],
  users: [],
  tokens: [],
  redemptions: [],
  groups: [],
  vendors: [],
  prefill: [],
  options: [],
  system: [],
  tasks: [],
  audit: [],
  data: [],
  logs: [],
};

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failures.push({ name, detail });
    process.stdout.write(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}\n`);
  }
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { env: { ...process.env, ...env }, timeout: 20000 }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

// ---------------------------------------------------------------------------
// 1. Collect documented invocations
// ---------------------------------------------------------------------------

const GROUP_IDS = ["channels", "models", "pricing", "users", "tokens", "redemptions", "logs", "data", "groups", "vendors", "prefill", "options", "system", "tasks", "audit", "subscription", "config", "ping", "api", "routes"];

function docFiles() {
  const files = [join(pluginRoot, "README.md"), join(pluginRoot, "skills", "newapi-admin", "SKILL.md")];
  const refDir = join(pluginRoot, "skills", "newapi-admin", "references");
  for (const name of readdirSync(refDir)) if (name.endsWith(".md")) files.push(join(refDir, name));
  return files;
}

const invocations = new Map(); // "group action" -> Set of source files
for (const file of docFiles()) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/newapi-admin\s+([a-z][a-z-]*)\s+([a-z][a-z0-9-]*)/g)) {
    const [, group, action] = match;
    if (!GROUP_IDS.includes(group)) continue;
    const key = `${group} ${action}`;
    if (!invocations.has(key)) invocations.set(key, new Set());
    invocations.get(key).add(file.replace(`${pluginRoot}/`, ""));
  }
}

process.stdout.write(`documentation drift check (${invocations.size} distinct invocations)\n`);

const mock = await startMockServer({ token: TOKEN });
const env = { NEWAPI_BASE_URL: mock.baseUrl, NEWAPI_ACCESS_TOKEN: TOKEN };

try {
  // -------------------------------------------------------------------------
  // 2. Every documented invocation must be recognised by the dispatcher
  // -------------------------------------------------------------------------
  for (const [key, sources] of [...invocations].sort()) {
    const [group, action] = key.split(" ");
    const args = [group, action, ...(DEFAULT_ARGS[group] ?? []), "--dry-run"];
    const result = await run(args, env);
    const combined = `${result.stdout}${result.stderr}`;
    const unknown = /unknown [a-z-]+ subcommand|unknown command group/.test(combined);
    check(
      `documented: ${key}`,
      !unknown,
      `${[...sources].join(", ")} -> ${combined.split("\n")[0]}`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. Every group named by the root help must be dispatchable
  // -------------------------------------------------------------------------
  const rootHelp = await run(["help"], {});
  const helpGroups = new Set();
  for (const match of rootHelp.stdout.matchAll(/^\s{2}([a-z][a-z-]*)\s+/gm)) helpGroups.add(match[1]);
  for (const match of rootHelp.stdout.matchAll(/\b(channels|models|pricing|users|tokens|redemptions|logs|data|groups|vendors|prefill|options|system|tasks|audit|subscription)\b/g)) {
    helpGroups.add(match[1]);
  }
  for (const group of [...helpGroups].sort()) {
    if (!GROUP_IDS.includes(group)) continue;
    const result = await run([group, "__no_such_action__"], env);
    check(
      `group dispatchable: ${group}`,
      !/unknown command group/.test(`${result.stdout}${result.stderr}`),
      `${result.stdout}${result.stderr}`.split("\n")[0],
    );
  }

  // -------------------------------------------------------------------------
  // 4. Every help topic the root help advertises must resolve to itself
  // -------------------------------------------------------------------------
  const topicsBlock = rootHelp.stdout.match(/\n  topics: ([\s\S]*?)\n\n/);
  check("root help advertises its topics", Boolean(topicsBlock), "no `topics:` line in root help");
  const topics = new Set(topicsBlock ? topicsBlock[1].match(/[a-z][a-z-]+/g) : null);
  check("root help lists at least 15 topics", topics.size >= 15, `found ${topics.size}`);
  for (const topic of [...topics].sort()) {
    const result = await run(["help", topic], {});
    const head = result.stdout.trimStart();
    check(
      `help topic resolves: ${topic}`,
      head.startsWith(`${topic} `) || head.startsWith(`${topic}\n`),
      head.slice(0, 120),
    );
  }
  const bogus = await run(["help", "__no_such_topic__"], {});
  check(
    "an unknown help topic names the valid ones",
    /unknown help topic/.test(bogus.stdout) && bogus.stdout.includes("available help topics"),
    bogus.stdout.slice(0, 80),
  );

  // -------------------------------------------------------------------------
  // 5. Reference topics advertised by the MCP server must have a file
  // -------------------------------------------------------------------------
  const serverSource = readFileSync(join(pluginRoot, "server", "index.mjs"), "utf8");
  const block = serverSource.match(/const REFERENCE_TOPICS = \{([\s\S]*?)\n\};/);
  check("server declares reference topics", Boolean(block), "REFERENCE_TOPICS not found");
  if (block) {
    const refDir = join(pluginRoot, "skills", "newapi-admin", "references");
    const available = new Set(readdirSync(refDir).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)));
    for (const match of block[1].matchAll(/^\s*"?([a-z-]+)"?:\s*"/gm)) {
      check(`reference topic has a file: ${match[1]}`, available.has(match[1]), "no matching .md in references/");
    }
  }
} finally {
  await mock.close();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write("\nfailures:\n");
  for (const failure of failures) process.stdout.write(`  - ${failure.name}: ${failure.detail}\n`);
  process.exit(1);
}
