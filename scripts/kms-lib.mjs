/* iKMS 线路检测共享库：数据读写、主机规范化、TCP 延迟、vlmcs 验证 */
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const DATA_FILE = 'data/servers.json';
export const LAST_RUN_FILE = 'data/.last-run.json';
export const KMS_DEFAULT_PORT = 1688;

/* ---------- 数据 ----------
   servers.json 随网站公开，候选池只存脱敏条目（key/状态/延迟，不含投稿地址）。
   投稿服务器的真实地址加密存储在 data/candidates.enc（随仓库提交，AES-256-GCM，
   密钥为 GitHub Secret CANDIDATES_SECRET），本地开发时另有明文 candidates-private.json（gitignore）。
   loadData 读取时自动解密/合并回内存中的 candidates；
   saveData 写盘时自动拆分：公开脱敏 + 私有加密，透明同步。 */
export const PRIVATE_FILE = 'data/candidates-private.json';
export const ENC_FILE = 'data/candidates.enc';

function secretKey() {
  const secret = process.env.CANDIDATES_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptJson(obj) {
  const key = secretKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') });
}

function decryptJson(text) {
  const key = secretKey();
  if (!key) return null;
  try {
    const box = JSON.parse(text);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch { return null; }
}

/* 读取私有地址映射 { key: {host, port} }：优先明文本地文件（开发环境），其次解密仓库文件（CI） */
function loadPrivate() {
  try { return JSON.parse(fs.readFileSync(PRIVATE_FILE, 'utf8')); } catch {}
  if (fs.existsSync(ENC_FILE)) {
    const priv = decryptJson(fs.readFileSync(ENC_FILE, 'utf8'));
    if (priv) return priv;
    console.error('[warn] candidates.enc 存在但解密失败（缺少或错误的 CANDIDATES_SECRET）');
  }
  return {};
}

/* 为新投稿生成稳定的脱敏 key（c1, c2, ...） */
export function nextCandidateKey(data) {
  let n = 1;
  const keys = new Set((data.candidates || []).map(c => c.key));
  while (keys.has('c' + n)) n++;
  return 'c' + n;
}

export function loadData() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const priv = loadPrivate();
  for (const c of data.candidates || []) {
    if (c.key && priv[c.key]) {
      const p = priv[c.key];
      c.host = p.host;
      c.port = p.port || 1688;
      /* 恢复技术状态字段（公开条目里不存，但巡检/负载均衡/替换继承需要） */
      c.ips_ok = p.ips_ok || [];
      c.ips_total = p.ips_total ?? (c.ips_ok.length || null);
      c.ip_lat = p.ip_lat || {};
      c.partial = !!p.partial;
    }
  }
  return data;
}

export function saveData(data) {
  data.updated_at = new Date().toISOString().slice(0, 10);
  /* 私有地址抽出到加密文件与本地明文文件。
     注意：不修改传入的 data 对象（后续步骤还依赖内存中的 ips_ok 等），
     servers.json 写入的是脱敏副本。 */
  const priv = loadPrivate();
  const pubCandidates = [];
  for (const c of data.candidates || []) {
    if (!c.key) c.key = nextCandidateKey(data);
    if (c.host) {
      /* 全量技术状态入私有存储：替换继承、负载均衡、重启恢复都依赖它们 */
      priv[c.key] = {
        host: c.host, port: c.port || 1688,
        ips_ok: c.ips_ok || [], ips_total: c.ips_total ?? (c.ips_ok || []).length,
        ip_lat: c.ip_lat || {}, partial: !!c.partial,
      };
    } else {
      /* 解密失败兜底：保留私有数据旧值，并用其回填技术字段保证功能可用 */
      console.error(`[warn] 候选 ${c.key} 缺少真实地址，保留私有数据旧值（如需恢复请运行重建 workflow）`);
      const old = priv[c.key];
      if (old) {
        c.ips_ok = old.ips_ok || [];
        c.ips_total = old.ips_total ?? null;
        c.ip_lat = old.ip_lat || {};
        c.partial = !!old.partial;
      }
    }
    /* 公开条目脱敏副本：真实地址与 IP 都不公开（IP 可反查服务器归属） */
    pubCandidates.push({
      ...c,
      host: undefined, port: undefined, ip: undefined,
      ips_ok: undefined, ip_lat: undefined,
    });
  }
  /* 本地明文（开发用，gitignore） */
  fs.writeFileSync(PRIVATE_FILE, JSON.stringify(priv, null, 2) + '\n');
  /* 加密文件（随仓库提交，CI 持久化）——未配置密钥时告警：真实地址将无法在下次巡检恢复 */
  const enc = encryptJson(priv);
  if (enc) fs.writeFileSync(ENC_FILE, enc + '\n');
  else console.error('[warn] 未配置 CANDIDATES_SECRET，候选池真实地址仅存于本地 private 文件，CI 将无法持久化！');
  fs.writeFileSync(DATA_FILE, JSON.stringify({ ...data, candidates: pubCandidates }, null, 2) + '\n');
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

/* ---------- TCP 连接延迟（对 KMS 端口，family 4/6 可选） ---------- */
export function tcpLatency(host, port, timeoutMs = 4000, family) {
  return new Promise(resolve => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host, port, family });
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

/* ---------- check-host.net 多节点 TCP 拨测（免费、无需密钥） ----------
   区域限制线路（仅国内可达）无法从海外 CI 直接验证，改由 check-host.net
   的全球节点发起 TCP 连接测试，返回成功节点的最小连接时间作为延迟。
   拨测完全失败时返回 ok:false，由调用方按 trusted 规则保持在线。 */
export async function checkHostTcpLatency(host, port = KMS_DEFAULT_PORT, maxNodes = 4, pollMs = 40000) {
  const H = { Accept: 'application/json' };
  const create = await fetch(
    `https://check-host.net/check-tcp?host=${encodeURIComponent(host + ':' + port)}&max_nodes=${maxNodes}`,
    { headers: H },
  );
  const cj = await create.json();
  if (!cj.request_id) return { ok: false, reason: 'check-host 请求创建失败' };

  const deadline = Date.now() + pollMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const rr = await fetch(`https://check-host.net/check-result/${cj.request_id}`, { headers: H });
    const rj = await rr.json();
    const vals = Object.values(rj || {});
    if (!vals.length) continue;
    if (vals.every(v => v !== null)) {
      const okTimes = vals.filter(v => Array.isArray(v) && v[0] === true).map(v => v[1]);
      if (okTimes.length) {
        return { ok: true, latency_ms: Math.round(Math.min(...okTimes) * 1000), nodes_ok: okTimes.length, nodes_total: vals.length };
      }
      return { ok: false, reason: '所有拨测节点均连接失败' };
    }
  }
  return { ok: false, reason: '拨测超时' };
}

/* ---------- 单主机完整检测 ---------- */
export async function checkHost(vlmcsBin, host, port = KMS_DEFAULT_PORT) {
  const latency = await tcpLatency(host, port);
  if (latency == null) return { ok: false, latency_ms: null, reason: 'TCP 连接失败（端口不通或域名无法解析）' };
  const v = await vlmcsCheck(vlmcsBin, host, port);
  if (!v.ok) return { ok: false, latency_ms: Math.round(latency), reason: 'KMS 协议验证失败：' + v.output.slice(-300) };
  return { ok: true, latency_ms: Math.round(latency), output: v.output };
}

/* ---------- 深度检测：多 IP 主机逐 IP 验证（IPv4 + IPv6 双栈） ----------
   公益线路常见"一个域名轮询多个服务器"的情况，其中可能混入失效/配置错误的 IP。
   同时解析 A 与 AAAA 记录，逐 IP 做 TCP + vlmcs 验证，返回通过验证的 IP 清单（按延迟升序）。 */
export async function deepCheck(vlmcsBin, host, port = KMS_DEFAULT_PORT, maxIps = 6) {
  let v4 = [], v6 = [];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    v4 = [host];                                     // 纯 IP 投稿直接使用该地址
  } else if (/^[0-9a-fA-F:]+$/.test(host) && host.includes(':')) {
    v6 = [host];
  } else {
    const [a4, a6] = await Promise.all([
      dns.resolve4(host).then(a => a.slice(0, maxIps)).catch(() => []),
      dns.resolve6(host).then(a => a.slice(0, maxIps)).catch(() => []),
    ]);
    v4 = a4; v6 = a6;
  }
  const all = [
    ...v4.map(ip => ({ ip, family: 4 })),
    ...v6.map(ip => ({ ip, family: 6 })),
  ];
  if (!all.length) return { ok: false, ips_ok: [], v4_ok: [], v6_ok: [], stack: null, ips_total: 0, latency_ms: null, reason: '域名无法解析（无 A/AAAA 记录）' };

  const results = await mapLimit(all, 3, async t => {
    const latency = await tcpLatency(t.ip, port, 4000, t.family);
    if (latency == null) return { ip: t.ip, family: t.family, ok: false, latency_ms: null, fail: 'TCP 连接失败' };
    const v = await vlmcsCheck(vlmcsBin, t.ip, port);
    return { ip: t.ip, family: t.family, ok: v.ok, latency_ms: Math.round(latency), fail: v.ok ? undefined : v.output.slice(-120) };
  });
  const good = results.filter(r => r.ok).sort((a, b) => a.latency_ms - b.latency_ms);
  const v4_ok = good.filter(g => g.family === 4).map(g => g.ip);
  const v6_ok = good.filter(g => g.family === 6).map(g => g.ip);
  const stack = v4_ok.length && v6_ok.length ? 'dual' : v4_ok.length ? 'v4' : v6_ok.length ? 'v6' : null;
  const reason = good.length ? undefined
    : '全部 ' + all.length + ' 个 IP 均未通过 KMS 协议验证：' +
      results.filter(r => !r.ok).map(r => r.ip + '(' + (r.fail || '').replace(/\s+/g, ' ').slice(-80) + ')').join('；').slice(0, 400);
  return {
    ok: good.length > 0,
    ips_ok: good.map(g => g.ip),
    v4_ok, v6_ok, stack,
    ips_total: all.length,
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
