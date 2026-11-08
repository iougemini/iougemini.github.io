# iKMS 私密投稿 Worker

Cloudflare Worker，为不愿公开服务器地址的投稿者提供私密投稿表单。

## 功能

- 投稿者提交服务器地址 → 存入 KV（仅管理员可见）→ 管理员登录 `/admin` 审核
- 投稿成功后会向管理员发一封提醒邮件（复用 Resend；收件人取 `CONTACT_TO`，缺省 `admin@ikms.eu.org`；发信失败不影响投稿）
- 审核通过后 Worker 自动触发 GitHub `repository_dispatch`（`kms-private-submit`）
- CI 收录到加密候选池（`data/candidates.enc`），真实地址不公开
- 站点留言弹窗：全站信封图标 → `/api/contact` → Resend 免费发信转发到 admin@ikms.eu.org
- 投稿与留言均需 Turnstile 人机验证；限流按 IPv4 `/24`、IPv6 `/64` 每网段每日 5 条
- 投稿记录保留 30 天，由 KV `expirationTtl` 自动删除

## 目录

- `worker.js`：Worker 源码（ES Module）
- `wrangler.toml.example`：Wrangler 配置模板（复制为 `wrangler.toml` 并填写 KV id）
- `.dev.vars.example`：本地开发变量模板（复制为 `.dev.vars`）
- `test/smoke.mjs`：不依赖网络的最小冒烟测试（23 项）
- `package.json`：固定 `wrangler` 版本，提供 `npm test` / `npm run dry-run`

## 部署前检查清单

| 需要准备 | 说明 |
|---|---|
| Cloudflare 账号 + 该域名所在 Zone | `ikms.eu.org` 需在同一账号下，才能绑定 `submit.ikms.eu.org` |
| KV namespace | `npx wrangler kv namespace create KMS_SUBMISSIONS`，记录返回的 `id` |
| `ADMIN_KEY` | 自定义随机串，≥ 16 字符（`openssl rand -hex 16`） |
| `GH_TOKEN` | GitHub Fine-grained PAT，权限 `Contents: Read and write`，仅限 `iougemini/iougemini.github.io` |
| `RESEND_API_KEY` | Resend API Key（`re_` 开头）；不配置时留言接口返回 503，前端自动降级 mailto |
| `TURNSTILE_SECRET` | Turnstile 服务端密钥（`0x4AAAAAAF...`），必填 |
| Turnstile 站点密钥 | 与 `assets/main.js` 中一致；如需自定义，设置 `TURNSTILE_SITE_KEY` 变量。**主机名白名单需包含 `ikms.eu.org`、`www.ikms.eu.org` 与 `submit.ikms.eu.org`**（投稿表单在 submit 子域渲染 widget） |
| GitHub Actions Secret | `CANDIDATES_SECRET`（仓库 Secrets → Actions），供 `kms-private-submit.yml` 写入加密候选池 |
| Resend 发信域名 | **有意为之**：`subit.us.mw` 已验证用于发信；`.eu.org` 免费域名无法通过 Resend 域名校验，因此发件域与站点域名不同属设计选择，不是缺陷 |

## 部署步骤（Wrangler，推荐）

```bash
cd workers/private-submit
npm install
cp wrangler.toml.example wrangler.toml
# 编辑 wrangler.toml：把 <YOUR_KV_NAMESPACE_ID> 换成上一步拿到的 id
npx wrangler kv namespace create KMS_SUBMISSIONS
npx wrangler secret put ADMIN_KEY
npx wrangler secret put GH_TOKEN
npx wrangler secret put RESEND_API_KEY       # 可选
npx wrangler secret put TURNSTILE_SECRET
npx wrangler deploy
```

本地校验（不访问线上、不改任何数据）：

```bash
cp .dev.vars.example .dev.vars   # 填入测试值
npm test                         # 冒烟测试，无需网络
npm run dry-run                  # wrangler 打包 + 配置校验（不部署）
npx wrangler dev                 # 本地起服务，访问 http://localhost:8787
```

CI：`.github/workflows/kms-worker-ci.yml` 会在修改 `workers/private-submit/**` 时自动跑
语法检查、`npm test` 和 `wrangler deploy --dry-run`。

## 面板部署（备用）

1. Cloudflare 面板 → Workers & Pages → KV → Create namespace：`KMS_SUBMISSIONS`
2. Workers & Pages → Create → Worker → 命名 `private-submit` → 粘贴 `worker.js` → Deploy
3. Settings → Variables → KV Namespace Bindings：`KMS_SUBMISSIONS` → 对应 namespace
4. Settings → Variables → Environment Variables（加密）配置上表 Secrets
5. Settings → Variables → 明文变量：`GITHUB_REPOSITORY = iougemini/iougemini.github.io`
6. Settings → Domains & Routes → Add → Custom domain → `submit.ikms.eu.org`
7. 重新 Deploy 使绑定生效

> 缺少 KV 绑定或 Secret 时，接口会返回 503 JSON 而不是 1101 崩溃页；日志中只记录状态码与配置项名称，不记录地址与邮箱。

## 使用

- 投稿表单：`https://submit.ikms.eu.org`
- 管理员审核：`https://submit.ikms.eu.org/admin`（首次打开是登录页，密钥通过 POST 提交并写入 HttpOnly Cookie，不会出现在 URL、历史记录或 Referer 中；会话 8 小时）
- 站点留言：全站右下角信封图标（或页脚「反馈邮箱」）→ 弹窗提交 → Resend 转发到管理员邮箱
  - Worker 未部署/未配置 Resend 时，弹窗自动降级为 mailto 兜底，不影响使用

## 数据与隐私

- KV key 布局：`sub:<完整UUID>`（每条投稿独立 key，避免并发读改写丢数据）、`rl:<类型>:<网段>:<日期>`（限流计数）
- 投稿记录（含提交者 IP）保留 30 天后自动过期；审核页仅管理员可见
- 公开仓库的 Actions 日志不打印投稿地址/IP；`data/servers.json` 由 `saveData()` 统一脱敏
- GitHub dispatch 的 `client_payload.source` 固定为 `private submission`，不含 IP
