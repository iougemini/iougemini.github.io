/* 私密投稿收录：从 repository_dispatch payload 中解析投稿地址，
   验证格式后以 trusted 候选加入加密候选池（地址仅存私有存储，不公开）。
   payload: { host: "kms.example.com", port?: 1688, source?: string } */
import fs from 'node:fs';
import { loadData, saveData, normalizeHost, nextCandidateKey } from './kms-lib.mjs';

const p = JSON.parse(process.env.PAYLOAD || '{}');
const norm = normalizeHost(p.host);
if (!norm) {
  console.error('[private] 无效的服务器地址:', p.host);
  process.exit(1);
}

const { host, port } = norm;
const data = loadData();

const dup = [...data.lines, ...data.candidates].some(e =>
  e.host === host && (e.port || 1688) === port);
if (dup) {
  console.log('[private] 重复投稿:', host + ':' + port, '跳过');
  process.exit(0);
}

/* 私密投稿由管理员审核通过后收录，标记 trusted：CI 海外验证失败不判死 */
data.candidates.push({
  key: nextCandidateKey(data),
  host, port,
  state: 'ok',
  trusted: true,
  latency_ms: null,
  ips_ok: [], ips_total: null, ip_lat: {}, partial: false,
  consecutive_fail: 0,
  source: p.source || 'private submission',
  added: new Date().toISOString().slice(0, 10),
});

saveData(data);
console.log(`[private] 已收录: ${host}:${port} (trusted, source: ${p.source || 'private'})`);
