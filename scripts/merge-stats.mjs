/* 接收 KMS 服务器上报的请求统计（repository_dispatch: kms-stats）并合并进 data/stats.json。
   payload: { date?: "YYYY-MM-DD", requests: number, clients?: number }
   由自有 KMS 服务器每日统计 vlmcsd 日志后调用（配置方法见 README）。 */
import fs from 'node:fs';

const FILE = 'data/stats.json';
const p = JSON.parse(process.env.PAYLOAD || '{}');
const date = (p.date || new Date().toISOString().slice(0, 10));
const requests = Math.max(0, Number(p.requests) || 0);
const clients = Math.max(0, Number(p.clients) || 0);

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('[stats] 非法日期:', date);
  process.exit(1);
}

const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const i = (s.daily || []).findIndex(x => x.date === date);
if (i >= 0) s.daily[i] = { date, requests, clients };
else {
  s.daily.push({ date, requests, clients });
  s.daily.sort((a, b) => (a.date < b.date ? -1 : 1));
}
s.daily = s.daily.slice(-60);                       // 保留 60 天
s.total_requests = s.daily.reduce((a, x) => a + x.requests, 0);
s.total_clients = s.daily.reduce((a, x) => a + x.clients, 0);
s.updated_at = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
console.log(`[stats] 已记录 ${date}: requests=${requests} clients=${clients}，累计 ${s.total_requests}`);
