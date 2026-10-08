#!/usr/bin/env node
/**
 * quark-ledger — 查询本插件的上传台账（~/.zcode-quark/ledger.jsonl）。
 *
 * 用法：
 *   node quark-ledger.cjs [--keyword <关键词>] [--limit <N>] [--all]
 *
 * 输出：JSON 行（与台账行一致，另加 host 字段）。无匹配时退出码 1。
 * 台账只是本地缓存，云端为准；可随时删除，重新上传/补录即恢复。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEDGER = process.env.QUARK_DRIVE_HOME
  ? path.join(process.env.QUARK_DRIVE_HOME, 'ledger.jsonl')
  : path.join(os.homedir(), '.zcode-quark', 'ledger.jsonl');

function parseArgs(argv) {
  const o = { keyword: '', limit: 20, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keyword') o.keyword = String(argv[++i] || '');
    else if (argv[i] === '--limit') o.limit = Math.max(1, Number(argv[++i]) || 20);
    else if (argv[i] === '--all') o.all = true;
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(LEDGER)) {
    process.stderr.write(`[quark-ledger] 台账不存在：${LEDGER}（首次上传后自动生成）\n`);
    process.exit(1);
  }
  const kw = opts.keyword.toLowerCase();
  const rows = [];
  const lines = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    if (!row || !row.fid) continue;
    if (kw) {
      const hay = `${row.name || ''}\n${row.path || ''}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  const shown = opts.all ? rows : rows.slice(0, opts.limit);
  for (const row of shown) process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`[quark-ledger] 共 ${rows.length} 条${opts.all ? '' : `，显示前 ${shown.length} 条（--all 查看全部）`} · ${LEDGER}\n`);
  process.exit(rows.length ? 0 : 1);
}

main();
