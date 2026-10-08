# EzBOM 待解決問題

最後更新：2026-06-10

---

## 2026-06-10 已完成

### 暗色模式移除
- [x] 刪除 viewer.html 切換按鈕、viewer.css 暗色樣式（107 行）、viewer.js 相關功能
- [x] 原因：暗色背景導致爆炸圖 SVG 零件不可見

### 管理後台修正
- [x] admin.html 密碼 hash 修正（原 DEFAULT_HASH 為假值，無法登入）
- [x] 密碼：`webom2024`

### 分析系統雲端化
- [x] analytics.js 重構 → 雙通道：Cloudflare Worker (主) + localStorage (備援)
- [x] Cloudflare Worker 部署於 `ezbom-analytics.notnotnotrobot.workers.dev`
- [x] KV 儲存事件，90 天自動過期
- [x] 後台標頭顯示 `☁️ Cloudflare Worker`（集中式數據）
- [x] 所有頁面（index/viewer/admin）自動上傳事件至 Worker

### 一鍵部署
- [x] `bash deploy.sh`：git push → 等部署 → 生成 QR → 自動打開

---

## 2026-06-04 已完成

### 部署與數據搜集
- [x] GitHub Pages 部署（`not-3-robot.github.io/ezbom`）
- [x] localStorage 版 analytics.js（pageview / select / inquiry / error）
- [x] 管理儀表板 admin.html（KPI、設備分佈、錯誤追蹤、CSV 匯出）
- [x] 手機跨平台相容（viewport-fit、safe-area、SVG filter、mailto 備用）
- [x] QR Code 分享 + Web Share API
- [x] Python 單元測試 13 項（data/test_generate_stats.py）
- [x] generate_stats.py 空記錄 hotParts 修正

### 手機相容修正
- [x] SVG drop-shadow 在行動版禁用（iOS Safari 效能）
- [x] viewport-fit=cover + safe-area-inset-bottom（iPhone notch）
- [x] 行動版 Tab 按鈕 min-height: 44px（iOS HIG）
- [x] Android mailto 備用方案（顯示內容 + 複製到剪貼簿）

---

## 2026-05-23 遺留問題

## P1 - 高優先級

### SVG 零件標籤偏移
- **現象**：在某些縮放比例或視窗大小下，浮動零件標籤（橘色方塊）偏離零件位置
- **原因**：`getBBox()` 在 SVG 嵌套 `<g>` 和 CSS transform 下回坐標不穩定；`getScreenCTM()` 在現代瀏覽器行為不一致
- **方向**：改用 `getBoundingClientRect()` 或遍歷子元素取平均坐標

### 手機上點擊小零件困難
- **現象**：手機上 SVG 爆炸圖縮放到螢幕大小後，小零件（如螺絲、扣環）面積很小，手指難以精準點擊
- **方向**：可考慮點擊輔助（點擊附近區域時彈出候選列表）、或雙指放大後再點擊

---

## P2 - 中優先級

### 匯出報價單
- **需求**：選擇零件後可匯出 PDF / Excel / 純文字格式的報價單
- **方案**：純前端用 `html2pdf.js` 或 `SheetJS`，或直接用 mailto 發送格式化郵件

### 產品分類與篩選
- **需求**：上百種產品時，產品列表頁需要分類（如齒輪箱類型、噸位、適用機型）和搜索
- **方案**：`products.json` 擴充 `category`、`tags` 欄位，index.html 加上分類 filter

### 線上式 BOM 編輯
- **需求**：直接在網頁上修改零件數據（名稱、數量、料號），自動保存到 CSV
- **限制**：靜態頁面無法寫入本地文件，需要後端 API 或 File System Access API（僅 Chrome）

### DWG → SVG 轉換
- **需求**：現有參考圖紙中的 .dwg 文件需要轉為 SVG 才能在 EzBOM 中使用
- **方案**：AutoCAD 導出 SVG，或用 `ezdxf` + `svglib` Python 庫批量轉換

---

## P3 - 低優先級

### 多語系
- **需求**：支援英文/簡體中文界面
- **方案**：`<html lang>` + JS i18n 物件

### 啟動腳本
- **需求**：一鍵啟動 HTTP 服務 + 自動檢測 IP + 生成 QR Code
- **方案**：`start.sh` 腳本（已寫但未測試）

### 離線 PWA 支援
- **需求**：快取 SVG/CSV/JSON，無網路環境下也可使用
- **方案**：`service-worker.js` + manifest.json

### 詢價歷史記錄
- **需求**：已發送的詢價記錄可查詢、重複使用
- **方案**：localStorage 保存發送記錄，或在 data/ 目錄保存 JSON 日誌

### 批量產品導入
- **需求**：一次導入多個產品的 CSV + SVG，自動生成 products.json
- **方案**：Python 腳本掃描 products/ 目錄自動生成配置

---

## 採購統計相關待實現

### 客戶購買頻次統計
- **狀態**：尚未開始
- **數據**：`data/purchases/` 目錄下的 CSV 採購記錄
- **方向**：需要一個 stats 頁面或 viewer 中的統計 Tab

### 高頻購買部品推薦
- **狀態**：尚未開始
- **數據**：從採購記錄計算 top N 零件
- **方向**：在 BOM 清單中用星號或標記標出高頻零件

### 數據錄入方式
- **狀態**：待討論
- **方案 A**：手動編輯 CSV（簡單但繁瑣）
- **方案 B**：網頁上錄入表單 + localStorage 暫存
- **方案 C**：從 ERP/進銷存系統導出後轉為 EzBOM 格式
