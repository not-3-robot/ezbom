# EzBOM 专案指引

> 本档案给 Claude Code 读：进来先看这里。详细进度见 `.claude/` 目录。

## 一句话

静态网页 BOM 查看器：客户从**爆炸图**点选零件、调数量、发询价邮件；内建采购统计仪表板（管理员限定）。部署在 GitHub Pages，手机扫码即可开启。

## 怎么跑 / 怎么部署

```bash
cd "/Users/zone/Documents/Sales/样本＆使用手册/冠亚/EzBOM"

# 本地预览
python3 -m http.server 9001   # 开 http://localhost:9001

# 一键部署到 GitHub Pages（自动 push + 等 Pages + 产 QR 码）
bash deploy.sh
# 或 npm run deploy
```

正式网址：`https://not-3-robot.github.io/ezbom`
查看器：`/viewer.html?product=p-type`　管理仪表板：`/admin.html`

## 架构

纯前端 + 静态档，**无后端**（分析后端是独立的 Cloudflare Worker）。

| 档案 | 角色 |
|------|------|
| `index.html` | 产品列表首页，读 `products.json` |
| `viewer.html` + `viewer.css` + `viewer.js` | 爆炸图查看器（已拆分，别再塞回 html） |
| `sanitize.js` | **XSS 防护共用模组，所有使用者可控资料都过这里** |
| `analytics.js` | 前端分析（Worker + localStorage 备援） |
| `admin.html` | 采购统计仪表板（密码保护） |
| `products.json` | 产品清单设定（含收件信箱） |
| `products/<name>/drawing.svg` + `bom.csv` | 每个产品的爆炸图与零件清单 |
| `data/generate_stats.py` | 从 `data/purchases/*.csv` 产 `stats.json` |
| `workers/analytics-worker.js` + `wrangler.toml` | Cloudflare Worker 分析后端 |

## SVG 爆炸图规则（改 viewer 前必看）

- 零件群组用 `inkscape:label="P01-零件名"` 标示，格式 `P<编号>-<名称>`
- viewer.js 解析这个 label 去匹配 BOM CSV 的 `Id` 栏
- BOM CSV 栏位：`Id,ItemNo,PartNumber,Name,Quantity`（同时相容中英文栏名）
- 新增产品：`products/` 建目录放 `drawing.svg` + `bom.csv`，再编 `products.json`

## 安全防护（不要破坏）

- **路径遍历防护**：伺服器端挡 `../`
- **CSP 标头**：防 XSS / 资源注入
- **SHA-256 密码**：管理员密码用 hash 存于 `viewer.html` / `admin.html` 的 `ADMIN_PASSWORD_HASH`，不明文。改密码：`echo -n '新密码' | shasum -a 256` 两处都要改
- **SVG 安全注入**：DOMParser 解析，过滤 `<script>` 与事件属性
- **Worker Origin 白名单** + **/stats API key**

改任何前端逻辑时，使用者可控资料（零件名、询价内容）务必走 `sanitize.js`。

## 使用者偏好（重要）

- **单一显示模式（亮色）**：使用者明确要求过「黑暗模式时爆炸图看不见，只保证一种模式，删除黑暗模式」。不要新增/恢复暗色模式切换。
- **手机优先**：主要使用场景是手机扫码进入。改 UI 必须测 ≤768px 响应式（上下切换 + 底部 Tab）。
- **沟通用繁体中文**。
- **iOS + Android 都要能开**：跨平台相容性是硬要求。

## 进度文件（在 `.claude/`）

- `PROGRESS.md` — 已完成功能清单（最后更新 2026-06-10）
- `DEPLOY.md` — 部署细节与正式网址
- `TODOS.md` — 待办
- `LOOP.md` — 回圈开发用

动手前先读 `PROGRESS.md` 确认功能是否已存在，避免重做。

## 键盘快捷键（viewer）

`↑↓` 导航 / `Enter` 选取 / `Ctrl+Z` 复原 / `Ctrl+A` 全选 / `Esc` 清除 / `/` 聚焦搜寻

## 工作规范

- 改完务必 `python3 -m http.server 9001` 实际开来看，不要只改程式码
- 部署前确认 `参考文件/`、`参考图纸/` 没被误 commit（已在 `.gitignore`）
- commit 讯息：Conventional Commits + 中文，如 `feat: SVG label ID 修复`
