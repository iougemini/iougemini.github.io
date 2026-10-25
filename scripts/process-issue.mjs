/* 处理 issue 投稿：解析服务器地址 → vlmcs 验证 → 通过则加入候选池 → 生成回复内容 */
import fs from 'node:fs';
import { loadData, saveData, normalizeHost, deepCheck } from './kms-lib.mjs';

const ISSUE_NUMBER = process.env.ISSUE_NUMBER || '?';
const body = process.env.ISSUE_BODY || '';
const VLMCS_BIN = process.env.VLMCS_BIN || 'vlmcs';
const COMMENT_FILE = process.env.COMMENT_FILE || '/tmp/comment.md';

/* issue 表单渲染格式为 "### 服务器地址\n\n<值>" */
function parseHost() {
  const m = body.match(/###\s*服务器地址\s*\n+\s*([^\n#]+)/);
  if (m && m[1].trim()) return m[1].trim();
  const any = body.match(/^\s*([a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?)\s*$/im);
  return any ? any[1] : null;
}

const raw = parseHost();
const norm = normalizeHost(raw);
const data = loadData();

function reply(text) {
  fs.writeFileSync(COMMENT_FILE, text);
  console.log(text);
}

if (!raw || !norm) {
  reply(`⚠️ 未能从投稿中解析出有效的服务器地址，或该地址不合规（不支持内网/环回地址）。\n\n请确认格式类似：\`kms.example.com\` 或 \`1.2.3.4:1688\`，欢迎修改后重新提交一个新的 issue。`);
  process.exit(0);
}

const { host, port } = norm;
const dup = [...data.lines, ...data.candidates].some(e =>
  e.host === host && (e.port || 1688) === port);
if (dup) {
  reply(`ℹ️ 服务器 \`${host}:${port}\` 已在线路或候选池中，无需重复投稿。感谢支持！`);
  process.exit(0);
}

console.log(`[check] ${host}:${port} ...`);
const r = await deepCheck(VLMCS_BIN, host, port);

function ipTable() {
  return (r.results || []).map(x =>
    '| ' + x.ip + ' | ' + x.latency_ms + ' ms | ' + (x.ok ? '✅ 通过' : '❌ 失败') + ' |').join('\n');
}

if (r.ok) {
  data.candidates.push({
    host, port,
    state: 'ok',
    latency_ms: Math.round(r.latency_ms / 5) * 5,
    ip: r.ips_ok[0],
    ips_ok: r.ips_ok,
    ips_total: r.ips_total,
    ip_lat: Object.fromEntries(r.results.filter(x => x.ok).map(x => [x.ip, x.latency_ms])),
    partial: r.ips_ok.length < r.ips_total,
    last_checked: new Date().toISOString().slice(0, 10),
    consecutive_fail: 0,
    source: `issue #${ISSUE_NUMBER}`,
    added: new Date().toISOString().slice(0, 10),
  });
  saveData(data);
  reply(`✅ 感谢投稿！服务器 \`${host}:${port}\` 验证通过：

| IP | 延迟 | KMS 协议验证 |
| --- | --- | --- |
${ipTable()}

已加入**候选池**（${r.ips_ok.length}/${r.ips_total} 个 IP 通过验证），巡检机器人（每 30 分钟）会持续监测。当某条备用线路连续失效时，将自动由候选池中延迟最低的服务器顶替上线，其通过验证的 IP 也会参与主线路 [s.ikms.eu.org](https://ikms.eu.org) 的负载均衡。`);
} else {
  reply(`❌ 投稿的服务器 \`${host}:${port}\` 验证未通过：

${r.reason || ''}

常见原因：服务器未开机 / 1688 端口未放行 / 并非 KMS 服务。修正后欢迎重新提交。`);
}
