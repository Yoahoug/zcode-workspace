#!/usr/bin/env node
/**
 * quark wrapper — 稳定的夸克网盘 CLI 包装器（ZCode 插件专用）。
 *
 * 职责：
 * 1. 首次调用自动把官方 CLI（quark-drive.cjs）安装到固定目录 ~/.zcode-quark/cli/
 *    （凭据 config.json 也落在该目录下，更新插件不影响登录态）。
 * 2. 注入 OPENCLAW_CLI=1，让官方 CLI 通过 openclaw 渠道识别（夸克服务端已授权该渠道）。
 * 3. 透传全部参数与退出码；stdout 为 NDJSON。
 * 4. 提供少量便捷命令：
 *    - ensure-dir --path "项目/xxx" [--parent-fid <FID>]：在 来自ZCode/ 下逐级建目录（幂等），输出目录 FID
 *    - ensure-base：确保 来自ZCode/ 及默认子目录存在，输出各目录 FID 映射
 *    - whoami：等价 get-user-info（登录态探活）
 *
 * 本包装器不含其它夸克业务逻辑。
 * 安装来源：夸克服务端 skill_config 接口（与官方 skill 的 install.sh 相同）。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const BASE_DIR = process.env.QUARK_DRIVE_HOME || path.join(HOME, '.zcode-quark');
const CLI_DIR = path.join(BASE_DIR, 'cli');
const ENTRY = path.join(CLI_DIR, 'scripts', 'quark-drive.cjs');
const CONFIG_API = 'https://open-api-drive.quark.cn/agent/v1/skill_config';
const MIN_NODE_MAJOR = 16;
const BASE_NAME = '来自ZCode';

const EXTRA_COMMANDS = new Set(['ensure-dir', 'ensure-base', 'whoami', 'restore']);

function fail(msg) {
  process.stderr.write(`[quark-wrapper] ${msg}\n`);
  process.exit(1);
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

function fetchJson(url, timeoutMs = 60000) {
  // Node >= 18 自带全局 fetch；不引入任何 npm 依赖
  if (typeof fetch !== 'function') {
    fail('当前 Node.js 版本过低（需要 >= 18，或手动安装官方 CLI 到 ' + CLI_DIR + '）');
  }
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function download(url, dest, timeoutMs = 180000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return buf.length;
  });
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    // PowerShell 5+ 内置 Expand-Archive，Windows 无需额外依赖
    const ps = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ], { stdio: 'ignore' });
    if (ps.status === 0) return;
  }
  const unzip = spawnSync('unzip', ['-qo', zipPath, '-d', destDir], { stdio: 'ignore' });
  if (unzip.error || unzip.status !== 0) {
    if (process.platform !== 'win32' && spawnSync('tar', ['-xf', zipPath, '-C', destDir]).status === 0) return;
    fail(`解压失败：${zipPath} → ${destDir}（Windows 需要 PowerShell 或 unzip）`);
  }
}

/** 官方 CLI 是否可用且能通过 agent 识别。 */
function isInstalled() {
  if (!fs.existsSync(ENTRY)) return false;
  const probe = spawnSync(process.execPath, [ENTRY, 'resolve-agent'], {
    env: { ...process.env, OPENCLAW_CLI: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
  return probe.status === 0 && String(probe.stdout || '').includes('QK_AGENT_ID=');
}

/** 从夸克服务端解析最新 CLI zip 下载地址。返回 {version, url}。 */
async function resolveRemote() {
  const cfg = await fetchJson(`${CONFIG_API}?req_id=${Date.now()}${Math.floor(Math.random() * 1e6)}`);
  const c = (cfg && cfg.data && cfg.data.config) || cfg && cfg.config || cfg && cfg.data || cfg || {};
  const url = String(c.qkPan || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error('skill_config 未返回有效下载地址');
  return { version: String(c.qkPanVersion || 'unknown'), url };
}

async function install({ force = false } = {}) {
  if (!force && isInstalled()) return { installed: false, entry: ENTRY };
  if (nodeMajor() < MIN_NODE_MAJOR) {
    fail(`需要 Node.js >= ${MIN_NODE_MAJOR}，当前 ${process.versions.node}`);
  }
  const { version, url } = await resolveRemote();
  const tmpZip = path.join(BASE_DIR, `cli-${version}.zip`);
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const bytes = await download(url, tmpZip);
  if (!bytes) throw new Error('下载的 zip 为空');
  // 先解到临时目录，成功后整体替换，避免半成品
  const tmpDir = path.join(BASE_DIR, `cli-tmp-${Date.now()}`);
  extractZip(tmpZip, tmpDir);
  const scriptsSrc = findDir(tmpDir, 'scripts');
  if (!scriptsSrc) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('zip 中未找到 scripts 目录');
  }
  // zip 里的 SKILL.md/references 是官方 skill 文档，这里不收编（本插件有自己的文档），只取 CLI
  const finalScripts = path.join(CLI_DIR, 'scripts');
  fs.rmSync(finalScripts, { recursive: true, force: true });
  fs.mkdirSync(CLI_DIR, { recursive: true });
  fs.cpSync(scriptsSrc, finalScripts, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpZip, { force: true });
  if (!isInstalled()) fail('CLI 安装后自检失败（resolve-agent 未通过）');
  return { installed: true, version, entry: ENTRY };
}

function findDir(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === name) return full;
      stack.push(full);
    }
  }
  return null;
}

