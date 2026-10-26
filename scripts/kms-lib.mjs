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
      c.host = priv[c.key].host;
      c.port = priv[c.key].port || 1688;
    }
  }
  return data;
}

export function saveData(data) {
  data.updated_at = new Date().toISOString().slice(0, 10);
  /* 私有地址抽出到加密文件与本地明文文件 */
  const priv = loadPrivate();
  for (const c of data.candidates || []) {
    if (!c.key) c.key = nextCandidateKey(data);
    priv[c.key] = { host: c.host, port: c.port || 1688 };
    /* 公开条目脱敏：真实地址与 IP 都不公开（IP 可反查服务器归属） */
    delete c.host;
    delete c.port;
    delete c.ip;
    delete c.ips_ok;
    delete c.ip_lat;
  }
  /* 本地明文（开发用，gitignore） */
  fs.writeFileSync(PRIVATE_FILE, JSON.stringify(priv, null, 2) + '\n');
  /* 加密文件（随仓库提交，CI 持久化）——未配置密钥时告警：真实地址将无法在下次巡检恢复 */
  const enc = encryptJson(priv);
  if (enc) fs.writeFileSync(ENC_FILE, enc + '\n');
  else console.error('[warn] 未配置 CANDIDATES_SECRET，候选池真实地址仅存于本地 private 文件，CI 将无法持久化！');
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
