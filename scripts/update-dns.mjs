/* 主线路 DNS 负载均衡：
   从全部在线线路 + 候选池中按延迟择优 N 台，解析为 IP 后写入 s.ikms.eu.org 的 A 记录。
   需要 Cloudflare API 密钥（secrets: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID）；
   未配置时打印提示并跳过，不影响巡检流程。记录必须为 DNS-only（proxied:false，
   Cloudflare 代理不支持 1688 端口的 TCP 转发）。 */
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { loadData, LAST_RUN_FILE } from './kms-lib.mjs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE = process.env.CLOUDFLARE_ZONE_ID;
const MAIN_HOST = process.env.MAIN_HOST || 's.ikms.eu.org';
const COUNT = Number(process.env.BALANCE_COUNT || 5);
const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN || !ZONE) {
  console.log(`[dns] 未配置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID，跳过主线路负载均衡。`);
  console.log(`[dns] 配置方法见 README「自动化配置」。`);
  process.exit(0);
}

const data = loadData();
let precise = {};
try { precise = JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8')).latency || {}; } catch {}

/* 汇总所有在线服务器 → 解析 IP → 按延迟排序 */
const hosts = [...data.lines, ...data.candidates].filter(e => e.state === 'ok').map(e => e.host);
const pairs = [];
for (const host of [...new Set(hosts)]) {
  const info = precise[host] || {};
  let ip = info.ip || null;
  if (!ip) { try { ip = (await dns.resolve4(host))[0] || null; } catch {} }
  if (ip) pairs.push({ ip, host, latency: info.latency_ms ?? 1e9 });
}
const desired = [...pairs.sort((a, b) => a.latency - b.latency).slice(0, COUNT).map(p => p.ip)];
console.log(`[dns] 候选 IP（按延迟排序，取前 ${COUNT}）：`);
for (const p of pairs.slice(0, COUNT)) console.log(`   ${p.ip.padEnd(16)} ${String(p.latency).padStart(5)} ms  (${p.host})`);

if (!desired.length) {
  console.log('[dns] 没有在线服务器可写入，跳过（保留现有记录）');
  process.exit(0);
}

const headers = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const api = async (path, opts = {}) => {
  const r = await fetch(`${API}/zones/${ZONE}/dns_records${path}`, { headers, ...opts });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result;
};

const existing = await api(`?type=A&name=${MAIN_HOST}&per_page=100`);
const existingIps = new Set(existing.map(r => r.content));
const dry = process.env.DRY_RUN === '1';

for (const rec of existing) {
  if (!desired.includes(rec.content)) {
    console.log(`[dns] ${dry ? '(dry)' : 'DELETE'} ${rec.content}（未入选）`);
    if (!dry) await api(`/${rec.id}`, { method: 'DELETE' });
  }
}
for (const ip of desired) {
  if (!existingIps.has(ip)) {
    console.log(`[dns] ${dry ? '(dry)' : 'CREATE'} A ${MAIN_HOST} -> ${ip}`);
    if (!dry) await api('', {
      method: 'POST',
      body: JSON.stringify({ type: 'A', name: MAIN_HOST, content: ip, ttl: 300, proxied: false }),
    });
  }
}
console.log(`[dns] 完成：${MAIN_HOST} 现指向 ${desired.join(', ')}`);
