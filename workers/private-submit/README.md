# iKMS 私密投稿 Worker

Cloudflare Worker，为不愿公开服务器地址的投稿者提供私密投稿表单。

## 功能

- 投稿者提交服务器地址 → 存入 KV（仅管理员可见）→ 管理员在 `/admin?key=ADMIN_KEY` 审核
- 审核通过后 Worker 自动触发 GitHub `repository_dispatch`（`kms-private-submit`）
- CI 收录到加密候选池（`data/candidates.enc`），真实地址不公开
- 站点留言弹窗：全站信封图标 → `/api/contact` → Resend 免费发信转发到 admin@ikms.eu.org
- 内置限流（投稿与留言各每 IP 每日 5 条）和查重

## 部署步骤

### 1. 创建 KV namespace

Cloudflare 面板 → Workers & Pages → KV → Create a namespace → 名称 `KMS_SUBMISSIONS`

### 2. 创建 Worker

Workers & Pages → Create → Worker → 命名 `private-submit` → 粘贴 `worker.js` 代码 → Deploy

### 3. 绑定 KV

Worker → Settings → Variables → KV Namespace Bindings：

- Variable name: `KMS_SUBMISSIONS` → KV namespace: `KMS_SUBMISSIONS`

### 4. 配置 Secrets

Worker → Settings → Variables → Environment Variables（加密）：

| 变量名 | 值 | 说明 |
|---|---|---|
| `ADMIN_KEY` | 自定义随机字符串（≥ 16 字符） | 管理员审核页面密钥 |
| `GITHUB_TOKEN` | Fine-grained PAT（Contents: Read and write，限定本仓库） | 触发 repository_dispatch |
| `RESEND_API_KEY` | Resend API Key（`re_` 开头） | 站点留言弹窗发信（免费 100 封/天、3000 封/月） |

可选 Vars（留言发件/收件）：

| 变量名 | 值 | 说明 |
|---|---|---|
| `CONTACT_FROM` | `iKMS 留言 <noreply@ikms.eu.org>` | 发件人显示；需先在 Resend 验证 ikms.eu.org 域名 |
| `CONTACT_TO` | `admin@ikms.eu.org` | 收件地址（默认即此） |

> **Resend 配置**：resend.com 注册 → API Keys 创建（`re_` 开头）→ Domains 添加
> `ikms.eu.org` 并按提示在 Cloudflare DNS 加 SPF/DKIM 记录。未验证域名前，
> `CONTACT_FROM` 用默认的 `onboarding@resend.dev` 只能发给你注册 Resend 用的邮箱；
> 验证域名后即可发给任意地址。留言的 `reply_to` 自动设为留言者的邮箱，直接回复即可回信。

### 5. 配置 Vars

| 变量名 | 值 |
|---|---|
| `GITHUB_REPOSITORY` | `iougemini/iougemini.github.io` |

### 6. 绑定自定义域名

Worker → Settings → Domains & Routes → Add → Custom domain → `submit.ikms.eu.org`

（需提前在 Cloudflare DNS 添加该子域的 A 记录或 CNAME，任意值即可，Worker 域名会接管）

### 7. 使用

- 投稿表单：`https://submit.ikms.eu.org`
- 管理员审核：`https://submit.ikms.eu.org/admin?key=<ADMIN_KEY>`
- 站点留言：全站右下角信封图标（或页脚「反馈邮箱」）→ 弹窗提交 → Resend 转发到管理员邮箱
  - Worker 未部署/未配置 Resend 时，弹窗自动降级为 mailto 兜底，不影响使用

### 8. GitHub 侧

确保仓库已配置 `CANDIDATES_SECRET`（Secrets → Actions），CI 收录工作流 `kms-private-submit.yml` 会自动把通过审核的投稿写入加密候选池。

## 文件

- `worker.js`：Worker 源码（ES Module 格式）
- `wrangler.toml.example`：如需使用 Wrangler CLI 部署，复制为 `wrangler.toml` 并填写对应值
