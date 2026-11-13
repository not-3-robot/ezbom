# EzBOM 部署文件

最后更新：2026-06-10

---

## 正式网址

```
https://not-3-robot.github.io/ezbom
```

## 部署平台

**GitHub Pages**（`not-3-robot/ezbom` 仓库，main 分支，root 目录）

## 页面路径

| 页面 | URL |
|------|-----|
| 产品列表 | `/` |
| 爆炸图查看器 | `/viewer.html?product=p-type` |
| 管理仪表板 | `/admin.html`（密码: `webom2024`） |

## 更新流程

### 一键部署（推荐）
```bash
cd "/Users/zone/Documents/Sales/样本＆使用手册/冠亚/EzBOM"
bash deploy.sh
```
自动完成：git push → 等待 GitHub Pages 部署 → 生成 QR 码 → 自动打开。

### 手动部署
```bash
cd "/Users/zone/Documents/Sales/样本＆使用手册/冠亚/EzBOM"
git add -A
git commit -m "描述修改内容"
git push
```

GitHub Pages 会在 push 后自动重新部署，约 30 秒生效。

## 曾尝试但未采用的方案

| 方案 | 结果 | 原因 |
|------|------|------|
| Vercel | `ezbom.vercel.app` 曾部署成功 | 中国手机 4G 无法存取（CDN 全在美国） |
| Netlify | 未完成部署 | `netlify.app` 域名在中国被墙 |
| Gitee Pages | 多次尝试 404 | 可能需实名认证或人工审核 |
| Cloudflare Pages | 未完成 | 需 Cloudflare API Token |
| serveo.net | ✅ 手机可存取 | 作为备用方案，URL 会变动 |

## 废弃的本地开发方案

以下档案已于 2026-06-10 删除（GitHub Pages + deploy.sh 完全取代）：
- `serve.js` — localtunnel 隧道伺服器
- `httpd.js` — 本地 HTTP 伺服器
- `perfect.html` — 早期原型

## 技术架构

```
GitHub Pages (静态托管)
├── index.html           # 产品列表（QR Code、分享）
├── viewer.html          # SVG 爆炸图 + BOM + 询价
├── admin.html           # 管理仪表板（☁️ Cloudflare Worker）
├── analytics.js         # 双通道分析（Worker + localStorage 备援）
├── deploy.sh            # 一键部署脚本
├── products.json        # 产品设定
├── products/p-type/     # P型齿轮箱 SVG + CSV
├── workers/
│   ├── analytics-worker.js  # Cloudflare Worker
│   └── wrangler.toml        # Worker 部署设定
└── data/
    ├── stats.json       # 采购统计（generate_stats.py 产生）
    ├── purchases/       # 采购记录 CSV
    ├── generate_stats.py   # 统计生成器
    └── test_generate_stats.py  # 单元测试 (13 tests)
```

```
Cloudflare (分析后端)
└── ezbom-analytics.workers.dev
    ├── POST /event  → KV 储存
    └── GET /stats   → 汇总回传
```

## 数据搜集

### 云端分析（Cloudflare Worker）
- Worker URL：`https://ezbom-analytics.notnotnotrobot.workers.dev`
- 事件：POST `/event`，90 天自动过期
- 汇总：GET `/stats`
- KV Namespace：`ANALYTICS`（db15922249ed4ef2a0966ded2fad058b）
- **所有装置共享同一份数据，换装置不消失**

### 本地备援（localStorage）
- `ezbom_analytics` key，上限 1000 笔
- Worker 不可用时自动降级至 localStorage

### KV 容量与限制
| 项目 | 限制 |
|------|------|
| 事件保留天数 | 90 天（可调整 `expirationTtl`） |
| 最多事件数 | 1,000 笔 |
| 储存容量 | 1 GB（实际用量远低） |
| 每日写入 | 1,000 次 |
| 每日读取 | 100,000 次 |

产品 SVG/BOM 存于 GitHub Pages（1GB），不占用 KV 容量。
