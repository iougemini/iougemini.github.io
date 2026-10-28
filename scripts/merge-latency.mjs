/* 合并本机上报的 trusted 线路延迟（repository_dispatch: kms-latency）
   payload: { lines: [{ id: "s09", latency_ms: 45, stack: "v4" }, ...] }
   只更新延迟与栈标记，不改变状态判定（trusted 线路状态由巡检保持在线）。 */
import fs from 'node:fs';
import { loadData, saveData } from './kms-lib.mjs';

const p = JSON.parse(process.env.PAYLOAD || '{}');
const data = loadData();
let n = 0;
for (const rep of p.lines || []) {
  const l = (data.lines || []).find(x => x.id === rep.id);
  if (!l) continue;
  if (!l.trusted) continue;                    // 只接受 trusted 线路的本机测量
  if (typeof rep.latency_ms === 'number' && rep.latency_ms >= 0) l.latency_ms = rep.latency_ms;
  if (rep.stack) l.stack = rep.stack;
  l.last_checked = new Date().toISOString().slice(0, 10);
  n++;
  console.log(`[merge] ${l.id} latency=${l.latency_ms}ms stack=${l.stack}`);
}
if (!n) { console.log('[merge] 无可合并数据'); process.exit(0); }
saveData(data);
console.log(`[merge] 已更新 ${n} 条`);
