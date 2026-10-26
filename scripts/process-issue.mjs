/* 处理 issue 投稿：解析服务器地址（支持多台，一行一个）→ 逐台 vlmcs 验证 → 通过的加入候选池 → 汇总表回复 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadData, saveData, parseHosts, deepCheck } from './kms-lib.mjs';

const ISSUE_NUMBER = process.env.ISSUE_NUMBER || '?';
const body = process.env.ISSUE_BODY || '';
const VLMCS_BIN = process.env.VLMCS_BIN || 'vlmcs';
const COMMENT_FILE = process.env.COMMENT_FILE || '/tmp/comment.md';

/* 幂等保护：该 issue 已被机器人处理过则跳过（防止 edited/labeled 重复触发重复回复） */
if (process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY && /^\d+$/.test(ISSUE_NUMBER)) {
  try {
    const comments = execFileSync('gh',
      ['api', `repos/${process.env.GITHUB_REPOSITORY}/issues/${ISSUE_NUMBER}/comments`, '--jq', '.[].body'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (/候选池|验证未通过/.test(comments)) {
      console.log('[skip] 该 issue 已被处理过，跳过重复处理');
      process.exit(0);
    }
  } catch {}
}

const data = loadData();

function reply(text) {
  fs.writeFileSync(COMMENT_FILE, text);
  console.log(text);
}

const { valid: hosts, invalid } = parseHosts(body);

if (!hosts.length && !invalid.length) {
  reply(`⚠️ 未能从投稿中解析出有效的服务器地址。\n\n请确认格式，**一行一个**，例如：\n\n\`\`\`\nkms.example.com\n1.2.3.4:1688\n\`\`\`\n\n修改后欢迎重新提交（或编辑本 issue，机器人会重新检测）。`);
  process.exit(0);
}

/* 全部无效且没有任何有效地址 → 直接回复格式问题 */
if (!hosts.length) {
  reply(`⚠️ 投稿的地址均无效：\n\n${invalid.map(i => `- \`${i.raw}\`：${i.reason}`).join('\n')}\n\n支持域名或公网 IP，可带端口（默认 1688），内网/环回地址不接受。修改后欢迎重新提交。`);
  process.exit(0);
}

console.log(`[check] 共 ${hosts.length} 台服务器待验证 ...`);

/* 逐台深度检测（多 IP 域名会逐 IP 验证） */
const results = [];
for (const { host, port } of hosts) {
  const dup = [...data.lines, ...data.candidates].some(e =>
    e.host === host && (e.port || 1688) === port);
  if (dup) {
    results.push({ host, port, dup: true, ok: null, summary: 'ℹ️ 已在线路或候选池中' });
    continue;
  }
  console.log(`[check] ${host}:${port} ...`);
  const r = await deepCheck(VLMCS_BIN, host, port);
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
    results.push({ host, port, ok: true, r, summary: `✅ 通过（${r.ips_ok.length}/${r.ips_total} 个 IP）` });
  } else {
    results.push({ host, port, ok: false, r, summary: '❌ 验证未通过', reason: r.reason || '' });
  }
}

saveData(data);

/* 生成汇总回复 */
const mainTable = results.map(x => {
  const addr = '`' + x.host + (x.port !== 1688 ? ':' + x.port : '') + '`';
  if (x.dup) return `| ${addr} | — | ℹ️ 已收录 | 无需重复投稿 |`;
  const ipInfo = x.ok ? (x.r.ips_ok.join(', ') + '（' + x.r.latency_ms + ' ms）') : (x.r && x.r.reason ? x.r.reason.slice(0, 120) : '—');
  return `| ${addr} | ${x.ok ? '✅ 通过' : '❌ 失败'} | ${x.summary.replace(/^✅ |^❌ /, '')} | ${ipInfo} |`;
}).join('\n');

const addedList = results.filter(x => x.ok).map(x => '`' + x.host + (x.port !== 1688 ? ':' + x.port : '') + '`');
const failedList = results.filter(x => x.ok === false);
const invalidLines = invalid.map(i => `- \`${i.raw}\`：${i.reason}`).join('\n');

let replyText = `## 投稿检测结果（共 ${hosts.length + invalid.length} 台）\n\n| 服务器 | 结果 | 状态 | 通过 IP / 原因 |\n| --- | --- | --- | --- |\n${mainTable}\n`;

if (addedList.length) {
  const plural = hosts.length > 1;
  replyText += `\n### ✅ 已加入候选池：${addedList.join('、')}\n\n巡检机器人（每 30 分钟）会持续监测。当某条备用线路连续失效时，将自动由候选池中延迟最低的服务器顶替上线，其通过验证的 IP 也会参与主线路 [s.ikms.eu.org](https://ikms.eu.org) 的负载均衡。${plural ? '\n\n感谢一次性共享多台服务器！' : '感谢支持！'}`;
}
if (failedList.length) {
  replyText += `\n\n### ❌ 验证未通过 ${failedList.length} 台\n\n常见原因：服务器未开机 / 1688 端口未放行 / 并非 KMS 服务。修正后欢迎编辑本 issue 或重新提交。`;
}
if (invalid.length) {
  replyText += `\n\n### ⚠️ 无法识别的地址 ${invalid.length} 个\n\n${invalidLines}\n\n支持域名或公网 IP，可带端口（默认 1688），内网/环回地址不接受。`;
}

reply(replyText.trim());