/* ---------- 便捷命令（运行在官方 CLI 之上） ---------- */

function runCli(args, { capture = false } = {}) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_CLI: '1' },
    timeout: 120000,
  });
  const out = String(res.stdout || '');
  if (!capture) return { code: res.status ?? 1, out };
  let last = null;
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { last = JSON.parse(t); } catch { /* 忽略非 JSON 行 */ }
  }
  return { code: res.status ?? 1, result: last };
}

/** 在 parentFid 下创建单层目录（同名幂等）。返回 fid 或 null。 */
function mkdirOne(name, parentFid) {
  const { code, result } = runCli(
    ['create-folder', '--dir-path', name, '--parent-fid', parentFid],
    { capture: true },
  );
  if (code !== 0 || !result || result.code !== 0 || !result.data || !result.data.fid) {
    fail(`创建目录失败（${name}）：${result ? result.msg : '无输出'}`);
  }
  return result.data.fid;
}

/** 确保来自ZCode 下的相对路径（"a/b/c"）存在，返回最终 FID。 */
function ensureDir(relPath, parentFid) {
  let fid = parentFid;
  for (const seg of relPath.split('/').filter(Boolean)) {
    // create-folder 同名幂等：已存在时返回已有 FID，无需先查询
    fid = mkdirOne(seg, fid);
  }
  return fid;
}

function parseOpts(argv, flags) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const hit = flags.find((f) => a === `--${f}`);
    if (hit) { opts[hit] = argv[++i]; continue; }
    opts._.push(a);
  }
  return opts;
}

/** 便捷命令入口。返回 true 表示已处理。 */
function handleExtra(argv) {
  const cmd = argv[0];
  if (!EXTRA_COMMANDS.has(cmd)) return false;
  const rest = argv.slice(1);

  if (cmd === 'whoami') {
    forward(['get-user-info', ...rest]);
    return true;
  }

  if (cmd === 'ensure-dir') {
    const opts = parseOpts(rest, ['path', 'parent-fid']);
    if (!opts.path) fail('缺少 --path（相对 来自ZCode/ 的路径，如 "项目/demo"）');
    const baseFid = ensureDir(BASE_NAME, '0');
    const fid = ensureDir(opts.path, baseFid);
    process.stdout.write(`${JSON.stringify({
      code: 0, msg: '成功', action: 'ensure-dir', type: 'result',
      data: { baseFid, fid, path: `${BASE_NAME}/${opts.path}` },
    })}\n`);
    return true;
  }

  if (cmd === 'ensure-base') {
    const baseFid = ensureDir(BASE_NAME, '0');
    const map = { baseFid, path: BASE_NAME };
    // 默认子目录：文件/ 与 共享/；项目/ 按需创建
    for (const sub of ['文件', '共享']) {
      map[`${sub}Fid`] = ensureDir(sub, baseFid);
    }
    process.stdout.write(`${JSON.stringify({
      code: 0, msg: '成功', action: 'ensure-base', type: 'result', data: map,
    })}\n`);
    return true;
  }

  if (cmd === 'restore') {
    restore(rest);
    return true;
  }
  return false;
}

