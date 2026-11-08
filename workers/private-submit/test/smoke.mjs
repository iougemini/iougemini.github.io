/* 最小冒烟测试：不依赖 wrangler / 网络，直接调用 Worker 的 fetch。
   覆盖：页面渲染、参数校验、Turnstile、限流、KV 存取、管理员登录与会话、审核动作、CORS、错误兜底。 */
import assert from 'node:assert/strict';
import worker from '../worker.js';

const BASE = 'https://submit.ikms.eu.org';

function mockKV() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = keys.slice(start, start + limit);
      return {
        keys: slice.map(name => ({ name })),
        list_complete: start + slice.length >= keys.length,
        cursor: String(start + slice.length),
      };
    },
  };
}

let upstreamCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  upstreamCalls.push({ url: u, opts });
  if (u.includes('challenges.cloudflare.com')) {
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('api.resend.com')) {
    return new Response(JSON.stringify({ id: 'mail-ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('api.github.com')) {
    return new Response(null, { status: 204 });
  }
  return new Response('', { status: 404 });
};

function makeEnv(overrides = {}) {
  return {
    ADMIN_KEY: 'test-admin-key-0123456789',
    KMS_SUBMISSIONS: mockKV(),
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    GITHUB_REPOSITORY: 'iougemini/iougemini.github.io',
    GH_TOKEN: 'ghp_test',
    RESEND_API_KEY: 're_test',
    ...overrides,
  };
}

function call(env, path, { method = 'GET', body, headers = {}, ip = '198.51.100.10' } = {}) {
  const h = { 'CF-Connecting-IP': ip, ...headers };
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') payload = body;
    else {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
  }
  return worker.fetch(new Request(BASE + path, { method, headers: h, body: payload }), env);
}

async function login(env, key = env.ADMIN_KEY) {
  const res = await call(env, '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key }).toString(),
  });
  return res;
}

async function run() {
  const env = makeEnv();
  const passed = [];
  const check = async (name, fn) => {
    await fn();
    passed.push(name);
    console.log('  ✓', name);
  };

  await check('GET / 渲染投稿表单（含 Turnstile）', async () => {
    const res = await call(env, '/');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /cf-turnstile/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  await check('POST /api/submit 合法地址 → 200 并写独立 KV key', async () => {
    const res = await call(env, '/api/submit', {
      method: 'POST',
      body: { host: 'kms.example.com', note: 'test', turnstile: 'tok' },
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    const list = await env.KMS_SUBMISSIONS.list({ prefix: 'sub:' });
    assert.equal(list.keys.length, 1);
    const stored = JSON.parse(await env.KMS_SUBMISSIONS.get(list.keys[0].name));
    assert.equal(stored.id.length, 36);
    assert.equal(stored.status, 'pending');
  });

  await check('重复投稿 → 409', async () => {
    const res = await call(env, '/api/submit', {
      method: 'POST',
      body: { host: 'kms.example.com', turnstile: 'tok' },
    });
    assert.equal(res.status, 409);
  });

  await check('内网地址 → 400', async () => {
    const res = await call(env, '/api/submit', {
      method: 'POST',
      body: { host: '10.0.0.5', turnstile: 'tok' },
    });
    assert.equal(res.status, 400);
  });

  await check('缺少 Turnstile token → 403 且不暴露内部原因', async () => {
    const res = await call(env, '/api/submit', {
      method: 'POST',
      body: { host: 'kms2.example.com' },
      ip: '203.0.113.20',
    });
    assert.equal(res.status, 403);
    const j = await res.json();
    assert.equal(j.msg.includes('token-missing'), false);
  });

  await check('投稿成功 → 发一次提醒邮件（收件人 admin@ikms.eu.org，不含投稿者 IP）', async () => {
    const env2 = makeEnv();
    upstreamCalls = [];
    const res = await call(env2, '/api/submit', {
      method: 'POST',
      body: { host: 'notify.example.com', note: '机密备注', turnstile: 'tok' },
      ip: '198.51.100.99',
    });
    assert.equal(res.status, 200);
    const mail = upstreamCalls.filter(c => c.url.includes('api.resend.com'));
    assert.equal(mail.length, 1);
    const payload = JSON.parse(mail[0].opts.body);
    assert.deepEqual(payload.to, ['admin@ikms.eu.org']);
    assert.match(payload.text, /notify\.example\.com:1688/);
    assert.match(payload.text, /\+08:00/);
    assert.match(payload.text, /https:\/\/submit\.ikms\.eu\.org\/admin/);
    assert.equal(payload.text.includes('198.51.100.99'), false);
    assert.equal(payload.text.includes('机密备注'), false);
  });

  await check('邮件接口失败 → 投稿仍返回 200', async () => {
    const env3 = makeEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes('api.resend.com')) return new Response('boom', { status: 500 });
      return realFetch(url, opts);
    };
    const res = await call(env3, '/api/submit', {
      method: 'POST',
      body: { host: 'mailfail.example.com', turnstile: 'tok' },
      ip: '198.51.100.100',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    const list2 = await env3.KMS_SUBMISSIONS.list({ prefix: 'sub:' });
    assert.equal(list2.keys.length, 1);
    globalThis.fetch = realFetch;
  });

  await check('未配置 RESEND_API_KEY → 跳过发信且投稿 200', async () => {
    const env4 = makeEnv({ RESEND_API_KEY: undefined });
    upstreamCalls = [];
    const res = await call(env4, '/api/submit', {
      method: 'POST',
      body: { host: 'nomail.example.com', turnstile: 'tok' },
      ip: '198.51.100.101',
    });
    assert.equal(res.status, 200);
    assert.equal(upstreamCalls.filter(c => c.url.includes('api.resend.com')).length, 0);
  });

  await check('每日限流（校验通过后计数）→ 第 6 条 429 + Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await call(env, '/api/submit', {
        method: 'POST',
        body: { host: `rate${i}.example.com`, turnstile: 'tok' },
        ip: '203.0.113.30',
      });
      assert.equal(res.status, 200);
    }
    const res = await call(env, '/api/submit', {
      method: 'POST',
      body: { host: 'rate-over.example.com', turnstile: 'tok' },
      ip: '203.0.113.30',
    });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  });

  await check('同一 /24 前缀共享限流（换 IP 不能绕过）', async () => {
    const res = await call(env, '/api/submit', {
      method: 'POST',
      body: { host: 'rate-prefix.example.com', turnstile: 'tok' },
      ip: '203.0.113.45',
    });
    assert.equal(res.status, 429);
  });

  await check('缺少 KV 绑定 → 503（不再 1101）', async () => {
    const noKv = makeEnv({ KMS_SUBMISSIONS: undefined });
    const res = await call(noKv, '/api/submit', {
      method: 'POST',
      body: { host: 'kms.example.com', turnstile: 'tok' },
    });
    assert.equal(res.status, 503);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.equal(j.msg.includes('KMS_SUBMISSIONS'), false);
  });

  await check('GET /admin 未登录 → 登录页（地址栏无密钥）', async () => {
    const res = await call(env, '/admin');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /\/admin\/login/);
    assert.match(text, /type="password"/);
  });

  await check('错误密钥登录 → 403', async () => {
    const res = await login(env, 'wrong-key-000000');
    assert.equal(res.status, 403);
  });

  let cookie = '';
  await check('正确密钥登录 → 303 + HttpOnly Cookie', async () => {
    const res = await login(env);
    assert.equal(res.status, 303);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(';')[0];
  });

  await check('携带 Cookie 查看审核页 → 200 且含投稿地址', async () => {
    const res = await call(env, '/admin', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /kms\.example\.com/);
  });

  await check('未携带 Cookie 调用审核接口 → 401', async () => {
    const res = await call(env, '/api/admin/action', {
      method: 'POST',
      body: { id: 'none', action: 'reject' },
    });
    assert.equal(res.status, 401);
  });

  const list = await env.KMS_SUBMISSIONS.list({ prefix: 'sub:' });
  const first = JSON.parse(await env.KMS_SUBMISSIONS.get(list.keys.find(k => k.name) ? list.keys[0].name : ''));

  await check('拒绝投稿 → 200 且状态落 KV', async () => {
    const res = await call(env, '/api/admin/action', {
      method: 'POST',
      body: { id: first.id, action: 'reject' },
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const stored = JSON.parse(await env.KMS_SUBMISSIONS.get('sub:' + first.id));
    assert.equal(stored.status, 'rejected');
  });

  await check('收录投稿 → 触发 GitHub dispatch 并置为 approved', async () => {
    const submit = await call(env, '/api/submit', {
      method: 'POST',
      body: { host: 'approve.example.com', turnstile: 'tok' },
      ip: '192.0.2.50',
    });
    assert.equal(submit.status, 200);
    const sub = [...env.KMS_SUBMISSIONS.store.entries()].find(([, v]) => v.includes('approve.example.com'));
    const id = JSON.parse(sub[1]).id;
    upstreamCalls = [];
    const res = await call(env, '/api/admin/action', {
      method: 'POST',
      body: { id, action: 'approve' },
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    assert.ok(upstreamCalls.some(c => c.url.includes('api.github.com')));
    const dispatch = upstreamCalls.find(c => c.url.includes('api.github.com'));
    const payload = JSON.parse(dispatch.opts.body);
    assert.equal(payload.client_payload.source, 'private submission');
    assert.equal(payload.client_payload.host, 'approve.example.com');
    const stored = JSON.parse(await env.KMS_SUBMISSIONS.get('sub:' + id));
    assert.equal(stored.status, 'approved');
  });

  await check('GitHub 失败 → 502 retryable 且状态保持 pending', async () => {
    const env3 = makeEnv({ GH_TOKEN: undefined });
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.github.com')) return new Response(null, { status: 502 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    const loginRes = await login(env3);
    const c3 = loginRes.headers.get('set-cookie').split(';')[0];
    const sub = await call(env3, '/api/submit', {
      method: 'POST', body: { host: 'ghfail.example.com', turnstile: 'tok' }, ip: '192.0.2.60',
    });
    assert.equal(sub.status, 200);
    const entry = [...env3.KMS_SUBMISSIONS.store.entries()].find(([, v]) => v.includes('ghfail.example.com'));
    const id = JSON.parse(entry[1]).id;
    const res = await call(env3, '/api/admin/action', {
      method: 'POST', body: { id, action: 'approve' }, headers: { Cookie: c3 },
    });
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.equal(j.retryable, true);
    assert.equal(JSON.parse(await env3.KMS_SUBMISSIONS.get('sub:' + id)).status, 'pending');
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('challenges.cloudflare.com')) return new Response(JSON.stringify({ success: true }), { status: 200 });
      if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
      if (u.includes('api.github.com')) return new Response(null, { status: 204 });
      return new Response('', { status: 404 });
    };
  });

  await check('留言：允许来源 → 200 + ACAO + Vary: Origin', async () => {
    const res = await call(env, '/api/contact', {
      method: 'POST',
      headers: { Origin: 'https://ikms.eu.org' },
      body: { name: '访客', email: 'visitor@example.com', message: 'hello', turnstile: 'tok' },
      ip: '192.0.2.70',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://ikms.eu.org');
    assert.equal(res.headers.get('vary'), 'Origin');
  });

  await check('留言：非白名单来源不返回 ACAO', async () => {
    const res = await call(env, '/api/contact', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
      body: { name: 'x', email: 'x@example.com', message: 'hi', turnstile: 'tok' },
      ip: '192.0.2.80',
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  await check('留言：蜜罐字段直接返回成功（不发信）', async () => {
    upstreamCalls = [];
    const res = await call(env, '/api/contact', {
      method: 'POST',
      headers: { Origin: 'https://ikms.eu.org' },
      body: { name: 'bot', email: 'bot@example.com', message: 'spam', website: 'http://spam' },
      ip: '192.0.2.90',
    });
    assert.equal(res.status, 200);
    assert.equal(upstreamCalls.length, 0);
  });

  await check('未知路由 → 404', async () => {
    const res = await call(env, '/api/unknown');
    assert.equal(res.status, 404);
  });

  console.log(`\n冒烟测试全部通过：${passed.length} 项`);
}

run().catch(err => {
  console.error('\n冒烟测试失败：', err);
  process.exit(1);
});
