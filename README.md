# 🌲 Tree of Threads 🪡

基于 Cloudflare Workers 的 AI 聊天系统。灵感来自 Tree of Thoughts — 将对话组织为不断生长、分叉、折叠的认知树。核心特性：**markdown 分支聊天** ，用户可以沿着不同方向深入探索。适合ADHD宝宝


一开始想叫 DAG, scatter/gather，fork 什么的。后来觉得 ToT 缩写好记就换这个了。


## 快速开始

```bash
npm install
npm run dev
```

访问 `http://localhost:8787`。

### 配置 AI 供应商

1. 打开 `/providers.html`（侧边栏齿轮图标）
2. 输入 API endpoint（如 `https://api.openai.com/v1/chat/completions`）
3. 系统自动探测可用模型
4. 选择模型保存

### D1 数据库

本地开发使用 wrangler 内置的 D1。首次运行需要建表：

```bash
npx wrangler d1 execute tot-db --local --file src/db/schema.sql
```

生产环境部署时同样需要：

```bash
npx wrangler d1 execute tot-db --remote --file src/db/schema.sql
```

### Passkey 登录

系统使用 Passkey (WebAuthn) 认证，无密码。在 `/login` 页面输入邮箱注册即可。

## 目录结构

- `src` 后端
- `public` 前端


## 设计决策

所有架构决策记录在 `docs/ADR/` 目录下。核心决策：

| ADR | 主题 |
|-----|------|
| [009](docs/ADR/009.chat.tree-structure.md) | 聊天数据结构：树 |
| [010](docs/ADR/010.chat.focus-pointer.md) | Focus 指针管理上下文 |
| [014](docs/ADR/014.chat.markdown-branching.md) | Markdown 标题 = 分支入口 |
| [015](docs/ADR/015.chat.node-schema.md) | 节点数据模型（合并行、2-byte ID、parents 前缀） |
| [016](docs/ADR/016.chat.context-path.md) | 上下文：只看根到 focus 路径 |
| [018](docs/ADR/018.auth.passkey.md) | 认证：Passkey |
| [019](docs/ADR/019.auth.session.md) | Session：users JSON 多设备 |
| [020](docs/ADR/020.auth.cookie-format.md) | Cookie：binary pack + base64 |

## 技术栈

- **运行时**：Cloudflare Workers ([ADR-002](docs/ADR/002.runtime.cloudflare-workers.md))
- **后端**：Hono ([ADR-003](docs/ADR/003.backend.hono.md))
- **前端**：Vanilla JS + marked.js CDN ([ADR-004](docs/ADR/004.frontend.vanilla-js.md))
- **数据库**：D1
- **认证**：WebAuthn (@simplewebauthn/server)
- **API 风格**：`/api/{domain}/{verb}`，响应 `{ data, em }` ([ADR-008](docs/ADR/008.api.style.md))

## License

See [LICENSE](LICENSE).
