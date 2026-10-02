// A mock Qinglong panel, faithful to the contracts documented in
// skills/qinglong-admin/references/. Used by test/run-checks.mjs to verify that the CLI and
// MCP server emit the request shapes the real panel expects, and to let a reader see the
// envelope/auth/scope rules in runnable form.
//
// Fidelity that matters (each of these is a trap the client must respect):
//   * every answer is {code, data}; failures are business codes (400/401/403/410/500)
//     delivered with HTTP 200 for route-level errors
//   * the retired routes GET /open/{configs,scripts,logs}/:file answer code 410
//   * task update replaces the whole record: command + schedule are mandatory
//   * env create takes an OBJECT ARRAY; env update needs id + name + value; names are validated
//   * dependency filters take ENUM NAMES (nodejs/python3/linux) while create bodies take NUMBERS
//   * log reads are byte-addressed with offset/nextOffset/total/truncated and a 1 MiB cap
//   * scopes are enforced: a token without the route's scope gets code 403
//   * PUT /open/system/command-run and GET /open/system/log answer with text, not JSON
//   * PUT /open/system/data/export omits scripts/config/log unless type is passed

import { createServer } from "node:http";

const PANEL_VERSION = "2.20.0-1";

export function startMockServer({ port = 0, token = "test-token", narrowToken = "narrow-token" } = {}) {
  const allScopes = ["crons", "subscriptions", "envs", "scripts", "configs", "logs", "dependencies", "system", "dashboard", "apps", "user"];
  const state = {
    requests: [],
    tokens: new Map([
      [token, { scopes: allScopes, kind: "access" }],
      [narrowToken, { scopes: ["crons"], kind: "access" }],
    ]),
    issued: 0,
    apps: [{ id: 1, name: "admin-cli", scopes: ["crons", "envs"] }],
    appCredentials: { "test-client": "test-secret" },
    tasks: [
      { id: 1, name: "hello 测试", command: "task hello.js", schedule: "0 9 * * *", isDisabled: 0, status: "waiting", pid: null, last_running_time: 1759300000, last_execution_time: 1759300000, log_path: "hello", log_name: "", labels: ["demo"], sub_id: null },
      { id: 2, name: "daily report", command: "task report.js", schedule: "30 8 * * *", isDisabled: 1, status: "disabled", pid: null, last_running_time: 0, last_execution_time: 0, log_path: "report", log_name: "", labels: [], sub_id: null },
    ],
    taskLogs: new Map([
      [1, "hello world\nrun done exit 0\n"],
      [2, ""],
    ]),
    instances: new Map([
      [1, [{ instanceId: "i-1001", status: "completed", startedAt: 1759300000, endedAt: 1759300002, elapsed: 2 }]],
    ]),
    envs: [
      { id: 1, name: "EXAMPLE_KEY", value: "demo", remarks: "示例", labels: ["demo"] },
      { id: 2, name: "DISABLED_KEY", value: "off", remarks: "", isDisabled: 1 },
    ],
    subscriptions: [{ id: 1, name: "demo repo", alias: "demo", type: "public-repo", url: "https://example.com/repo.git", schedule: "0 0 * * *", schedule_type: "crontab" }],
    subscriptionLogs: new Map([[1, "cloned repo at 2026-10-01\n"]]),
    dependencies: [
      { id: 1, name: "axios", type: 0, status: 1, remark: "" },
      { id: 2, name: "requests", type: 1, status: 2, remark: "install failed" },
    ],
    scripts: [
      { path: "", filename: "hello.js", size: 42, mtime: 1759300000 },
      { path: "folder", filename: "nested.js", size: 10, mtime: 1759300000 },
    ],
    scriptContents: new Map([["hello.js", "console.log('hello world')\n"]]),
    logs: [
      { path: "", filename: "2026-10-01-09-00-00.log", size: 24 },
      { path: "hello", filename: "2026-10-01-09-00-00.log", size: 24 },
    ],
    logContents: new Map([
      ["hello/2026-10-01-09-00-00.log", "hello world\nrun done exit 0\n"],
      ["/2026-10-01-09-00-00.log", "panel boot ok\n"],
    ]),
    configs: [
      { title: "config.sh", value: "config.sh" },
      { title: "extra.sh", value: "extra.sh" },
    ],
    configContents: new Map([["config.sh", "# config\n"]]),
    systemConfig: { logRemoveFrequency: 7, cronConcurrency: 3, timezone: "Asia/Shanghai", lang: "zh" },
    runRequests: [],
    systemLog: "2026-10-01 09:00:00 panel ready\n",
    dataExports: [],
    notifications: [],
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
      const result = route(record, state, { token, narrowToken });
      if (result.raw) {
        res.writeHead(result.status ?? 200, result.headers ?? {});
        res.end(result.raw);
        return;
      }
      res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        token,
        narrowToken,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Envelope helpers — the panel answers business outcomes inside the body.
// ---------------------------------------------------------------------------

const ok = (data, message) => ({ body: { code: 200, ...(message === undefined ? {} : { message }), ...(data === undefined ? {} : { data }) } });
const fail = (code, message) => ({ body: { code, message } });

const SCOPES_BY_PREFIX = [
  ["/open/crons", "crons"],
  ["/open/subscriptions", "subscriptions"],
  ["/open/envs", "envs"],
  ["/open/scripts", "scripts"],
  ["/open/configs", "configs"],
  ["/open/logs", "logs"],
  ["/open/dependencies", "dependencies"],
  ["/open/system", "system"],
  ["/open/update", "system"],
  ["/open/dashboard", "dashboard"],
  ["/open/apps", "apps"],
  ["/open/user", "user"],
];

function scopeFor(path) {
  // /open/health and /open/auth/token need no scope.
  for (const [prefix, scope] of SCOPES_BY_PREFIX) if (path === prefix || path.startsWith(`${prefix}/`)) return scope;
  return null;
}

function authenticate(state, headers) {
  const header = String(headers.authorization ?? "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return { error: fail(401, "No authorization token was found") };
  const entry = state.tokens.get(match[1].trim());
  if (!entry) return { error: fail(401, "No authorization token was found") };
  return { scopes: entry.scopes };
}

function isRetired(path) {
  // GET /open/{configs,scripts,logs}/<something> where <something> is not one of the live
  // sub-routes. These answer business code 410 pointing at /detail.
  const retired = [
    [/^\/open\/configs\/(?!samples$|files$|detail$|save$)/, "GET /open/configs/detail?path=<file>"],
    [/^\/open\/scripts\/(?!detail$|download$|run$|stop$|rename$)/, "GET /open/scripts/detail?file=<file>"],
    [/^\/open\/logs\/(?!detail$|download$)/, "GET /open/logs/detail?file=<file>"],
  ];
  for (const [pattern, replacement] of retired) if (pattern.test(path)) return replacement;
  return undefined;
}

function paginate(items, query) {
  const page = Math.max(Number(query.page ?? 1) || 1, 1);
  const size = Math.min(Number(query.size ?? query.page_size ?? 20) || 20, 100);
  return items.slice((page - 1) * size, page * size);
}

function findTask(state, id) {
  return state.tasks.find((task) => task.id === Number(id));
}

function logReply(state, key, query) {
  const full = Buffer.from(state.logContents.get(key) ?? state.taskLogs.get(key) ?? "", "utf8");
  const limit = Math.min(Math.max(Number(query.limit ?? 262144) || 262144, 1), 1048576);
  const hasOffset = query.offset !== undefined && query.offset !== "";
  const tail = query.tail === "true" || (!hasOffset && query.tail !== "false");
  let offset = hasOffset ? Math.max(Number(query.offset) || 0, 0) : tail ? Math.max(full.length - limit, 0) : 0;
  const slice = full.subarray(offset, Math.min(offset + limit, full.length));
  const nextOffset = offset + slice.length;
  return {
    ...ok(slice.toString("utf8")),
    extras: { offset, nextOffset, total: full.length, truncated: nextOffset < full.length, logStatus: "completed" },
  };
}

const withExtras = (result) => ({ body: { ...result.body, ...(result.extras ?? {}) } });

function route(record, state, { token, narrowToken }) {
  const { method, path, query, body, headers } = record;

  // --- token exchange (no auth) --------------------------------------------
  if (path === "/open/auth/token" && method === "GET") {
    const valid = state.appCredentials[query.client_id] === query.client_secret;
    if (!valid) return fail(401, "invalid client credentials");
    state.issued += 1;
    const issued = `issued-token-${state.issued}`;
    state.tokens.set(issued, { scopes: ["crons", "subscriptions", "envs", "scripts", "configs", "logs", "dependencies", "system", "dashboard", "apps", "user"], kind: "issued" });
    return ok({ token: issued, token_type: "Bearer", expiration: Math.floor(Date.now() / 1000) + 30 * 86400 });
  }

  if (path === "/open/health" && method === "GET") {
    return ok({ ok: true, version: PANEL_VERSION });
  }

  const auth = authenticate(state, headers);
  if (auth.error) return auth.error;
  const scope = scopeFor(path);
  if (scope && !auth.scopes.includes(scope)) {
    return fail(403, `无权限：需要 ${scope} 权限`);
  }

  // --- retired routes ------------------------------------------------------
  if (method === "GET") {
    const replacement = isRetired(path);
    if (replacement) return fail(410, `接口已下线，请使用 ${replacement}`);
  }

  // --- crons ---------------------------------------------------------------
  if (path === "/open/crons" && method === "GET") {
    const search = query.searchValue;
    const rows = search
      ? state.tasks.filter((task) => String(task.name ?? "").includes(search) || String(task.command ?? "").includes(search))
      : state.tasks;
    return ok(paginate(rows, query));
  }
  if (path === "/open/crons" && method === "POST") {
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, '"value" must be of type object');
    if (!body.command) return fail(400, '"command" is required');
    if (!body.schedule) return fail(400, '"schedule" is required');
    const id = Math.max(...state.tasks.map((task) => task.id)) + 1;
    state.tasks.push({ id, name: body.name ?? "", command: body.command, schedule: body.schedule, isDisabled: 0, status: "waiting", labels: body.labels ?? [], ...body, id });
    return ok({ id });
  }
  if (path === "/open/crons" && method === "PUT") {
    if (!body || typeof body !== "object") return fail(400, '"value" must be of type object');
    if (body.id === undefined) return fail(400, '"id" is required');
    if (!body.command) return fail(400, '"command" is required');
    if (!body.schedule) return fail(400, '"schedule" is required');
    const task = findTask(state, body.id);
    if (!task) return fail(400, `task ${body.id} not found`);
    Object.assign(task, body, { id: task.id });
    return ok(undefined, "更新成功");
  }
  if (path === "/open/crons" && method === "DELETE") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    state.tasks = state.tasks.filter((task) => !body.includes(task.id));
    return ok(undefined, "删除成功");
  }
  if (/^\/open\/crons\/\d+$/.test(path) && method === "GET") {
    const task = findTask(state, path.split("/").pop());
    return task ? ok(task) : fail(400, "task not found");
  }
  if (/^\/open\/crons\/\d+\/instances$/.test(path) && method === "GET") {
    const id = Number(path.split("/")[3]);
    return ok(state.instances.get(id) ?? []);
  }
  if (/^\/open\/crons\/\d+\/instances\/[^/]+\/stop$/.test(path) && method === "POST") {
    return ok(undefined, "停止成功");
  }
  if (/^\/open\/crons\/\d+\/logs$/.test(path) && method === "GET") {
    const id = Number(path.split("/")[3]);
    return ok([{ filename: `${id}.log`, path: state.tasks.find((task) => task.id === id)?.log_path ?? "" }]);
  }
  if (/^\/open\/crons\/\d+\/log$/.test(path) && method === "GET") {
    const id = Number(path.split("/")[3]);
    return withExtras(logReply(state, id, query));
  }
  if (path === "/open/crons/run" && method === "PUT") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    state.runRequests.push({ kind: "task", ids: body });
    return ok({ accepted: true, ids: body }, "已提交运行请求");
  }
  if (path === "/open/crons/stop" && method === "PUT") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    return ok({ accepted: true, ids: body });
  }
  if (/^\/open\/crons\/(enable|disable|pin|unpin|labels)$/.test(path) && ["PUT", "POST", "DELETE"].includes(method)) {
    if (path.endsWith("/labels")) {
      if (!Array.isArray(body?.ids) || !Array.isArray(body?.labels)) return fail(400, '"ids" and "labels" are required');
      return ok(undefined, "操作成功");
    }
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    for (const id of body) {
      const task = findTask(state, id);
      if (task && path.endsWith("/disable")) task.isDisabled = 1;
      if (task && path.endsWith("/enable")) task.isDisabled = 0;
    }
    return ok(undefined, "操作成功");
  }

  // --- envs ----------------------------------------------------------------
  if (path === "/open/envs" && method === "GET") {
    const search = query.searchValue;
    const rows = search ? state.envs.filter((env) => String(env.name).includes(search)) : state.envs;
    return ok(rows);
  }
  if (path === "/open/envs" && method === "POST") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    for (const entry of body) {
      if (!entry?.name || entry?.value === undefined) return fail(400, '"name" and "value" are required');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) return fail(400, `"name" must start with a letter or underscore: ${entry.name}`);
    }
    const created = body.map((entry) => {
      const id = Math.max(...state.envs.map((env) => env.id)) + 1;
      const row = { id, ...entry };
      state.envs.push(row);
      return row;
    });
    return ok(created, "创建成功");
  }
  if (path === "/open/envs" && method === "PUT") {
    if (!body || typeof body !== "object") return fail(400, '"value" must be of type object');
    if (body.id === undefined) return fail(400, '"id" is required');
    if (!body.name) return fail(400, '"name" is required');
    if (body.value === undefined) return fail(400, '"value" is required');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.name)) return fail(400, `"name" must start with a letter or underscore: ${body.name}`);
    const env = state.envs.find((row) => row.id === Number(body.id));
    if (!env) return fail(400, "env not found");
    Object.assign(env, body, { id: env.id });
    return ok(undefined, "更新成功");
  }
  if (path === "/open/envs" && method === "DELETE") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    state.envs = state.envs.filter((env) => !body.includes(env.id));
    return ok(undefined, "删除成功");
  }
  if (/^\/open\/envs\/\d+$/.test(path) && method === "GET") {
    const env = state.envs.find((row) => row.id === Number(path.split("/").pop()));
    return env ? ok(env) : fail(400, "env not found");
  }
  if (/^\/open\/envs\/(enable|disable|pin|unpin)$/.test(path) && method === "PUT") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    return ok(undefined, "操作成功");
  }
  if (path === "/open/envs/name" && method === "PUT") {
    if (!Array.isArray(body?.ids) || !body?.name) return fail(400, '"ids" and "name" are required');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.name)) return fail(400, `"name" must start with a letter or underscore: ${body.name}`);
    for (const id of body.ids) {
      const env = state.envs.find((row) => row.id === Number(id));
      if (env) env.name = body.name;
    }
    return ok(undefined, "更新成功");
  }
  if (/^\/open\/envs\/\d+\/move$/.test(path) && method === "PUT") {
    if (body?.fromIndex === undefined || body?.toIndex === undefined) return fail(400, '"fromIndex" and "toIndex" are required');
    return ok(undefined, "移动成功");
  }
  if (path === "/open/envs/labels" && (method === "POST" || method === "DELETE")) {
    if (!Array.isArray(body?.ids) || !Array.isArray(body?.labels)) return fail(400, '"ids" and "labels" are required');
    return ok(undefined, "操作成功");
  }
  if (path === "/open/envs/upload" && method === "POST") {
    return fail(415, "multipart body expected in the real panel");
  }

  // --- subscriptions -------------------------------------------------------
  if (path === "/open/subscriptions" && method === "GET") {
    const rows = query.searchValue
      ? state.subscriptions.filter((sub) => `${sub.name} ${sub.alias} ${sub.url}`.includes(query.searchValue))
      : state.subscriptions;
    return ok(rows);
  }
  if (path === "/open/subscriptions" && method === "POST") {
    for (const required of ["type", "url", "alias", "schedule_type"]) {
      if (!body?.[required]) return fail(400, `"${required}" is required`);
    }
    const id = Math.max(...state.subscriptions.map((sub) => sub.id)) + 1;
    state.subscriptions.push({ id, name: body.name ?? body.alias, ...body, id });
    return ok({ id });
  }
  if (path === "/open/subscriptions" && method === "PUT") {
    for (const required of ["id", "type", "url", "alias"]) {
      if (!body?.[required]) return fail(400, `"${required}" is required`);
    }
    const sub = state.subscriptions.find((row) => row.id === Number(body.id));
    if (!sub) return fail(400, "subscription not found");
    Object.assign(sub, body, { id: sub.id });
    return ok(undefined, "更新成功");
  }
  if (path === "/open/subscriptions" && method === "DELETE") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    state.subscriptions = state.subscriptions.filter((sub) => !body.includes(sub.id));
    return ok(undefined, "删除成功");
  }
  if (/^\/open\/subscriptions\/\d+$/.test(path) && method === "GET") {
    const sub = state.subscriptions.find((row) => row.id === Number(path.split("/").pop()));
    return sub ? ok(sub) : fail(400, "subscription not found");
  }
  if (/^\/open\/subscriptions\/\d+\/log$/.test(path) && method === "GET") {
    const id = Number(path.split("/")[3]);
    return withExtras(logReply(state, `sub:${id}`, query));
  }
  if (/^\/open\/subscriptions\/\d+\/logs$/.test(path) && method === "GET") {
    return ok([{ filename: "pull.log", path: "" }]);
  }
  if (path === "/open/subscriptions/run" && method === "PUT") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    state.runRequests.push({ kind: "subscription", ids: body });
    return ok({ accepted: true, ids: body });
  }
  if (/^\/open\/subscriptions\/(stop|enable|disable)$/.test(path) && method === "PUT") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    return ok(undefined, "操作成功");
  }

  // --- dependencies --------------------------------------------------------
  if (path === "/open/dependencies" && method === "GET") {
    if (query.type !== undefined && !["nodejs", "python3", "linux"].includes(query.type)) {
      return fail(400, `"type" must be one of [nodejs, python3, linux]`);
    }
    let rows = state.dependencies;
    if (query.type) rows = rows.filter((dep) => dep.type === { nodejs: 0, python3: 1, linux: 2 }[query.type]);
    if (query.status) {
      const wanted = String(query.status).split(",").map(Number);
      rows = rows.filter((dep) => wanted.includes(dep.status));
    }
    if (query.searchValue) rows = rows.filter((dep) => String(dep.name).includes(query.searchValue));
    return ok(rows);
  }
  if (path === "/open/dependencies" && method === "POST") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    for (const entry of body) {
      if (!entry?.name || entry.type === undefined) return fail(400, '"name" and "type" are required');
      if (![0, 1, 2].includes(entry.type)) return fail(400, '"type" must be a number: 0 Node / 1 Python3 / 2 Linux');
    }
    const created = body.map((entry) => {
      const id = Math.max(...state.dependencies.map((dep) => dep.id)) + 1;
      const row = { id, name: entry.name, type: entry.type, status: 6, remark: entry.remark ?? "" };
      state.dependencies.push(row);
      return row;
    });
    return ok(created, "安装请求已提交");
  }
  if (/^\/open\/dependencies\/\d+$/.test(path) && method === "GET") {
    const dep = state.dependencies.find((row) => row.id === Number(path.split("/").pop()));
    return dep ? ok(dep) : fail(400, "dependency not found");
  }
  if (path === "/open/dependencies/force" && method === "DELETE") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    return ok(undefined, "强制删除成功");
  }
  if (path === "/open/dependencies" && method === "DELETE") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    state.dependencies = state.dependencies.filter((dep) => !body.includes(dep.id));
    return ok(undefined, "删除成功");
  }
  if (/^\/open\/dependencies\/(reinstall|cancel)$/.test(path) && method === "PUT") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    return ok(undefined, "操作成功");
  }

  // --- scripts -------------------------------------------------------------
  if (path === "/open/scripts" && method === "GET") {
    const dir = query.path ?? "";
    return ok(state.scripts.filter((script) => script.path === dir));
  }
  if (path === "/open/scripts/detail" && method === "GET") {
    if (!query.file) return fail(400, '"file" is required');
    return ok(state.scriptContents.get(query.file) ?? "");
  }
  if (path === "/open/scripts/run" && method === "PUT") {
    if (!body?.filename) return fail(400, '"filename" is required');
    state.runRequests.push({ kind: body.content === undefined ? "script-empty" : "script-swap", filename: body.filename });
    return ok(undefined, "已提交调试运行");
  }
  if (path === "/open/scripts/stop" && method === "PUT") {
    if (!body?.filename) return fail(400, '"filename" is required');
    return ok(undefined, "停止成功");
  }
  if (path === "/open/scripts/rename" && method === "PUT") {
    if (!body?.filename || !body?.newFilename) return fail(400, '"filename" and "newFilename" are required');
    return ok(undefined, "重命名成功");
  }
  if (path === "/open/scripts" && method === "PUT") {
    if (!body?.filename || body?.content === undefined) return fail(400, '"filename" and "content" are required');
    state.scriptContents.set(body.filename, body.content);
    return ok(undefined, "保存成功");
  }
  if (path === "/open/scripts" && method === "DELETE") {
    if (!body?.filename) return fail(400, '"filename" is required');
    state.scriptContents.delete(body.filename);
    return ok(undefined, "删除成功");
  }

  // --- configs -------------------------------------------------------------
  if (path === "/open/configs/files" && method === "GET") {
    return ok(state.configs);
  }
  if (path === "/open/configs/samples" && method === "GET") {
    return ok([{ title: "config.sh", value: "config.sh" }]);
  }
  if (path === "/open/configs/detail" && method === "GET") {
    if (!query.path) return fail(400, '"path" is required');
    return ok(state.configContents.get(query.path) ?? "");
  }
  if (path === "/open/configs/save" && method === "POST") {
    if (!body?.name || body?.content === undefined) return fail(400, '"name" and "content" are required');
    state.configContents.set(body.name, body.content);
    return ok(undefined, "保存成功");
  }

  // --- logs ----------------------------------------------------------------
  if (path === "/open/logs" && method === "GET") {
    return ok(state.logs);
  }
  if (path === "/open/logs/detail" && method === "GET") {
    if (!query.file) return fail(400, '"file" is required');
    const key = `${query.path ?? ""}/${query.file}`;
    if (!state.logContents.has(key)) return fail(400, "log file not found");
    return withExtras(logReply(state, key, query));
  }
  if (path === "/open/logs/download" && method === "POST") {
    if (!body?.filename) return fail(400, '"filename" is required (the body field is filename, not file)');
    const key = `${body.path ?? ""}/${body.filename}`;
    const content = state.logContents.get(key) ?? "";
    return { status: 200, headers: { "Content-Type": "application/octet-stream" }, raw: Buffer.from(content, "utf8") };
  }
  if (path === "/open/scripts/download" && method === "POST") {
    if (!body?.filename) return fail(400, '"filename" is required');
    return { status: 200, headers: { "Content-Type": "application/octet-stream" }, raw: Buffer.from(state.scriptContents.get(body.filename) ?? "", "utf8") };
  }

  // --- system --------------------------------------------------------------
  if (path === "/open/system" && method === "GET") {
    return ok({ isInitialized: true, version: PANEL_VERSION, branch: "debian", publishTime: 1759300000, changeLog: "", changeLogLink: "" });
  }
  if (path === "/open/system/config" && method === "GET") {
    return ok(state.systemConfig);
  }
  if (/^\/open\/system\/config\/(log-remove-frequency|cron-concurrency|dependence-proxy|node-mirror|python-mirror|linux-mirror|timezone|lang|panel-title|global-ssh-key)$/.test(path) && method === "PUT") {
    const key = path.split("/").pop();
    const fieldMap = {
      "log-remove-frequency": "logRemoveFrequency",
      "cron-concurrency": "cronConcurrency",
      "dependence-proxy": "dependenceProxy",
      "node-mirror": "nodeMirror",
      "python-mirror": "pythonMirror",
      "linux-mirror": "linuxMirror",
      timezone: "timezone",
      lang: "lang",
      "panel-title": "panelTitle",
      "global-ssh-key": "globalSshKey",
    };
    const field = fieldMap[key];
    if (!(field in (body ?? {}))) return fail(400, `"${field}" is required`);
    state.systemConfig[key] = body[field];
    return ok(undefined, "保存成功");
  }
  if (path === "/open/system/notify" && method === "PUT") {
    if (!body?.title || !body?.content) return fail(400, '"title" and "content" are required');
    state.notifications.push(body);
    return ok(undefined, "发送成功");
  }
  if (path === "/open/system/update-check" && method === "PUT") {
    return ok({ hasUpdate: false, version: PANEL_VERSION });
  }
  if (path === "/open/system/reload" && method === "PUT") {
    return ok(undefined, "重载成功");
  }
  if (path === "/open/system/command-run" && method === "PUT") {
    if (!body?.command) return fail(400, '"command" is required');
    return {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "QL-Task-Pid": "4242", "QL-Task-Log": "tmp/command.log" },
      raw: Buffer.from(`$ ${body.command}\ncommand output line\n`, "utf8"),
    };
  }
  if (path === "/open/system/command-stop" && method === "PUT") {
    if (!body?.command && body?.pid === undefined) return fail(400, '"command" or "pid" is required');
    return ok(undefined, "停止成功");
  }
  if (path === "/open/system/log" && method === "GET") {
    return {
      status: 200,
      headers: { "Content-Type": "text/plain", "X-QL-Log-Total": String(Buffer.byteLength(state.systemLog)), "X-QL-Log-Truncated": "false" },
      raw: Buffer.from(state.systemLog, "utf8"),
    };
  }
  if (path === "/open/system/data/export" && method === "PUT") {
    state.dataExports.push(body);
    return { status: 200, headers: { "Content-Type": "application/octet-stream" }, raw: Buffer.from("FAKE-TGZ-CONTENT", "utf8") };
  }
  if (path === "/open/system/storage-retention/config" && method === "PUT") {
    if (body?.runningInstanceRetentionDays === undefined || body?.cronStatRetentionDays === undefined) {
      return fail(400, "runningInstanceRetentionDays / cronStatRetentionDays are required");
    }
    return ok(undefined, "保存成功");
  }
  if (path === "/open/system/storage-retention/preview" && method === "POST") {
    return ok({ runningInstances: 1, cronStats: 30, dependenceCacheTypes: body?.dependenceCacheTypes ?? [] });
  }
  if (path === "/open/system/storage-retention/cleanup" && method === "POST") {
    if (body?.confirmation !== "CLEAN") return fail(400, '"confirmation" must be CLEAN');
    return ok({ removed: 3 });
  }
  if (path === "/open/system/client-ip/config" && method === "GET") {
    return ok({ trustProxy: "" });
  }
  if (path === "/open/system/client-ip/config" && method === "PUT") {
    return ok(undefined, "保存成功");
  }
  if (path === "/open/system/client-ip/diagnose" && method === "GET") {
    return ok({ clientIp: "127.0.0.1", resolvedFrom: "socket" });
  }
  if (path === "/open/system/auth/reset" && method === "PUT") {
    return ok(undefined, "重置成功");
  }

  // --- dashboard -----------------------------------------------------------
  if (path === "/open/dashboard/overview" && method === "GET") {
    return ok({ total: state.tasks.length, enabled: state.tasks.filter((task) => !task.isDisabled).length, disabled: state.tasks.filter((task) => task.isDisabled).length, todayRunCount: 5, todaySuccessCount: 4, todayFailCount: 1, successRate: 80, avgTime: 1250 });
  }
  if (path === "/open/dashboard/trend" && method === "GET") {
    return ok([{ date: "2026-10-01", success: 4, fail: 1 }]);
  }
  if (path === "/open/dashboard/runtime" && method === "GET") {
    return ok({ running: [{ id: 1, name: "hello 测试", elapsed: 12 }], queued: 0, stale: [] });
  }
  if (["top-time", "top-count", "labels", "system", "successes", "failures"].includes(path.split("/").pop()) && path.startsWith("/open/dashboard/") && method === "GET") {
    return ok([]);
  }
  if (path === "/open/dashboard/record" && method === "POST") {
    return ok(undefined, "记录成功");
  }

  // --- apps ----------------------------------------------------------------
  if (path === "/open/apps" && method === "GET") {
    return ok(state.apps.map((app) => ({ ...app, tokens: [] })));
  }
  if (path === "/open/apps" && method === "POST") {
    if (body?.name && String(body.name).toLowerCase() === "system") return fail(400, '"name" cannot be "system"');
    const id = Math.max(...state.apps.map((app) => app.id)) + 1;
    state.apps.push({ id, name: body?.name ?? "", scopes: body?.scopes ?? [] });
    return ok({ id });
  }
  if (path === "/open/apps" && method === "PUT") {
    if (body?.id === undefined) return fail(400, '"id" is required');
    const app = state.apps.find((row) => row.id === Number(body.id));
    if (!app) return fail(400, "app not found");
    Object.assign(app, body, { id: app.id });
    return ok(undefined, "更新成功");
  }
  if (path === "/open/apps" && method === "DELETE") {
    if (!Array.isArray(body)) return fail(400, '"value" must be an array');
    state.apps = state.apps.filter((app) => !body.includes(app.id));
    return ok(undefined, "删除成功");
  }
  if (/^\/open\/apps\/\d+\/reset-secret$/.test(path) && method === "PUT") {
    return ok({ client_id: "test-client", client_secret: "new-secret" });
  }

  // --- user ----------------------------------------------------------------
  if (path === "/open/user" && method === "GET") {
    return ok({ username: "admin", twoFactor: false });
  }
  if (path === "/open/user/login-log" && method === "GET") {
    return ok([{ ip: "127.0.0.1", time: 1759300000, status: "success" }]);
  }
  if (path === "/open/user/ip-blacklist" && method === "GET") {
    return ok([]);
  }
  if (path === "/open/user/ip-blacklist" && (method === "PUT" || method === "DELETE")) {
    if (!body?.ip) return fail(400, '"ip" is required');
    if (String(body.ip).includes("/")) return fail(400, "CIDR is not supported; pass a single IPv4/IPv6 address");
    return ok(undefined, "操作成功");
  }
  if (path === "/open/user/notification" && method === "GET") {
    return ok({ type: "bark", barkPush: "***" });
  }
  if (path === "/open/user/notification" && method === "PUT") {
    return ok(undefined, "保存成功");
  }

  return fail(404, `not found: ${method} ${path}`);
}
