# EzBOM 部署文件

最後更新：2026-06-10

---

## 正式網址

```
https://not-3-robot.github.io/ezbom
```

## 部署平台

**GitHub Pages**（`not-3-robot/ezbom` 倉庫，main 分支，root 目錄）

## 頁面路徑

| 頁面 | URL |
|------|-----|
| 產品列表 | `/` |
| 爆炸圖查看器 | `/viewer.html?product=p-type` |
| 管理儀表板 | `/admin.html`（密碼: `webom2024`） |

## 更新流程

### 一鍵部署（推薦）
```bash
cd /Users/zone/Documents/Project/EzBOM
bash deploy.sh
```
自動完成：git push → 等待 GitHub Pages 部署 → 生成 QR 碼 → 自動打開。

### 手動部署
```bash
cd /Users/zone/Documents/Project/EzBOM
git add -A
git commit -m "描述修改內容"
git push
```

GitHub Pages 會在 push 後自動重新部署，約 30 秒生效。

## 曾嘗試但未採用的方案

| 方案 | 結果 | 原因 |
|------|------|------|
| Vercel | `ezbom.vercel.app` 曾部署成功 | 中國手機 4G 無法存取（CDN 全在美國） |
| Netlify | 未完成部署 | `netlify.app` 域名在中國被牆 |
| Gitee Pages | 多次嘗試 404 | 可能需實名認證或人工審核 |
| Cloudflare Pages | 未完成 | 需 Cloudflare API Token |
| serveo.net | ✅ 手機可存取 | 作為備用方案，URL 會變動 |

## 廢棄的本地開發方案

以下檔案已於 2026-06-10 刪除（GitHub Pages + deploy.sh 完全取代）：
- `serve.js` — localtunnel 隧道伺服器
- `httpd.js` — 本地 HTTP 伺服器
- `perfect.html` — 早期原型

## 技術架構

```
GitHub Pages (靜態託管)
├── index.html           # 產品列表（QR Code、分享）
├── viewer.html          # SVG 爆炸圖 + BOM + 詢價
├── admin.html           # 管理儀表板（☁️ Cloudflare Worker）
├── analytics.js         # 雙通道分析（Worker + localStorage 備援）
├── deploy.sh            # 一鍵部署腳本
├── products.json        # 產品設定
├── products/p-type/     # P型齒輪箱 SVG + CSV
├── workers/
│   ├── analytics-worker.js  # Cloudflare Worker
│   └── wrangler.toml        # Worker 部署設定
└── data/
    ├── stats.json       # 採購統計（generate_stats.py 產生）
    ├── purchases/       # 採購記錄 CSV
    ├── generate_stats.py   # 統計生成器
    └── test_generate_stats.py  # 單元測試 (13 tests)
```

```
Cloudflare (分析後端)
└── ezbom-analytics.workers.dev
    ├── POST /event  → KV 儲存
    └── GET /stats   → 彙總回傳
```

## 數據搜集

### 雲端分析（Cloudflare Worker）
- Worker URL：`https://ezbom-analytics.notnotnotrobot.workers.dev`
- 事件：POST `/event`，90 天自動過期
- 彙總：GET `/stats`
- KV Namespace：`ANALYTICS`（db15922249ed4ef2a0966ded2fad058b）
- **所有裝置共享同一份數據，換裝置不消失**

### 本地備援（localStorage）
- `ezbom_analytics` key，上限 1000 筆
- Worker 不可用時自動降級至 localStorage

### KV 容量與限制
| 項目 | 限制 |
|------|------|
| 事件保留天數 | 90 天（可調整 `expirationTtl`） |
| 最多事件數 | 1,000 筆 |
| 儲存容量 | 1 GB（實際用量遠低） |
| 每日寫入 | 1,000 次 |
| 每日讀取 | 100,000 次 |

產品 SVG/BOM 存於 GitHub Pages（1GB），不佔用 KV 容量。
