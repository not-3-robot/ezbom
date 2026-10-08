# EzBOM 開發進度

最後更新：2026-06-10

---

## 已完成功能

### 核心系統
- [x] **模板化查看器** (`viewer.html`) — 通過 `?product=xxx` URL 參數動態加載產品數據
- [x] **產品清單頁** (`index.html`) — 從 `products.json` 讀取產品列表，點擊進入查看器
- [x] **產品設定檔** (`products.json`) — 集中管理所有產品（SVG 路徑、BOM 路徑、名稱、型號）
- [x] **標準 BOM 格式** — CSV 含 Id, ItemNo, PartNumber, Name, Quantity 欄位
- [x] **CSV 相容性** — 同時支援中英文欄位名（Id/標籤ID、PartNumber/料品編號等）
- [x] **靜態檔案架構** — 無後端，純前端 + 靜態 JSON/CSV/SVG，HTTP Server 即可運行

### SVG 爆炸圖交互
- [x] **SVG 載入** — 從外部路徑動態 fetch SVG 並注入 DOM
- [x] **零件自動識別** — 解析 `inkscape:label="P01-零件名"` 屬性，匹配 BOM 數據
- [x] **hover 放大 1.1 倍** — 純 CSS 實現，無 JS 延遲（0.12s transition）
- [x] **hover 變色** — stroke 變 #D97757 + 淺色 fill
- [x] **點擊選中** — 選中後保持高亮 + 1.1x 放大
- [x] **浮動標籤** — 滑鼠懸停時顯示零件編號，位置跟隨零件坐標
- [x] **標籤坐標映射** — SVG viewBox 坐標正確轉換為 CSS 像素坐標
- [x] **resize 重新定位** — 視窗縮放時標籤重新計算位置
- [x] **SVG label ID 修復** — 原 P26 重複問題（一個 C 型扣環、一個油蓋）已修正

### BOM 清單功能
- [x] **零件列表渲染** — 從 CSV 數據動態生成
- [x] **搜索過濾** — 按零件編號或名稱即時過濾
- [x] **全選 / 清除** — 批量操作
- [x] **統計面板** — 已選種數、總數量
- [x] **可編輯數量** — 已選清單中可直接修改詢價數量
- [x] **雙向選擇** — 點擊清單或 SVG 均可選中/取消，兩者同步
- [x] **去重保護** — 防止 initBOMList 重複調用導致列表重複

### 詢價輸出
- [x] **mailto 發送** — 打開系統郵件客戶端，自動填入主題和正文
- [x] **自定義數量** — 詢價數量可逐項調整
- [x] **發送確認** — 彈窗確認後再打開郵件

### 手機端適配
- [x] **響應式佈局** — <=768px 改為上下切換，底部 Tab 欄
- [x] **Tab 切換** — 「爆炸圖」/「零件清單」兩個 Tab
- [x] **SVG 填滿螢幕** — 手機上 SVG 面板佔 60vh
- [x] **雙指縮放** — 允許 pinch zoom（移除 user-scalable=no）
- [x] **觸控延遲消除** — touch-action: manipulation
- [x] **點擊反饋** — 手機點擊零件顯示標籤 1.2 秒 + 短暫高亮動畫
- [x] **產品列表手機適配** — 單列卡片佈局，無 SVG 預載加快速度

---

## 當前狀態

可正常使用的核心流程：
```
index.html → 點擊產品 → viewer.html?product=p-type
                         ├── 載入 SVG + CSV
                         ├── 爆炸圖 hover/點擊選零件
                         ├── BOM 清單搜索/全選
                         └── 發送詢價郵件
```

目前只有一個產品（P 型齒輪箱），但架構已準備好擴充。

---

## 待開發 / 已知問題

### P1 - 影響使用
- [ ] SVG 零件標籤位置在某些縮放比例下仍然偏移（getBBox 在嵌套 transform 下不穩定）
- [ ] 手機上 SVG 零件太小，精準點擊困難（需要點擊輔助或放大鏡功能）

### P2 - 功能缺失
- [ ] **匯出報價單**（PDF / Excel / 純文字）— 目前只有 mailto
- [ ] **產品分類** — 上百種產品時需要分類/標籤過濾
- [ ] **BOM 編輯** — 直接在網頁上編輯零件數據（目前需改 CSV）
- [ ] **歷史記錄** — 已發送的詢價記錄保存

