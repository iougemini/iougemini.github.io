# 高仿v0v的KMS服务

- [IKMS](https://ikms.eu.org)
- 投稿 KMS 服务器：https://github.com/iougemini/iougemini.github.io/issues/new?template=kms-server.yml

## 自动化说明（v2.1）

本站备用线路与主线路负载均衡由 GitHub Actions 全自动维护，无需人工干预：

```
issue 投稿 ──vlmcs 真实验证──▶ 候选池（data/servers.json）
                                     │
巡检机器人（每 30 分钟）──────────────┤
  1. 检测全部线路（协议验证 + TCP 延迟）  │
  2. 连续 3 次失效的线路 ←── 自动顶替 ◀──┘
  3. 主线路 s.ikms.eu.org 负载均衡：按延迟择优 5 台写入 DNS A 记录
```

- `data/servers.json`：线路与候选池的唯一数据源，`more.html` / `status.html` 页面动态渲染
- `data/history.json`：逐日可用性历史（由巡检自动维护，状态翻转或跨天才产生提交）
- `.github/workflows/kms-health.yml`：每 30 分钟巡检，状态变更自动提交
- `.github/workflows/kms-issue.yml`：issue 投稿自动验证、收录并回复结果
- `scripts/update-dns.mjs`：主线路负载均衡（Cloudflare DNS API）

### 必需的仓库配置（一次性）

1. **Settings → Actions → General → Workflow permissions** 选择 *Read and write permissions*（巡检需要提交数据文件）；
2. 若需启用主线路 DNS 负载均衡，在 **Settings → Secrets and variables → Actions** 添加：
   - `CLOUDFLARE_API_TOKEN`：权限 `Zone → DNS → Edit`，区域限定 `ikms.eu.org`
   - `CLOUDFLARE_ZONE_ID`：Cloudflare 域名概览页右侧可见
   - 注意：`s.ikms.eu.org` 的 A 记录必须为 **DNS only**（灰云），Cloudflare 代理不支持 1688 端口。未配置密钥时巡检正常运行，仅跳过 DNS 更新。

### 手动触发

Actions 页面选择 **KMS 线路巡检 → Run workflow** 可立即执行一次巡检。
