/* iKMS 私密投稿 Cloudflare Worker
   部署到 submit.ikms.eu.org（或任意子域），配合 KV namespace KMS_SUBMISSIONS 使用。
   Secrets: ADMIN_KEY（管理员密钥）、GH_TOKEN（Fine-grained PAT，contents:write）。
   Vars: GITHUB_REPOSITORY = iougemini/iougemini.github.io
   投稿地址不创建公开 issue，不入公开 servers.json，仅存 KV 由管理员审核后
   通过 repository_dispatch 触发 CI 收录到加密候选池。 */

const JSON_H = { 'Content-Type': 'application/json; charset=utf-8' };
const VALID_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\.[a-z]{2,})$|^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVATE_V4 = /^(10\.|127\.|0\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/;

function html(title, body) {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="icon" href="https://ikms.eu.org/img/ikmslogo.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#0b1120;color:#e7ecf6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{max-width:480px;width:100%;background:#111627;border:1px solid rgba(148,163,190,.16);border-radius:18px;padding:28px}
h1{font-size:1.3rem;margin-bottom:6px}
p{color:#a3adc4;font-size:.88rem;margin-bottom:18px;line-height:1.6}
label{display:block;font-size:.85rem;color:#a3adc4;margin:14px 0 6px}
input,textarea{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(148,163,190,.2);background:#0a0f1d;color:#e7ecf6;font-size:.92rem}
input:focus,textarea:focus{outline:none;border-color:#fb7185}
textarea{resize:vertical;min-height:60px}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:12px;background:linear-gradient(135deg,#fdba74,#fb7185);color:#fff;font-size:.95rem;font-weight:700;cursor:pointer}
button:hover{opacity:.9}
.hint{font-size:.78rem;color:#6e7a94;margin-top:14px;line-height:1.5}
.ok{color:#34d399;font-weight:600}
.err{color:#f87171;font-weight:600}
.back{display:block;text-align:center;margin-top:14px;color:#6e7a94;font-size:.8rem;text-decoration:none}
</style></head><body><div class="card">${body}</div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeHost(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9._:-]+$/.test(s)) return null;
  let host = s, port = 1688;
  const m = s.match(/^(.+):(\d+)$/);
  if (m) { host = m[1]; port = Number(m[2]); }
  if (port < 1 || port > 65535) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const o = host.split('.').map(Number);
    if (o.some(n => n > 255)) return null;
    if (o[0] === 10 || o[0] === 127 || o[0] === 0 || (o[0] === 192 && o[1] === 168) ||
        (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 169 && o[1] === 254)) return null;
  }
  return { host, port };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    /* ---- 投稿表单页 ---- */
    if (url.pathname === '/' && request.method === 'GET') {
      return html('iKMS · 私密投稿', `
        <h1>KMS 服务器私密投稿</h1>
        <p>投稿信息仅管理员可见，不会公开显示。通过验证后将分配一条 <strong>sXX.ikms.eu.org</strong> 备用线路。</p>
        <label>服务器地址</label>
        <input id="host" placeholder="kms.example.com 或 1.2.3.4:1688" autocomplete="off">
        <label>备注（可选）</label>
        <textarea id="note" placeholder="线路位置、带宽等说明"></textarea>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:16px;cursor:pointer">
          <input type="checkbox" id="agree" style="width:auto;margin-top:3px">
          <span style="font-size:.82rem;color:#a3adc4">我拥有该服务器或已获持有者授权，同意管理员收录用于 KMS 激活服务（不会公开我的地址）</span>
        </label>
        <button onclick="doSubmit()">提交投稿</button>
        <div id="msg" style="margin-top:14px;font-size:.88rem"></div>
        <div class="hint">投稿信息仅管理员可见。通过验证后系统会自动分配备用线路域名，你的真实地址不会公开。</div>
        <a class="back" href="https://ikms.eu.org">← 返回 iKMS 首页</a>
        <script>
        async function doSubmit(){
          var b=document.getElementById('msg');
          var host=document.getElementById('host').value.trim();
          var agree=document.getElementById('agree').checked;
          if(!host){b.innerHTML='<span class="err">请填写服务器地址</span>';return}
          if(!agree){b.innerHTML='<span class="err">请先勾选授权确认</span>';return}
          b.innerHTML='提交中…';
          try{
            var r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({host:host,note:document.getElementById('note')?document.getElementById('note').value:''})});
            var j=await r.json();
            b.innerHTML='<span class="'+(j.ok?'ok':'err')+'">'+j.msg+'</span>';
          }catch(e){b.innerHTML='<span class="err">网络错误，请重试</span>'}
        }
        </script>`);
    }

    /* ---- 提交 API ---- */
    if (url.pathname === '/api/submit' && request.method === 'POST') {
      /* 限流：同一 IP 每天最多 5 条 */
      const rlKey = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
      const rlCount = Number(await env.KMS_SUBMISSIONS.get(rlKey)) || 0;
      if (rlCount >= 5) {
        return new Response(JSON.stringify({ ok: false, msg: '今日投稿次数已达上限（5 条），请明日再试' }), { status: 429, headers: JSON_H });
      }
      await env.KMS_SUBMISSIONS.put(rlKey, String(rlCount + 1), { expirationTtl: 86400 });

      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ ok: false, msg: '请求格式错误' }), { status: 400, headers: JSON_H }); }

      const norm = normalizeHost(body.host);
      if (!norm) {
        return new Response(JSON.stringify({ ok: false, msg: '服务器地址格式无效或为内网/环回地址' }), { status: 400, headers: JSON_H });
      }

      /* 查重：已存在相同 host:port 的投稿 */
      const listJson = await env.KMS_SUBMISSIONS.get('submissions');
      const submissions = listJson ? JSON.parse(listJson) : [];
      const dup = submissions.find(s => s.host === norm.host && s.port === norm.port && s.status === 'pending');
      if (dup) {
        return new Response(JSON.stringify({ ok: false, msg: '该地址已有待审核的投稿，请等待管理员处理' }), { status: 409, headers: JSON_H });
      }

      const id = crypto.randomUUID().slice(0, 8);
      submissions.push({
        id, host: norm.host, port: norm.port,
        note: String(body.note || '').slice(0, 200),
        ip, ts: new Date().toISOString(), status: 'pending',
      });
      await env.KMS_SUBMISSIONS.put('submissions', JSON.stringify(submissions));
      return new Response(JSON.stringify({ ok: true, msg: '投稿已提交，等待管理员审核' }), { headers: JSON_H });
    }

    /* ---- 管理员查看 ---- */
    if (url.pathname === '/admin' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key || key !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: '无效密钥' }), { status: 403, headers: JSON_H });
      }
      const listJson = await env.KMS_SUBMISSIONS.get('submissions');
      const submissions = listJson ? JSON.parse(listJson) : [];
      const htmlRows = submissions.map(s =>
        `<div style="border:1px solid rgba(148,163,190,.2);border-radius:10px;padding:14px;margin-bottom:10px">` +
        `<div style="display:flex;justify-content:space-between;align-items:center"><strong>${htmlEscape(s.host)}:${s.port}</strong>` +
        `<span style="color:${s.status === 'pending' ? '#fbbf24' : s.status === 'approved' ? '#34d399' : '#f87171'}">${s.status}</span></div>` +
        `<div style="color:#6e7a94;font-size:.78rem;margin:4px 0">IP: ${htmlEscape(s.ip)} | ${s.ts}</div>` +
        (s.note ? `<div style="color:#a3adc4;font-size:.82rem">${htmlEscape(s.note)}</div>` : '') +
        (s.status === 'pending' ? `<div style="margin-top:8px;display:flex;gap:8px">` +
          `<button onclick="approve('${s.id}')" style="width:auto;margin:0;padding:6px 14px;background:#059669;font-size:.8rem">收录</button>` +
          `<button onclick="reject('${s.id}')" style="width:auto;margin:0;padding:6px 14px;background:#dc2626;font-size:.8rem">拒绝</button></div>` : '') +
        (s.result ? `<div style="margin-top:6px;font-size:.8rem;color:${s.result === 'collected' ? '#34d399' : '#f87171'}">${htmlEscape(s.result)}</div>` : '') +
        `</div>`).join('');
      return html('iKMS · 管理员审核', `
        <h1>投稿审核</h1><p>共 ${submissions.length} 条投稿</p>
        ${submissions.length ? htmlRows : '<p style="color:#6e7a94">暂无投稿</p>'}
        <script>
        async function act(id, action){
          var r=await fetch('/api/admin/action',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:id,action:action}),credentials:'same-origin'});
          var j=await r.json(); if(j.ok) location.reload();
        }
        function approve(id){act(id,'approve')}
        function reject(id){act(id,'reject')}
        </script>`);
    }

    /* ---- 管理员操作 ---- */
    if (url.pathname === '/api/admin/action' && request.method === 'POST') {
      const authKey = request.headers.get('X-Admin-Key');
      if (!authKey || authKey !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: '无效密钥' }), { status: 403, headers: JSON_H });
      }
      const { id, action } = await request.json();
      const listJson = await env.KMS_SUBMISSIONS.get('submissions');
      const submissions = listJson ? JSON.parse(listJson) : [];
      const sub = submissions.find(s => s.id === id);
      if (!sub) return new Response(JSON.stringify({ ok: false, msg: '投稿不存在' }), { status: 404, headers: JSON_H });

      if (action === 'approve' && sub.status === 'pending') {
        /* 触发 GitHub repository_dispatch 收录到加密候选池 */
        const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`, {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${env.GH_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: 'kms-private-submit',
            client_payload: {
              host: sub.host, port: sub.port,
              source: `private submission (${sub.ip})`,
            },
          }),
        });
        if (ghRes.ok) {
          sub.status = 'approved';
          sub.approved_at = new Date().toISOString();
          await env.KMS_SUBMISSIONS.put('submissions', JSON.stringify(submissions));
          return new Response(JSON.stringify({ ok: true, msg: '已触发收录' }), { headers: JSON_H });
        }
        return new Response(JSON.stringify({ ok: false, msg: 'GitHub 触发失败' }), { status: 502, headers: JSON_H });
      }

      if (action === 'reject' && sub.status === 'pending') {
        sub.status = 'rejected';
        sub.rejected_at = new Date().toISOString();
        await env.KMS_SUBMISSIONS.put('submissions', JSON.stringify(submissions));
        return new Response(JSON.stringify({ ok: true, msg: '已拒绝' }), { headers: JSON_H });
      }

      return new Response(JSON.stringify({ ok: false, msg: '无效操作' }), { status: 400, headers: JSON_H });
    }

    return new Response('Not Found', { status: 404 });
  },
};
