# iKMS 私密投稿 Worker

Cloudflare Worker，为不愿公开服务器地址的投稿者提供私密投稿表单。

## 功能

- 投稿者提交服务器地址 → 存入 KV（仅管理员可见）→ 管理员在 `/admin?key=ADMIN_KEY` 审核
- 审核通过后 Worker 自动触发 GitHub `repository_dispatch`（`kms-private-submit`）
- CI 收录到加密候选池（`data/candidates.enc`），真实地址不公开
- 内置限流（每 IP 每日 5 条）和查重

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

### 8. GitHub 侧

确保仓库已配置 `CANDIDATES_SECRET`（Secrets → Actions），CI 收录工作流 `kms-private-submit.yml` 会自动把通过审核的投稿写入加密候选池。

## 文件

- `worker.js`：Worker 源码（ES Module 格式）
- `wrangler.toml.example`：如需使用 Wrangler CLI 部署，复制为 `wrangler.toml` 并填写对应值