/**
 * restore —— 新设备/新仓库的资源补齐：
 * 把 来自ZCode/ 下（默认全部，或 --path 指定的子目录）的云端文件清单与本地台账对齐，
 * 报告本机缺失的文件；--download 时直接下载缺失文件到 --output-dir（默认 ./quark-restored）。
 * 可选 --manifest <清单路径>：只核对清单内列出的文件（name 匹配），适合"仓库声明式资源补齐"。
 */
function restore(argv) {
  const opts = parseOpts(argv, ['path', 'output-dir', 'manifest']);
  const wantDownload = argv.includes('--download');
  const outputDir = opts['output-dir'] || 'quark-restored';
  const manifest = opts.manifest ? loadManifest(opts.manifest) : null;

  // 1. 定位云端目录（默认整棵规范树）
  const baseFid = ensureDir(BASE_NAME, '0');
  let rootFid = baseFid;
  let rootPath = BASE_NAME;
  if (opts.path) {
    rootFid = ensureDir(opts.path, baseFid);
    rootPath = `${BASE_NAME}/${opts.path}`;
  }

  // 2. 拉全量云端清单（browse --all 落 artifact JSONL）
  const { code, result } = runCli(['browse', '--parent-fid', rootFid, '--all'], { capture: true });
  if (code !== 0 || !result || result.code !== 0 || !result.data || !result.data.file_path) {
    fail(`browse 失败：${result ? result.msg : '无输出'}`);
  }
  const cloud = [];
  for (const line of fs.readFileSync(result.data.file_path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    if (row && row.file_type === '1' && row.fid) cloud.push(row);
  }

  // 3. 与本地对齐：台账命中（同 name 且 size 一致）视为本机已有；清单模式下以清单为准
  const local = loadLedgerIndex();
  const missing = [];
  for (const item of cloud) {
    if (manifest && !manifest.has(item.filename)) continue;
    const hit = local.get(item.filename);
    const hasLocal = !!(hit && hit.size === item.size);
    if (!hasLocal) missing.push(item);
  }
  const summary = {
    code: 0, msg: '成功', action: 'restore', type: 'result',
    data: {
      root: rootPath,
      cloudFiles: cloud.length,
      checked: manifest ? manifest.size : cloud.length,
      missing: missing.length,
      files: missing.map((m) => ({ name: m.filename, fid: m.fid, size: m.size })),
      outputDir: wantDownload ? outputDir : undefined,
    },
  };

  // 4. 可选直接下载缺失文件
  if (wantDownload && missing.length) {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const m of missing) {
      const dl = spawnSync(process.execPath, [ENTRY, 'download', '--fid', m.fid, '--output-dir', outputDir], {
        stdio: 'inherit',
        env: { ...process.env, OPENCLAW_CLI: '1' },
      });
      if (dl.status !== 0) summary.data.downloadFailures = (summary.data.downloadFailures || 0) + 1;
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function loadLedgerIndex() {
  const ledger = path.join(BASE_DIR, 'ledger.jsonl');
  const map = new Map();
  if (!fs.existsSync(ledger)) return map;
  for (const line of fs.readFileSync(ledger, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && row.name && row.fid) map.set(row.name, row); // 同名取最后一条（最新）
    } catch { /* 忽略坏行 */ }
  }
  return map;
}

function loadManifest(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) fail(`清单不存在：${abs}`);
  const set = new Set();
  for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const name = line.trim().split('#')[0].trim(); // 支持 # 注释
    if (name) set.add(name);
  }
  if (!set.size) fail(`清单为空：${abs}`);
  return set;
}

function forward(args) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    stdio: 'inherit',
    env: { ...process.env, OPENCLAW_CLI: '1' },
  });
  process.exit(res.status ?? 1);
}

install().then(
  (r) => {
    if (handleExtra(process.argv.slice(2))) return;
    forward(process.argv.slice(2));
  },
  (err) => fail(`官方 CLI 安装失败：${err && err.message ? err.message : err}`),
);
