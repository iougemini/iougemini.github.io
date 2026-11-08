/* iKMS 私密投稿 Cloudflare Worker
   部署到 submit.ikms.eu.org（或任意子域），配合 KV namespace KMS_SUBMISSIONS 使用。
   Secrets: ADMIN_KEY（管理员密钥）、GH_TOKEN（Fine-grained PAT，contents:write）、
            RESEND_API_KEY（留言发信）、TURNSTILE_SECRET（人机验证服务端密钥，不入库）。
   Vars: GITHUB_REPOSITORY = iougemini/iougemini.github.io
         TURNSTILE_SITE_KEY（可选，默认与主站弹窗一致）
         CORS_ORIGINS（可选，逗号分隔的额外允许来源，仅本地开发时使用）
         CONTACT_FROM / CONTACT_TO（可选，留言发件/收件）
   投稿地址不创建公开 issue，不入公开 servers.json，仅存 KV 由管理员审核后
   通过 repository_dispatch 触发 CI 收录到加密候选池。
   说明：默认发件域 noreply@subit.us.mw 与站点域名不同，是因为 .eu.org 无法在 Resend
   通过域名校验，属有意为之（非缺陷）。 */

const JSON_H = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};
const HTML_H = {
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

const SUBMIT_LIMIT = 5;                     // 每个 IP 前缀每日投稿上限
const CONTACT_LIMIT = 5;                    // 每个 IP 前缀每日留言上限
const RATE_TTL = 86400;
const RETENTION_TTL = 30 * 86400;           // 投稿保留 30 天后由 KV 自动过期删除
const ADMIN_COOKIE = 'ikms_admin';
const ADMIN_SESSION_MAX_AGE = 8 * 3600;     // 管理员会话 8 小时
const DEFAULT_TURNSTILE_SITE_KEY = '0x4AAAAAAF0gJ7CCSk4QFOeM';

/* ---------- 基础工具 ---------- */

function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/* 每日限流按网段聚合：IPv4 取 /24，IPv6 取 /64，避免换地址绕过 */
function ipPrefix(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  const parts = ip.split('.');
  if (parts.length === 4) return parts.slice(0, 3).join('.') + '.0/24';
  return ip;
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function retryAfterSeconds() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.floor((next - now.getTime()) / 1000));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* 带超时与可选重试的 fetch（Cloudflare Workers 无默认超时，必须显式中断） */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000, retries = 0) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (retries > 0 && attempt < retries && res.status >= 500) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr || new Error('fetch failed');
}

/* ---------- 响应构造 ---------- */

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_H, ...extra } });
}

function html(title, body, extraHeaders = {}, status = 200) {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title><link rel="icon" href="https://ikms.eu.org/img/ikmslogo.png">
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
form{margin:0}
</style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { ...HTML_H, ...extraHeaders } });
}

/* ---------- 跨域（仅留言接口需要） ---------- */

