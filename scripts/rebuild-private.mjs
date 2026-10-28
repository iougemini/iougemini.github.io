/* 重建候选池私有数据：从 git 历史中的明文 servers.json 恢复投稿服务器真实地址，
   用当前 CANDIDATES_SECRET 重新加密写入 data/candidates.enc。
   用途：首次配置 Secret 或密钥更换后，在 CI 上执行（workflow_dispatch）。
   密钥只存在于 GitHub Secrets 与 runner 内存，不落日志、不入库。
   历史定位按提交信息 grep（对 filter-branch/force-push 重写免疫）。 */
import { execFileSync } from 'node:child_process';
import { loadData, saveData } from './kms-lib.mjs';

const HISTORY_MSG = process.env.HISTORY_MSG || '收录投稿服务器（issue #4）';

function resolveCommit() {
  const out = execFileSync('git', ['log', '--all', '--format=%H %s', '--grep', HISTORY_MSG], { encoding: 'utf8' }).trim();
  if (!out) return null;
  return out.split('\n')[0].split(' ')[0];
}

const HISTORY_COMMIT = process.env.HISTORY_COMMIT || resolveCommit();
if (!HISTORY_COMMIT) { console.error('[rebuild] 未找到明文候选数据所在的提交'); process.exit(1); }
console.log('[rebuild] 从提交', HISTORY_COMMIT.slice(0, 8), '恢复明文候选地址');

const oldRaw = execFileSync('git', ['show', `${HISTORY_COMMIT}:data/servers.json`], { encoding: 'utf8' });
const oldData = JSON.parse(oldRaw);
const oldCands = (oldData.candidates || []).filter(c => c.host);

if (!oldCands.length) {
  console.error(`[rebuild] 提交 ${HISTORY_COMMIT} 的 servers.json 中没有明文候选数据，无法重建`);
  process.exit(1);
}

const data = loadData();
const pub = data.candidates || [];

if (pub.length !== oldCands.length) {
  console.log(`[rebuild] 注意：当前候选池 ${pub.length} 台，历史明文 ${oldCands.length} 台，按顺序对齐（多余忽略）`);
}
let restored = 0;
for (let i = 0; i < pub.length && i < oldCands.length; i++) {
  if (!pub[i].host) {
    pub[i].host = oldCands[i].host;
    pub[i].port = oldCands[i].port || 1688;
    restored++;
    console.log(`[rebuild] ${pub[i].key} ← ${oldCands[i].host}`);
  } else {
    console.log(`[rebuild] ${pub[i].key} 已有地址（${pub[i].host}），跳过`);
  }
}

if (!restored) {
  console.log('[rebuild] 无需恢复（所有候选均有真实地址）');
} else {
  saveData(data);
  console.log(`[rebuild] 完成：恢复 ${restored} 台，candidates.enc 已用当前 Secret 重新加密`);
}