### P3 - 改進
- [ ] **批量添加產品** — 腳本掃描目錄自動生成 products.json
- [ ] **DWG → SVG 轉換** — 參考圖紙中有 .dwg 文件，目前無法直接使用
- [ ] **多語系** — 目前僅繁體中文
- [ ] **啟動腳本** — 一鍵啟動 + QR Code 生成
- [ ] **離線 PWA** — Service Worker 快取 SVG/CSV，無網路可用

### 採購統計（新增）
- [x] **採購記錄格式** — `data/purchases/<產品ID>.csv`，含日期、客戶、料號、數量、單價
- [x] **統計生成腳本** — `data/generate_stats.py`，一鍵計算 top 零件、客戶排名、月度趨勢
- [x] **前端統計 Tab** — viewer.html 第三個 Tab「採購統計」，顯示高頻零件、客戶排名、長條圖
- [ ] **自動定期更新** — cron 每週跑 generate_stats.py
- [ ] **採購記錄在線錄入** — 網頁表單新增採購記錄，暫存 localStorage

---

## 如何新增一個產品

```json
// products.json 加一行：
{
  "id": "k-type",
  "name": "K型齒輪箱",
  "model": "K-TYPE",
  "svg": "參考圖紙/k_type.svg",
  "bom": "products/k-type/bom.csv"
}
```

CSV 格式（複製 `products/p-type/bom.csv` 修改）：
```csv
Id,ItemNo,PartNumber,Name,Quantity
P01,1,400001,零件A,1
P02,2,400002,零件B,2
```

SVG 要求：Inkscape 導出的 SVG，每個零件的 `<g>` 要有 `inkscape:label="P01-零件名"` 這樣的屬性。

---

## 技術棧

- 純前端（HTML + CSS + Vanilla JS）
- 無任何依賴庫
- 運行只需要：`python3 -m http.server 8000 --bind 0.0.0.0`
- 數據格式：JSON（products.json）+ CSV（BOM 數據）
- SVG：Inkscape 導出格式，inkscape:label 屬性做零件標記

---

## 2026-06-04 — GitHub Pages 部署 + localStorage 分析 + 手機相容

### GitHub Pages 部署 (最終方案)
- [x] 部署到 `https://not-3-robot.github.io/ezbom`
- [x] 透過 GitHub API 自動啟用 Pages（branch: main, path: /）
- [x] 部署狀態: built ✅
- [x] 首頁、viewer、admin 全部 200，零錯誤

> Vercel (`ezbom.vercel.app`) 曾成功部署，但中國大陸手機 4G 網路無法存取（CDN 節點全在美國）
> Netlify 同樣面臨中國封鎖，`netlify.app` 域名被牆
> Gitee Pages 多次嘗試未成功（可能需實名認證或人工審核）
> serveo.net 隧道在中國手機可存取，作為備用方案

### analytics.js — localStorage 版（中國適用）
- [x] 事件存入 localStorage（上限 1000 筆），不需要後端 API
- [x] 四種事件：pageview / select / inquiry / error
- [x] 全域錯誤捕捉：window.onerror + unhandledrejection
- [x] 設備檢測：OS、瀏覽器、螢幕、DPR、語言、微信內建瀏覽器
- [x] `exportCSV()` 匯出功能
- [x] `getSummary()` 統計摘要（含設備/產品分佈）
- [x] `clear()` 清除數據
- [x] index.html / viewer.html / admin.html 全事件追蹤

### admin.html — 管理儀表板
- [x] KPI 卡片（產品數、零件數、客戶數、採購次數、瀏覽量、詢價次數）
- [x] 月度趨勢長條圖（來自 stats.json）
- [x] 設備分佈圖（來自 localStorage analytics）
- [x] 零件採購 TOP 10（來自 stats.json）
- [x] JS 錯誤追蹤（來自 localStorage）
- [x] CSV 匯出 + 清除數據按鈕
- [x] 密碼保護（webom2024）

### 手機跨平台相容
- [x] viewport-fit=cover（iPhone notch 安全區域）
- [x] safe-area-inset-bottom（底部 Tab 不遮擋）
- [x] 行動版 SVG 禁用 drop-shadow（iOS Safari GPU 效能問題）
- [x] 行動版 Tab 按鈕 min-height: 44px（iOS HIG 最低觸摸目標）
- [x] Android mailto 備用方案（彈窗顯示內容 + 複製到剪貼簿）
- [x] Web Share API 整合 + Clipboard API 降級

### 分享功能
- [x] index.html — QR Code（api.qrserver.com）+ Web Share API
- [x] viewer.html — 產品分享按鈕（Share API / Clipboard）
- [x] 降級策略：Share API → Clipboard API → prompt()