function corsAllowlist(env) {
  /* 生产默认只允许站点自身；本地开发通过 CORS_ORIGINS 变量显式追加 */
  const list = ['https://ikms.eu.org', 'https://www.ikms.eu.org'];
  const extra = String(env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return list.concat(extra);
}

function corsHeaders(env, origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && corsAllowlist(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/* ---------- Turnstile ---------- */

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return { ok: false, reason: 'secret-missing' };
  if (!token) return { ok: false, reason: 'token-missing' };
  try {
    const res = await fetchWithTimeout('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    }, 8000, 1);
    const j = await res.json().catch(() => ({}));
    return { ok: !!j.success, reason: j.success ? '' : 'codes:' + (j['error-codes'] || []).join(',') };
  } catch {
    return { ok: false, reason: 'request-failed' };
  }
}

/* ---------- 主机校验 ---------- */

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

/* ---------- KV 存取（每条投稿独立 key，避免读改写并发丢数据） ---------- */

function kvReady(env) {
  return !!env.KMS_SUBMISSIONS;
}

async function listSubmissions(env, maxItems = 500) {
  const out = [];
  let cursor = undefined;
  do {
    const page = await env.KMS_SUBMISSIONS.list({ prefix: 'sub:', limit: 1000, cursor });
    for (const key of page.keys) {
      const sub = safeJson(await env.KMS_SUBMISSIONS.get(key.name), null);
      if (sub) out.push(sub);
      if (out.length >= maxItems) break;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && out.length < maxItems);
  return out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
}

async function rateStatus(env, kind, ip) {
  const key = `rl:${kind}:${ipPrefix(ip)}:${dayKey()}`;
  const used = Number(await env.KMS_SUBMISSIONS.get(key)) || 0;
  return { key, used, limit: kind === 'contact' ? CONTACT_LIMIT : SUBMIT_LIMIT };
}

async function rateCommit(env, status) {
  await env.KMS_SUBMISSIONS.put(status.key, String(status.used + 1), { expirationTtl: RATE_TTL });
}

/* ---------- 管理员会话 ---------- */

async function adminToken(env) {
  if (!env.ADMIN_KEY) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('ikms-admin|' + env.ADMIN_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('ikms-admin-session-v1'));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isAdmin(request, env) {
  const expected = await adminToken(env);
  if (!expected) return false;
  return safeEqual(getCookie(request, ADMIN_COOKIE) || '', expected);
}

function loginPage(message = '', status = 200) {
  return html('iKMS · 管理员登录', `
    <h1>投稿审核</h1>
    <p>请输入管理员密钥。密钥通过 POST 提交，不会出现在地址栏、历史记录或 Referer 中。</p>
    ${message ? `<p class="err">${htmlEscape(message)}</p>` : ''}
    <form method="POST" action="/admin/login">
      <label for="admin-key">管理员密钥</label>
      <input id="admin-key" name="key" type="password" autocomplete="off" required>
      <button type="submit">登录</button>
    </form>
    <a class="back" href="https://ikms.eu.org">← 返回 iKMS 首页</a>`, {}, status);
}
/* ---------- 路由 ---------- */

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  /* ---- 投稿表单页 ---- */
  if (url.pathname === '/' && request.method === 'GET') {
    const siteKey = env.TURNSTILE_SITE_KEY || DEFAULT_TURNSTILE_SITE_KEY;
    return html('iKMS · 私密投稿', `
      <h1>KMS 服务器私密投稿</h1>
      <p>投稿信息仅管理员可见，不会公开显示。通过验证后将分配一条 <strong>sXX.ikms.eu.org</strong> 备用线路。</p>
      <label for="host">服务器地址</label>
      <input id="host" placeholder="kms.example.com 或 1.2.3.4:1688" autocomplete="off">
      <label for="note">备注（可选）</label>
      <textarea id="note" placeholder="线路位置、带宽等说明"></textarea>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-top:16px;cursor:pointer">
        <input type="checkbox" id="agree" style="width:auto;margin-top:3px">
        <span style="font-size:.82rem;color:#a3adc4">我拥有该服务器或已获持有者授权，同意管理员收录用于 KMS 激活服务（不会公开我的地址）</span>
      </label>
      <div class="cf-turnstile" data-sitekey="${htmlEscape(siteKey)}" data-theme="dark" style="margin-top:16px"></div>
      <button onclick="doSubmit()">提交投稿</button>
      <div id="msg" style="margin-top:14px;font-size:.88rem"></div>
      <div class="hint">投稿信息仅管理员可见。通过验证后系统会自动分配备用线路域名，你的真实地址不会公开。投稿记录（含提交时的 IP）保留 30 天后自动删除。</div>
      <a class="back" href="https://ikms.eu.org">← 返回 iKMS 首页</a>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <script>
      async function doSubmit(){
        var b=document.getElementById('msg');
        var host=document.getElementById('host').value.trim();
        var agree=document.getElementById('agree').checked;
        if(!host){b.innerHTML='<span class="err">请填写服务器地址</span>';return}
        if(!agree){b.innerHTML='<span class="err">请先勾选授权确认</span>';return}
        var tsInput=document.querySelector('[name="cf-turnstile-response"]');
        var token=tsInput?tsInput.value:'';
        if(!token){b.innerHTML='<span class="err">请先完成人机验证</span>';return}
        b.innerHTML='提交中…';
        try{
          var r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({host:host,note:document.getElementById('note')?document.getElementById('note').value:'',turnstile:token})});
          var j=await r.json();
          b.innerHTML='<span class="'+(j.ok?'ok':'err')+'">'+j.msg+'</span>';
          if(window.turnstile) window.turnstile.reset();
        }catch(e){b.innerHTML='<span class="err">网络错误，请重试</span>'}
      }
      </script>`);
  }

  /* ---- 提交 API ---- */
  if (url.pathname === '/api/submit' && request.method === 'POST') {
    if (!kvReady(env)) {
      console.error('submit: KV binding KMS_SUBMISSIONS missing');
      return json({ ok: false, msg: '服务暂时不可用，请稍后重试' }, 503);
    }

    const body = await readJson(request);
    if (!body) return json({ ok: false, msg: '请求格式错误' }, 400);

    const norm = normalizeHost(body.host);
    if (!norm) return json({ ok: false, msg: '服务器地址格式无效或为内网/环回地址' }, 400);

    const rate = await rateStatus(env, 'submit', ip);
    if (rate.used >= rate.limit) {
      return json({ ok: false, msg: '今日投稿次数已达上限（5 条），请明日再试' }, 429,
        { 'Retry-After': String(retryAfterSeconds()) });
    }

    const ts = await verifyTurnstile(env, String(body.turnstile || ''), ip);
    if (!ts.ok) {
      console.error('submit: turnstile failed', ts.reason);
      return json({ ok: false, msg: '人机验证未通过，请刷新页面后重试' }, 403);
    }

    /* 查重：已存在相同 host:port 的待审核投稿 */
    const existing = await listSubmissions(env);
    if (existing.some(s => s.status === 'pending' && s.host === norm.host && s.port === norm.port)) {
      return json({ ok: false, msg: '该地址已有待审核的投稿，请等待管理员处理' }, 409);
    }

    const sub = {
      id: crypto.randomUUID(),
      host: norm.host,
      port: norm.port,
      note: String(body.note || '').slice(0, 200),
      ip,
      ts: new Date().toISOString(),
      status: 'pending',
    };
    await env.KMS_SUBMISSIONS.put('sub:' + sub.id, JSON.stringify(sub), { expirationTtl: RETENTION_TTL });
    await rateCommit(env, rate);
    return json({ ok: true, msg: '投稿已提交，等待管理员审核' });
  }

  /* ---- 站点留言（弹窗表单 → Resend 转发到管理员邮箱） ---- */
  if (url.pathname === '/api/contact' && request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env, request.headers.get('Origin') || '') });
  }
  if (url.pathname === '/api/contact' && request.method === 'POST') {
    const cors = corsHeaders(env, request.headers.get('Origin') || '');
    const cjson = (obj, status = 200, extra = {}) =>
      new Response(JSON.stringify(obj), { status, headers: { ...JSON_H, ...cors, ...extra } });

    if (!env.RESEND_API_KEY) {
      console.error('contact: RESEND_API_KEY missing');
      return cjson({ ok: false, msg: '留言功能暂时不可用，请直接写信到 admin@ikms.eu.org' }, 503);
    }
    if (!kvReady(env)) {
      console.error('contact: KV binding KMS_SUBMISSIONS missing');
      return cjson({ ok: false, msg: '留言功能暂时不可用，请直接写信到 admin@ikms.eu.org' }, 503);
    }

    const body = await readJson(request);
    if (!body) return cjson({ ok: false, msg: '请求格式错误' }, 400);

    /* 蜜罐字段：机器人会填，人看不到 */
    if (body.website) return cjson({ ok: true, msg: '留言已发送' });

    const rate = await rateStatus(env, 'contact', ip);
    if (rate.used >= rate.limit) {
      return cjson({ ok: false, msg: '今日留言次数已达上限（5 条），请明日再试' }, 429,
        { 'Retry-After': String(retryAfterSeconds()) });
    }

    /* Turnstile 人机验证（服务端复核，token 一次性） */
    const ts = await verifyTurnstile(env, String(body.turnstile || ''), ip);
    if (!ts.ok) {
      console.error('contact: turnstile failed', ts.reason);
      return cjson({ ok: false, msg: '人机验证未通过，请刷新页面后重试' }, 403);
    }

    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 5000);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return cjson({ ok: false, msg: '请填写有效的邮箱地址' }, 400);
    }
    if (!message) {
      return cjson({ ok: false, msg: '请填写留言内容' }, 400);
    }

    const subject = ('[iKMS 留言] ' + (name || email.split('@')[0])).replace(/[\r\n]+/g, ' ');
    const text = [
      '来自 iKMS 站点留言弹窗：',
      '',
      '称呼：' + (name || '（未填写）'),
      '邮箱：' + email,
      'IP：' + ip,
      '时间：' + new Date().toISOString(),
      '',
      '— — —',
      '',
      message,
    ].join('\n');

    let sendRes;
    try {
      sendRes = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.CONTACT_FROM || 'iKMS 留言 <noreply@subit.us.mw>',
          to: [env.CONTACT_TO || 'admin@ikms.eu.org'],
          reply_to: email,
          subject,
          text,
        }),
      }, 10000, 1);
    } catch {
      console.error('contact: resend request failed');
      return cjson({ ok: false, msg: '发送失败，请直接写信到 admin@ikms.eu.org' }, 502);
    }
    if (!sendRes.ok) {
      /* 只记录状态码，避免日志泄露收件人/邮件内容 */
      console.error('contact: resend status', sendRes.status);
      return cjson({ ok: false, msg: '发送失败，请直接写信到 admin@ikms.eu.org' }, 502);
    }

    await rateCommit(env, rate);
    return cjson({ ok: true, msg: '留言已发送，管理员会回信到你的邮箱' });
  }

  /* ---- 管理员登录 ---- */
  if (url.pathname === '/admin/login' && request.method === 'POST') {
    if (!env.ADMIN_KEY) {
      console.error('admin: ADMIN_KEY missing');
      return html('iKMS · 服务暂时不可用', '<h1>服务暂时不可用</h1><p>请稍后重试。</p>', { 'Cache-Control': 'no-store' });
    }
    const contentType = request.headers.get('Content-Type') || '';
    let key = '';
    if (contentType.includes('application/json')) {
      const body = await readJson(request);
      key = String((body && body.key) || '');
    } else {
      const form = await request.formData().catch(() => null);
      key = String((form && form.get('key')) || '');
    }
    if (!safeEqual(key, env.ADMIN_KEY)) {
      return loginPage('密钥错误，请重试', 403);
    }
    const token = await adminToken(env);
    return new Response(null, {
      status: 303,
      headers: {
        ...HTML_H,
        'Location': '/admin',
        'Set-Cookie': `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_MAX_AGE}`,
      },
    });
  }

  /* ---- 管理员查看 ---- */
  if (url.pathname === '/admin' && request.method === 'GET') {
    if (!(await isAdmin(request, env))) return loginPage();
    if (!kvReady(env)) {
      console.error('admin: KV binding KMS_SUBMISSIONS missing');
      return html('iKMS · 服务暂时不可用', '<h1>服务暂时不可用</h1><p>请稍后重试。</p>');
    }
    const submissions = await listSubmissions(env);
    const htmlRows = submissions.map(s =>
      `<div style="border:1px solid rgba(148,163,190,.2);border-radius:10px;padding:14px;margin-bottom:10px">` +
      `<div style="display:flex;justify-content:space-between;align-items:center"><strong>${htmlEscape(s.host)}:${htmlEscape(s.port)}</strong>` +
      `<span style="color:${s.status === 'pending' ? '#fbbf24' : s.status === 'approved' ? '#34d399' : '#f87171'}">${htmlEscape(s.status)}</span></div>` +
      `<div style="color:#6e7a94;font-size:.78rem;margin:4px 0">IP: ${htmlEscape(s.ip)} | ${htmlEscape(s.ts)}</div>` +
      (s.note ? `<div style="color:#a3adc4;font-size:.82rem">${htmlEscape(s.note)}</div>` : '') +
      (s.status === 'pending' ? `<div style="margin-top:8px;display:flex;gap:8px">` +
        `<button onclick="approve('${htmlEscape(s.id)}')" style="width:auto;margin:0;padding:6px 14px;background:#059669;font-size:.8rem">收录</button>` +
        `<button onclick="reject('${htmlEscape(s.id)}')" style="width:auto;margin:0;padding:6px 14px;background:#dc2626;font-size:.8rem">拒绝</button></div>` : '') +
      (s.result ? `<div style="margin-top:6px;font-size:.8rem;color:${s.result === 'collected' ? '#34d399' : '#f87171'}">${htmlEscape(s.result)}</div>` : '') +
      `</div>`).join('');
    return html('iKMS · 管理员审核', `
      <h1>投稿审核</h1><p>共 ${submissions.length} 条投稿。记录保留 30 天后自动删除。</p>
      ${submissions.length ? htmlRows : '<p style="color:#6e7a94">暂无投稿</p>'}
      <script>
      async function act(id, action){
        var r=await fetch('/api/admin/action',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({id:id,action:action}),credentials:'same-origin'});
        var j=await r.json();
        if(j.ok){location.reload()}else{alert(j.msg||'操作失败')}
      }
      function approve(id){act(id,'approve')}
      function reject(id){act(id,'reject')}
      </script>`);
  }

  /* ---- 管理员操作（HttpOnly Cookie 鉴权） ---- */
  if (url.pathname === '/api/admin/action' && request.method === 'POST') {
    if (!(await isAdmin(request, env))) {
      return json({ ok: false, msg: '未登录或会话已过期，请重新登录' }, 401);
    }
    if (!kvReady(env)) {
      console.error('admin action: KV binding KMS_SUBMISSIONS missing');
      return json({ ok: false, msg: '服务暂时不可用，请稍后重试' }, 503);
    }
    const body = await readJson(request);
    if (!body) return json({ ok: false, msg: '请求格式错误' }, 400);
    const { id, action } = body;
    const key = 'sub:' + String(id || '');
    const sub = safeJson(await env.KMS_SUBMISSIONS.get(key), null);
    if (!sub) return json({ ok: false, msg: '投稿不存在' }, 404);

    if (action === 'approve' && sub.status === 'pending') {
      if (!env.GH_TOKEN || !env.GITHUB_REPOSITORY) {
        console.error('admin action: GH_TOKEN or GITHUB_REPOSITORY missing');
        return json({ ok: false, msg: '收录功能暂时不可用，请稍后重试', retryable: true }, 502);
      }
      let ghRes;
      try {
        ghRes = await fetchWithTimeout(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`, {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            /* GitHub REST API 强制要求 User-Agent，缺失会直接返回 403
               （Request forbidden by administrative rules）；Workers 的 fetch 不会自动附带 */
            'User-Agent': 'ikms-private-submit-worker',
            'Authorization': `Bearer ${env.GH_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: 'kms-private-submit',
            client_payload: {
              host: sub.host,
              port: sub.port,
              source: 'private submission',
            },
          }),
        }, 10000, 1);
      } catch {
        console.error('admin action: github request failed');
        return json({ ok: false, msg: '收录触发失败，请稍后重试', retryable: true }, 502);
      }
      if (!ghRes.ok) {
        console.error('admin action: github status', ghRes.status);
        /* 不修改投稿状态，管理员可重复点击重试 */
        return json({ ok: false, msg: '收录触发失败，请稍后重试', retryable: true }, 502);
      }
      sub.status = 'approved';
      sub.approved_at = new Date().toISOString();
      await env.KMS_SUBMISSIONS.put(key, JSON.stringify(sub), { expirationTtl: RETENTION_TTL });
      return json({ ok: true, msg: '已触发收录' });
    }

    if (action === 'reject' && sub.status === 'pending') {
      sub.status = 'rejected';
      sub.rejected_at = new Date().toISOString();
      await env.KMS_SUBMISSIONS.put(key, JSON.stringify(sub), { expirationTtl: RETENTION_TTL });
      return json({ ok: true, msg: '已拒绝' });
    }

    return json({ ok: false, msg: '无效操作' }, 400);
  }

  return new Response('Not Found', { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      /* 统一兜底，避免未捕获异常直接变成 Cloudflare 1101 页面 */
      console.error('worker unhandled error:', (err && err.message) || 'unknown');
      const url = new URL(request.url);
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return html('iKMS · 服务暂时不可用', '<h1>服务暂时不可用</h1><p>请稍后重试。</p>');
      }
      return json({ ok: false, msg: '服务暂时不可用，请稍后重试' }, 500);
    }
  },
};
