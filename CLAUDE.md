# EzBOM 專案指引

> 本檔案給 Claude Code 讀：進來先看這裡。詳細進度見 `.claude/` 目錄。

## 一句話

靜態網頁 BOM 查看器：客戶從**爆炸圖**點選零件、調數量、發詢價郵件；內建採購統計儀表板（管理員限定）。部署在 GitHub Pages，手機掃碼即可開啟。

## 怎麼跑 / 怎麼部署

```bash
cd "/Users/zone/Documents/Sales/樣本＆使用手冊/冠亞/公司＆產品簡介/EzBOM"

# 本地預覽
python3 -m http.server 9001   # 開 http://localhost:9001

# 一鍵部署到 GitHub Pages（自動 push + 等 Pages + 產 QR 碼）
bash deploy.sh
# 或 npm run deploy
```

正式網址：`https://not-3-robot.github.io/ezbom`
查看器：`/viewer.html?product=p-type`　管理儀表板：`/admin.html`

## 架構

純前端 + 靜態檔，**無後端**（分析後端是獨立的 Cloudflare Worker）。

| 檔案 | 角色 |
|------|------|
| `index.html` | 產品列表首頁，讀 `products.json` |
| `viewer.html` + `viewer.css` + `viewer.js` | 爆炸圖查看器（已拆分，別再塞回 html） |
| `sanitize.js` | **XSS 防護共用模組，所有使用者可控資料都過這裡** |
| `analytics.js` | 前端分析（Worker + localStorage 備援） |
| `admin.html` | 採購統計儀表板（密碼保護） |
| `products.json` | 產品清單設定（含收件信箱） |
| `products/<name>/drawing.svg` + `bom.csv` | 每個產品的爆炸圖與零件清單 |
| `data/generate_stats.py` | 從 `data/purchases/*.csv` 產 `stats.json` |
| `workers/analytics-worker.js` + `wrangler.toml` | Cloudflare Worker 分析後端 |

## SVG 爆炸圖規則（改 viewer 前必看）

- 零件群組用 `inkscape:label="P01-零件名"` 標示，格式 `P<編號>-<名稱>`
- viewer.js 解析這個 label 去匹配 BOM CSV 的 `Id` 欄
- BOM CSV 欄位：`Id,ItemNo,PartNumber,Name,Quantity`（同時相容中英文欄名）
- 新增產品：`products/` 建目錄放 `drawing.svg` + `bom.csv`，再編 `products.json`

## 安全防護（不要破壞）

- **路徑遍歷防護**：伺服器端擋 `../`
- **CSP 標頭**：防 XSS / 資源注入
- **SHA-256 密碼**：管理員密碼用 hash 存於 `viewer.html` / `admin.html` 的 `ADMIN_PASSWORD_HASH`，不明文。改密碼：`echo -n '新密碼' | shasum -a 256` 兩處都要改
- **SVG 安全注入**：DOMParser 解析，過濾 `<script>` 與事件屬性
- **Worker Origin 白名單** + **/stats API key**

改任何前端邏輯時，使用者可控資料（零件名、詢價內容）務必走 `sanitize.js`。

## 使用者偏好（重要）

- **單一顯示模式（亮色）**：使用者明確要求過「黑暗模式時爆炸圖看不見，只保證一種模式，刪除黑暗模式」。不要新增/恢復暗色模式切換。
- **手機優先**：主要使用場景是手機掃碼進入。改 UI 必須測 ≤768px 響應式（上下切換 + 底部 Tab）。
- **溝通用繁體中文**。
- **iOS + Android 都要能開**：跨平台相容性是硬要求。

## 進度文件（在 `.claude/`）

- `PROGRESS.md` — 已完成功能清單（最後更新 2026-06-10）
- `DEPLOY.md` — 部署細節與正式網址
- `TODOS.md` — 待辦
- `LOOP.md` — 迴圈開發用

動手前先讀 `PROGRESS.md` 確認功能是否已存在，避免重做。

## 鍵盤快捷鍵（viewer）

`↑↓` 導航 / `Enter` 選取 / `Ctrl+Z` 復原 / `Ctrl+A` 全選 / `Esc` 清除 / `/` 聚焦搜尋

## 工作規範

- 改完務必 `python3 -m http.server 9001` 實際開來看，不要只改程式碼
- 部署前確認 `參考文件/`、`參考圖紙/` 沒被誤 commit（已在 `.gitignore`）
- commit 訊息：Conventional Commits + 中文，如 `feat: SVG label ID 修復`
