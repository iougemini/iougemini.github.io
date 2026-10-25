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

const existingAll = await api(`?name=${MAIN_HOST}&per_page=100`);
const cnameRecs = existingAll.filter(r => r.type === 'CNAME');
const existing = existingAll.filter(r => r.type === 'A');
const existingIps = new Set(existing.map(r => r.content));
const dry = process.env.DRY_RUN === '1';

/* 主线路若当前是 CNAME，必须先删除才能创建 A 记录（DNS 不允许同名共存） */
for (const rec of cnameRecs) {
  console.log(`[dns] ${dry ? '(dry)' : 'DELETE'} CNAME ${rec.content}（改写为 A 记录负载均衡）`);
  if (!dry) await api(`/${rec.id}`, { method: 'DELETE' });
}

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
/* 保留的记录若开了橙云代理，改为灰云：Cloudflare 代理不转发 1688 端口 */
for (const rec of existing) {
  if (desired.includes(rec.content) && rec.proxied) {
    console.log(`[dns] ${dry ? '(dry)' : 'PATCH'} ${rec.content} proxied -> false（1688 端口必须灰云直连）`);
    if (!dry) await api(`/${rec.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ proxied: false, ttl: 300 }),
    });
  }
}
console.log(`[dns] 完成：${MAIN_HOST} 现指向 ${desired.join(', ')}`);

/* 把当前择优结果写回 servers.json，供状态页展示 */
if (!dry) {
  const d2 = loadData();
  d2.main.current = pairs.slice(0, COUNT).map(p => ({
    ip: p.ip, host: p.host,
    latency_ms: p.latency === 1e9 ? null : p.latency,
  }));
  d2.main.current_updated = new Date().toISOString();
  d2.main.balanced = true;
  const fs = await import('node:fs');
  fs.writeFileSync('data/servers.json', JSON.stringify(d2, null, 2) + '\n');
}
