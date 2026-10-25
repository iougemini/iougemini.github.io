/* KMS 线路定时巡检：
   1. 检测所有备用线路 + 候选池（vlmcs 协议验证 + TCP 延迟）
   2. 连续失效达阈值的线路自动由最优候选池顶替
   3. 结果写入 data/servers.json，精确延迟写入 data/.last-run.json（供 DNS 负载均衡用，不提交） */
import fs from 'node:fs';
import { loadData, saveData, deepCheck, mapLimit, LAST_RUN_FILE, DATA_FILE } from './kms-lib.mjs';

const REPLACE_AFTER = 3;        // 连续失败 N 次判定为失效
const PARALLEL = 6;
const LATENCY_JITTER = 10;      // 延迟变化小于该值不写回（避免每次巡检都产生提交）
const VLMCS_BIN = process.env.VLMCS_BIN || 'vlmcs';

const data = loadData();
const now = new Date().toISOString().slice(0, 10);

/* 收集全部待检目标 */
const targets = [
  ...data.lines.map(l => ({ kind: 'line', ref: l, host: l.host, port: 1688 })),
  ...data.candidates.map(c => ({ kind: 'candidate', ref: c, host: c.host, port: c.port || 1688 })),
];

await mapLimit(targets, PARALLEL, async t => {
  const r = await deepCheck(VLMCS_BIN, t.host, t.port);
  const e = t.ref;
  e.last_checked = now;
  if (r.ok) {
    e.state = 'ok';
    e.consecutive_fail = 0;
    e.error = undefined;
    e.ip = r.ips_ok[0];                              // 最快的通过验证 IP
    e.ips_ok = r.ips_ok;                             // 全部通过验证的 IP（供 DNS 负载均衡）
    e.ips_total = r.ips_total;
    e.ip_lat = Object.fromEntries(r.results.filter(x => x.ok).map(x => [x.ip, x.latency_ms]));
    e.partial = r.ips_ok.length < r.ips_total;       // 存在未通过验证的 IP
    const rounded = Math.round(r.latency_ms / 5) * 5;   // 5ms 粒度，抑制抖动提交
    if (e.latency_ms == null || Math.abs(rounded - e.latency_ms) >= LATENCY_JITTER) e.latency_ms = rounded;
  } else {
    e.state = 'down';
    e.consecutive_fail = (e.consecutive_fail || 0) + 1;
    e.ips_ok = [];
    e.ips_total = r.ips_total;
    e.error = (r.reason || '').slice(0, 250);
    if (e.consecutive_fail >= REPLACE_AFTER) e.latency_ms = null;
  }
});

/* 失效线路自动替换：用候选池中延迟最低的在线服务器顶替 */
for (const line of data.lines) {
  if (line.state === 'down' && line.consecutive_fail >= REPLACE_AFTER) {
    const best = data.candidates
      .filter(c => c.state === 'ok')
      .sort((a, b) => (a.latency_ms ?? 1e9) - (b.latency_ms ?? 1e9))[0];
    if (best) {
      data.candidates = data.candidates.filter(c => c !== best);
      data.swaps.unshift({
        at: now,
        slot: line.id,
        removed: line.host,
        added: best.host,
        from: best.source || 'candidate',
      });
      data.swaps = data.swaps.slice(0, 30);
      console.log(`[swap] ${line.id}: ${line.host} (连续失效 ${line.consecutive_fail} 次) → ${best.host} (${best.source || 'candidate'})`);
      line.host = best.host;
      line.source = best.source || 'candidate';
      line.state = 'ok';
      line.latency_ms = best.latency_ms;
      line.ip = best.ip || null;
      line.consecutive_fail = 0;
      line.error = undefined;
      line.swapped_at = now;
    } else {
      console.log(`[down] ${line.id}: ${line.host} 已失效，但候选池没有可用顶替`);
    }
  }
}

const okLines = data.lines.filter(l => l.state === 'ok').length;
console.log(`[done] 线路 ${okLines}/${data.lines.length} 在线，候选池 ${data.candidates.length} 台`);
saveData(data);

/* 30 天可用性历史：每天每条线路记录 ok/down/flap（只有状态翻转或跨天才产生提交） */
const HIST_FILE = 'data/history.json';
let hist = { days: {} };
try { hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
const day = (hist.days[now] = hist.days[now] || {});
for (const l of data.lines) {
  const cur = day[l.id];
  if (cur === 'flap') day[l.id] = 'flap';
  else if (cur && cur !== l.state) day[l.id] = 'flap';
  else day[l.id] = l.state;
}
const keys = Object.keys(hist.days).sort();
while (keys.length > 60) delete hist.days[keys.shift()];
fs.writeFileSync(HIST_FILE, JSON.stringify(hist, null, 2) + '\n');

/* 精确延迟快照供 update-dns.mjs 使用（加入 .gitignore，不入库） */
fs.writeFileSync(LAST_RUN_FILE, JSON.stringify({
  at: new Date().toISOString(),
  latency: Object.fromEntries([
    ...data.lines.map(l => [l.host, {
      ips_ok: l.ips_ok || (l.ip ? [l.ip] : []),
      lat: l.ip_lat || Object.fromEntries((l.ips_ok || [l.ip].filter(Boolean)).map(ip => [ip, l.latency_ms])),
      state: l.state,
    }]),
    ...data.candidates.map(c => [c.host, {
      ips_ok: c.ips_ok || (c.ip ? [c.ip] : []),
      lat: c.ip_lat || Object.fromEntries((c.ips_ok || [c.ip].filter(Boolean)).map(ip => [ip, c.latency_ms])),
      state: c.state,
    }]),
  ]),
}, null, 2));
console.log(`[done] ${DATA_FILE} / ${LAST_RUN_FILE} 已更新`);
