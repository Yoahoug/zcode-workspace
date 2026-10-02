// Documentation drift guard.
//
// Three things rot silently in a plugin like this, and each is checked here:
//   1. the route index (lib/routes.mjs) versus references/routes.md — both claim 143 routes
//      and must describe exactly the same set, or the CLI and the reference disagree;
//   2. every `qinglong-admin ...` invocation printed in the docs must be recognised by the
//      dispatcher, or a reader copying an example hits "unknown subcommand";
//   3. the tool surface, reference topics and the version number are stated in several files
//      (README, server source, plugin.json, package.json, the marketplace catalog) and must
//      agree before a release.
//
// Run: node test/run-doc-checks.mjs

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startMockServer } from "./mock-server.mjs";
import { ALL_ROUTES } from "../lib/routes.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pluginRoot = join(here, "..");
const CLI = join(pluginRoot, "scripts", "qinglong-admin.mjs");
const REF_DIR = join(pluginRoot, "skills", "qinglong-admin", "references");

const GROUPS = ["status", "routes", "api", "task", "env", "sub", "log", "dep", "script", "configs", "system", "dashboard", "app", "user", "config"];

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
    execFile("node", [CLI, ...args], { env: { ...process.env, ...env }, timeout: 20000 }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

const mock = await startMockServer();
const env = { QL_URL: mock.baseUrl, QL_ACCESS_TOKEN: mock.token, QL_ADMIN_CONFIG: "/nonexistent/config.json" };

try {
  // -------------------------------------------------------------------------
  // 1. references/routes.md and lib/routes.mjs must describe the same 143 routes
  // -------------------------------------------------------------------------
  process.stdout.write("\nroute table parity\n");
  {
    const markdown = readFileSync(join(REF_DIR, "routes.md"), "utf8");
    const pairs = [...markdown.matchAll(/^\|\s*`ql[^`]*`\s*\|\s*([A-Z]+)\s*\|\s*`?(\/[^|\s`]+)`?\s*\|/gm)].map((match) => `${match[1]} ${match[2]}`);
    const documented = new Set(pairs);
    const indexed = new Set(ALL_ROUTES.map((route) => `${route.method} ${route.path}`));
    check("routes.md lists 143 routes", pairs.length === 143, `found ${pairs.length}`);
    check("lib/routes.mjs indexes 143 routes", indexed.size === 143, `found ${indexed.size}`);
    const missingFromIndex = [...documented].filter((pair) => !indexed.has(pair));
    const missingFromDoc = [...indexed].filter((pair) => !documented.has(pair));
    check("every documented route is indexed", missingFromIndex.length === 0, missingFromIndex.slice(0, 5).join(", "));
    check("every indexed route is documented", missingFromDoc.length === 0, missingFromDoc.slice(0, 5).join(", "));
  }

  // -------------------------------------------------------------------------
  // 2. Every documented invocation must be recognised by the dispatcher
  // -------------------------------------------------------------------------
  process.stdout.write("\ndocumented CLI invocations\n");
  const docFiles = [
    join(pluginRoot, "README.md"),
    join(pluginRoot, "skills", "qinglong-admin", "SKILL.md"),
    ...readdirSync(REF_DIR).filter((name) => name.endsWith(".md")).map((name) => join(REF_DIR, name)),
  ];

  const invocations = new Map(); // "group action" -> source files
  const singles = new Map(); // "status" style single-token invocations
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/qinglong-admin(?:\.mjs)?\s+([a-z][a-z-]*)\s+([a-z][a-z0-9-]*)/g)) {
      const [, group, action] = match;
      if (!GROUPS.includes(group)) continue;
      const key = `${group} ${action}`;
      if (!invocations.has(key)) invocations.set(key, new Set());
      invocations.get(key).add(file.replace(`${pluginRoot}/`, ""));
    }
    for (const match of text.matchAll(/qinglong-admin(?:\.mjs)?\s+(status|routes|config)\b/g)) {
      singles.set(match[1], true);
    }
  }

  const UNKNOWN = /unknown command group|unknown [a-z-]+ subcommand/;
  for (const [key, sources] of [...invocations].sort()) {
    const [group, action] = key.split(" ");
    const result = await run([group, action, "--dry-run"], env);
    const combined = `${result.stdout}${result.stderr}`;
    // A recognised-but-under-specified command is fine (it exits with its own usage error);
    // an unrecognised one would say "unknown ... subcommand".
    check(`documented: ${key}`, !UNKNOWN.test(combined), `${[...sources].join(", ")} -> ${combined.split("\n")[0]}`);
  }
  for (const group of [...singles.keys()].sort()) {
    const result = await run([group, "--dry-run"], env);
    const combined = `${result.stdout}${result.stderr}`;
    check(`documented: ${group}`, !UNKNOWN.test(combined), combined.split("\n")[0]);
  }

  // -------------------------------------------------------------------------
  // 3. Every group named by the root help must be dispatchable
  // -------------------------------------------------------------------------
  process.stdout.write("\ndispatch and help\n");
  const rootHelp = await run(["help"], {});
  for (const group of GROUPS) {
    const result = await run([group, "__no_such_action__"], env);
    const combined = `${result.stdout}${result.stderr}`;
    check(`group dispatchable: ${group}`, !/unknown command group/.test(combined), combined.split("\n")[0]);
  }
  {
    const topicsBlock = rootHelp.stdout.match(/groups:\n([\s\S]*?)\n\n/);
    check("root help lists its groups", Boolean(topicsBlock), rootHelp.stdout.slice(0, 200));
    const advertised = new Set(topicsBlock ? topicsBlock[1].match(/^  ([a-z][a-z-]*)\s/gm)?.map((line) => line.trim().split(/\s+/)[0]) ?? [] : []);
    for (const group of [...advertised].sort()) {
      const result = await run(["help", group], {});
      const head = result.stdout.trimStart();
      check(`help topic resolves: ${group}`, head.startsWith(`${group} —`) || head.startsWith(`${group}\n`), head.slice(0, 80));
    }
    const bogus = await run(["help", "__no_such_topic__"], {});
    check("an unknown help topic names the valid ones", /unknown help topic/.test(bogus.stdout) && bogus.stdout.includes("available help topics"), bogus.stdout.slice(0, 120));
  }

  // -------------------------------------------------------------------------
  // 4. Reference topics advertised by the MCP server must have a file
  // -------------------------------------------------------------------------
  process.stdout.write("\nserver surface consistency\n");
  const serverSource = readFileSync(join(pluginRoot, "server", "index.mjs"), "utf8");
  {
    const block = serverSource.match(/const REFERENCE_TOPICS = \{([\s\S]*?)\n\};/);
    check("server declares reference topics", Boolean(block), "REFERENCE_TOPICS not found");
    if (block) {
      const available = new Set(readdirSync(REF_DIR).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)));
      for (const match of block[1].matchAll(/"?([a-z-]+)"?:\s*\{\s*file:\s*"([a-z-]+)"/g)) {
        check(`reference topic has a file: ${match[1]}`, available.has(match[2]), `missing ${match[2]}.md`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. The README tool table must match the server, including the quoted count
  // -------------------------------------------------------------------------
  {
    const toolsBlock = serverSource.match(/const TOOLS = \[([\s\S]*?)\n\];/);
    check("server declares its tools", Boolean(toolsBlock), "TOOLS not found");
    if (toolsBlock) {
      const declared = [...toolsBlock[1].matchAll(/\n\s*name: "([a-z_]+)"/g)].map((match) => match[1]);
      const readme = readFileSync(join(pluginRoot, "README.md"), "utf8");
      const table = readme.slice(readme.indexOf("## MCP 工具"));
      const documented = new Set([...table.matchAll(/`(qinglong_[a-z_]+)`/g)].map((match) => match[1]));
      for (const name of declared) check(`README documents tool: ${name}`, documented.has(name), "missing from the MCP tools table");
      for (const name of documented) check(`documented tool exists: ${name}`, declared.includes(name), "in the README but not in TOOLS");
      const quoted = readme.match(/stdio JSON-RPC，(\d+) 个工具/);
      check(
        `README tool count matches the server: ${quoted ? quoted[1] : "?"} vs ${declared.length}`,
        Boolean(quoted) && Number(quoted[1]) === declared.length,
        `the server exposes ${declared.length} tools`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. The version and description live in several places; they must agree
  // -------------------------------------------------------------------------
  {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
    const cli = readFileSync(CLI, "utf8").match(/^const VERSION = "([^"]+)"/m);
    const server = serverSource.match(/^const SERVER_VERSION = "([^"]+)"/m);
    const catalogPath = join(pluginRoot, "..", ".claude-plugin", "marketplace.json");
    const entry = existsSync(catalogPath)
      ? JSON.parse(readFileSync(catalogPath, "utf8")).plugins?.find((plugin) => plugin.name === manifest.name)
      : undefined;
    check("plugin.json declares a version", Boolean(manifest.version), "missing");
    check(`CLI version matches plugin.json: ${cli?.[1]}`, cli?.[1] === manifest.version, `plugin.json says ${manifest.version}`);
    check(`server version matches plugin.json: ${server?.[1]}`, server?.[1] === manifest.version, `plugin.json says ${manifest.version}`);
    check(`package.json version matches plugin.json: ${pkg.version}`, pkg.version === manifest.version, `plugin.json says ${manifest.version}`);
    check("plugin.json declares the MCP server", Boolean(manifest.mcpServers?.["qinglong-admin"]), "missing mcpServers");
    check("plugin.json declares userConfig", Boolean(manifest.userConfig?.panel_url), "missing userConfig.panel_url");
    check(".mcp.json mirrors plugin.json mcpServers", JSON.stringify(mcp.mcpServers) === JSON.stringify(manifest.mcpServers), "the two server blocks differ");
    if (entry) {
      check(`marketplace entry version matches plugin.json: ${entry.version}`, entry.version === manifest.version, `plugin.json says ${manifest.version}`);
      check("marketplace entry description matches plugin.json", entry.description === manifest.description, "the two descriptions differ");
      check("marketplace entry source points at the plugin", entry.source === "./qinglong-admin", String(entry.source));
    } else {
      check("the marketplace entry exists", false, "no qinglong-admin entry in .claude-plugin/marketplace.json");
    }
  }
} finally {
  await mock.close();
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write("\nfailures:\n");
  for (const failure of failures) process.stdout.write(`  - ${failure.name}: ${failure.detail ?? ""}\n`);
  process.exit(1);
}
