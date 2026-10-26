/* iKMS 线路检测共享库：数据读写、主机规范化、TCP 延迟、vlmcs 验证 */
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';

export const DATA_FILE = 'data/servers.json';
export const LAST_RUN_FILE = 'data/.last-run.json';
export const KMS_DEFAULT_PORT = 1688;

/* ---------- 数据 ---------- */
export function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
export function saveData(data) {
  data.updated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
}

/* ---------- 主机规范化 ----------
   接受 "kms.example.com"、"1.2.3.4"、"kms.example.com:1688"，返回 {host, port}
   拒绝内网/环回地址（公网无意义）与非法字符 */
export function normalizeHost(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')      // 去协议头
    .replace(/\/.*$/, '');            // 去路径
  if (!/^[a-z0-9._-]+(:\d+)?$/.test(s)) return null;
  let host = s, port = KMS_DEFAULT_PORT;
  const m = s.match(/^(.+):(\d+)$/);
  if (m) { host = m[1]; port = Number(m[2]); }
  if (port < 1 || port > 65535) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) return null;
  if (isPrivateIp(host)) return null;
  return { host, port };
}

export function isPrivateIp(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const o = host.split('.').map(Number);
  if (o.some(n => n > 255)) return true;
  if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  return false;
}

/* ---------- TCP 连接延迟（对 KMS 端口） ---------- */
export function tcpLatency(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host, port });
    const done = ms => { sock.destroy(); resolve(ms); };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.once('connect', () => done(Number(process.hrtime.bigint() - start) / 1e6));
    sock.once('error', () => done(null));
  });
}

/* ---------- vlmcs 验证（真实 KMS 协议握手） ---------- */
export function vlmcsCheck(vlmcsBin, host, port, timeoutMs = 20000) {
  return new Promise(resolve => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(vlmcsBin);
    execFile(vlmcsBin, [`${host}:${port}`], { timeout: timeoutMs, encoding: 'utf8', shell: useShell },
      (err, stdout, stderr) => {
        const out = String(stdout || '') + String(stderr || '');
        resolve({ ok: !err, output: out });
      });
  });
}

/* ---------- 单主机完整检测 ---------- */
export async function checkHost(vlmcsBin, host, port = KMS_DEFAULT_PORT) {
  const latency = await tcpLatency(host, port);
  if (latency == null) return { ok: false, latency_ms: null, reason: 'TCP 连接失败（端口不通或域名无法解析）' };
  const v = await vlmcsCheck(vlmcsBin, host, port);
  if (!v.ok) return { ok: false, latency_ms: Math.round(latency), reason: 'KMS 协议验证失败：' + v.output.slice(-300) };
  return { ok: true, latency_ms: Math.round(latency), output: v.output };
}

/* ---------- 深度检测：多 IP 主机逐 IP 验证 ----------
   公益线路常见"一个域名轮询多个服务器"的情况，其中可能混入失效/配置错误的 IP。
   逐 IP 做 TCP + vlmcs 验证，返回通过验证的 IP 清单（按延迟升序）。 */
export async function deepCheck(vlmcsBin, host, port = KMS_DEFAULT_PORT, maxIps = 6) {
  /* 纯 IP 投稿直接使用该地址，不做 DNS 解析 */
  let ips = [];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    ips = [host];
  } else {
    try { ips = (await dns.resolve4(host)).slice(0, maxIps); }
    catch { return { ok: false, ips_ok: [], ips_total: 0, latency_ms: null, reason: '域名无法解析' }; }
    if (!ips.length) return { ok: false, ips_ok: [], ips_total: 0, latency_ms: null, reason: '域名没有 A 记录' };
  }

  const results = await mapLimit(ips, 3, async ip => {
    const latency = await tcpLatency(ip, port);
    if (latency == null) return { ip, ok: false, latency_ms: null, fail: 'TCP 连接失败' };
    const v = await vlmcsCheck(vlmcsBin, ip, port);
    return { ip, ok: v.ok, latency_ms: Math.round(latency), fail: v.ok ? undefined : v.output.slice(-120) };
  });
  const good = results.filter(r => r.ok).sort((a, b) => a.latency_ms - b.latency_ms);
  const reason = good.length ? undefined
    : '全部 ' + ips.length + ' 个 IP 均未通过 KMS 协议验证：' +
      results.filter(r => !r.ok).map(r => r.ip + '(' + (r.fail || '').replace(/\s+/g, ' ').slice(-80) + ')').join('；').slice(0, 400);
  return {
    ok: good.length > 0,
    ips_ok: good.map(g => g.ip),
    ips_total: ips.length,
    latency_ms: good.length ? good[0].latency_ms : null,
    results,
    reason,
  };
}

/* ---------- 投稿地址解析 ----------
   issue 表单渲染格式为 "### 服务器地址\n\n<多行值>"。
   支持一次投稿多台：按行拆分（兼容同内逗号/分号/空格分隔），忽略空行与 # 注释行。
   返回 { valid: [{host,port}], invalid: [{raw,reason}] }，已去重。 */
export function parseHosts(bodyText) {
  const m = bodyText.match(/###\s*服务器地址\s*\n+(.*?)(?=\n###|\n?$)/s);
  const section = m ? m[1] : bodyText;
  const tokens = [];
  for (const line of section.split('\n')) {
    for (const tok of line.split(/[,，;；\s]+/)) {
      const t = tok.trim();
      if (t && !t.startsWith('#')) tokens.push(t);
    }
  }
  const seen = new Set();
  const valid = [];
  const invalid = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    const norm = normalizeHost(t);
    if (norm) valid.push(norm);
    else invalid.push({ raw: t, reason: '格式无效或为内网/环回地址' });
  }
  return { valid, invalid };
}

/* ---------- DNS 解析 ---------- */
export async function resolveIp(host) {
  try { return (await dns.resolve4(host))[0] || null; }
  catch { return null; }
}

/* ---------- 并发限流 ---------- */
export async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}