### Python 測試
- [x] `data/test_generate_stats.py` — 13 項測試全部通過
- [x] 測試範圍：topParts、topCustomers、monthlyStats、hotParts、空記錄、邊界值
- [x] generate_stats.py 修正：空記錄回傳含 hotParts 欄位

### 檔案變更摘要
```
新增: analytics.js, admin.html, data/test_generate_stats.py, .vercelignore
修改: index.html, viewer.html, .gitignore, data/generate_stats.py
移除: vercel.json, api/log.js, netlify/, serve.js (deprecated)
```

---

## 2026-06-10 — 暗色模式移除 + 分析後端雲端化 + 一鍵部署腳本

### 暗色模式移除
- [x] 移除 viewer.html 中的 🌓 切換按鈕
- [x] 刪除 viewer.css 中 `@media (prefers-color-scheme: dark)` 及所有 `.dark-mode-enabled` 樣式（107 行）
- [x] 移除 viewer.js 中 `initDarkMode()`、`toggleDarkMode()`、鍵盤快捷鍵 `Ctrl+Shift+D`
- [x] 原因：暗色模式時爆炸圖 SVG 看不見（深色零件在深色背景上消失）

### 管理後台修正
- [x] 修正 admin.html 密碼驗證 — `DEFAULT_HASH` 原為假佔位值，更換為 `webom2024` 的正確 SHA-256 hash
- [x] 後台現可正常登入，密碼：`webom2024`

### analytics.js → Cloudflare Worker 雲端化
- [x] 原 `analytics.js` 僅存 localStorage（換裝置數據消失）→ 重構為雙通道：Cloudflare Worker（主）+ localStorage（備援）
- [x] 建立 Cloudflare Worker：`workers/analytics-worker.js`
  - `POST /event` — 接收事件並存入 KV
  - `GET /stats` — 彙總統計（pageviews、inquiries、errors、devices、products、topParts、recentErrors）
  - KV 自動過期：90 天
- [x] 建立 KV Namespace：`ANALYTICS`（id: `db15922249ed4ef2a0966ded2fad058b`）
- [x] 部署至 `https://ezbom-analytics.notnotnotrobot.workers.dev`
- [x] admin.html 標頭顯示 `☁️ Cloudflare Worker`，標記當前使用雲端數據源
- [x] index.html、viewer.html、admin.html 均配置 `EZBOM_WORKER_URL`，事件自動上傳雲端
- [x] `getSummary(callback)` 非同步 API：優先讀取 Worker，降級合併 localStorage

### 一鍵部署腳本 deploy.sh
- [x] `bash deploy.sh`：自動 git push → 等待 GitHub Pages 部署 → 生成 QR 碼 PNG → 自動打開
- [x] QR 碼輸出至 `~/Downloads/EzBOM-qrcode.png`，URL：`https://not-3-robot.github.io/ezbom/`
- [x] 不需再手動處理 localtunnel、IP、port

### 檔案變更摘要
```
新增: deploy.sh, workers/analytics-worker.js, workers/wrangler.toml
修改: analytics.js (重構), admin.html (Worker 整合 + 密碼修正), viewer.html, viewer.css, viewer.js (暗色模式移除), index.html (Worker URL)
```

### Cloudflare Workers KV 容量與限制

| 項目 | 限制 | 說明 |
|------|------|------|
| 事件保留天數 | 90 天 | `expirationTtl: 7776000` 秒，滿期自動刪除 |
| 最多事件數 | 1,000 筆 | 免費方案每命名空間 1,000 key |
| 儲存容量 | 1 GB | 1,000 筆約 500KB，遠低於上限 |
| 每日寫入次數 | 1,000 次 | 免費額度 |
| 每日讀取次數 | 100,000 次 | 免費額度 |

### 產品爆炸圖/BOM 與儲存關係

產品爆炸圖（SVG）和 BOM（CSV）存放於 **GitHub Pages**（1GB 免費），與 Cloudflare KV 分析儲存**完全獨立**。增加產品數量不影響 KV 的 1,000 筆事件上限。一個 SVG 約 50KB～2MB，500 個產品才逼近 1GB。分析事件僅記錄 pageview、詢價等輕量資訊，每筆約 500 字元。

### 代碼清理（同日）
- [x] 修正 `viewer.js` 中的 `DEFAULT_HASH`（原 `9f1c5b6...` 假值 → 正確的 `6d23d68...`）
- [x] 刪除廢棄檔案：`perfect.html`（早期原型）、`httpd.js`（與 serve.js 重複）、`serve.js`（已被 GitHub Pages 取代）、`serve.log`
- [x] 建立 `package.json`（正規化專案）
