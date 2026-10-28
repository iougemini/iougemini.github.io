/* 本机延迟上报器：在维护者的国内网络环境下测量 trusted（所有者担保）线路的真实延迟，
   通过 repository_dispatch 推送到仓库，由 CI 合并进 data/servers.json。
   由 scripts/report-latency.cmd（Windows 计划任务每 30 分钟调用）执行；
   手动运行：node scripts/report-latency.mjs [--dry]（--dry 只测量不上报） */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepCheck } from './kms-lib.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VLMCS_BIN = process.env.VLMCS_BIN || path.join(REPO, 'files', process.platform === 'win32' ? 'vlmcs.exe' : 'vlmcs');
const DRY = process.argv.includes('--dry');
const PAYLOAD_FILE = path.join(process.env.TEMP || '/tmp', 'ikms-latency-payload.json');

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'servers.json'), 'utf8'));
const lines = (data.lines || []).filter(l => l.trusted);
if (!lines.length) {
  console.log('[report] 没有 trusted 线路，无需上报');
  process.exit(0);
}

console.log(`[report] 测量 ${lines.length} 条 trusted 线路（本机网络视角）...`);
const out = [];
for (const l of lines) {
  const r = await deepCheck(VLMCS_BIN, l.host, 1688);
  out.push({ id: l.id, latency_ms: r.latency_ms, stack: r.stack, ok: r.ok });
  console.log(`  ${l.id} ${r.ok ? 'ok' : 'down'} ${r.latency_ms ?? '-'}ms stack=${r.stack}`);
}

const payload = JSON.stringify({ lines: out });
fs.writeFileSync(PAYLOAD_FILE, payload);
console.log(`[report] payload -> ${PAYLOAD_FILE}`);

if (DRY) { console.log('[report] --dry 模式，不上报'); process.exit(0); }

/* 取 git 凭据 token 并通过代理调用 GitHub API（走 curl 以复用系统代理配置） */
const credRaw = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
});
const m = credRaw.match(/password=(.+)/);
if (!m) { console.error('[report] 未取到 git 凭据'); process.exit(1); }
const token = m[1].trim();

/* repository_dispatch 要求外层包 event_type + client_payload */
const body = JSON.stringify({ event_type: 'kms-latency', client_payload: JSON.parse(payload) });

const res = execFileSync('curl', [
  '-s', '--max-time', '40', '-x', 'http://127.0.0.1:7890',
  '-X', 'POST',
  '-H', 'Accept: application/vnd.github+json',
  '-H', `Authorization: Bearer ${token}`,
  'https://api.github.com/repos/iougemini/iougemini.github.io/dispatches',
  '-d', body,
], { encoding: 'utf8' });
console.log('[report] 已上报', res ? res.slice(0, 200) : '(204 无返回体)');
