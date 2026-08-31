# WebBOM — 齒輪箱零件詢價系統

靜態網頁 BOM 查看器，讓客戶透過爆炸圖選取零件、調整數量、發送詢價郵件。內建採購統計儀表板（管理員限定）。

## 專案結構

```
WebBOM/
├── index.html          # 產品列表首頁
├── viewer.html         # 爆炸圖查看器（HTML 結構）
├── viewer.css          # 查看器樣式表（從 viewer.html 拆分）
├── viewer.js           # 查看器核心邏輯（從 viewer.html 拆分）
├── sanitize.js         # XSS 防護共用模組
├── analytics.js        # 前端分析（Cloudflare Worker + localStorage 備援）
├── admin.html          # 管理儀表板
├── products.json       # 產品清單設定（含收件信箱）
├── products/
│   └── p-type/
│       ├── drawing.svg # Inkscape 爆炸圖
│       └── bom.csv     # 零件清單
├── data/
│   ├── purchases/      # 採購記錄 CSV（供統計用）
│   │   └── p-type.csv
│   ├── stats.json      # 由 generate_stats.py 產生
│   ├── generate_stats.py
│   └── test_generate_stats.py
├── workers/
│   ├── analytics-worker.js  # Cloudflare Worker（分析後端）
│   └── wrangler.toml
├── deploy.sh           # 一鍵部署至 GitHub Pages + QR Code
└── 參考文件/            # 原始參考資料（gitignore）
```

## 快速啟動

```bash
# 本地測試（任選一種）
cd WebBOM
python3 -m http.server 9001
# 開啟 http://localhost:9001

# 或用 node
npx serve -p 9001
```

## 如何新增產品

1. 在 `products/` 下建立新目錄，放入 `drawing.svg`（Inkscape 匯出）和 `bom.csv`
2. 編輯 `products.json` 加入新產品
3. SVG 中的零件群組需有 `inkscape:label="P01-..."` 屬性（格式：`P<編號>-<名稱>`）

BOM CSV 格式：
```csv
Id,ItemNo,PartNumber,Name,Quantity
P01,1,400198,C型扣環<R-47>,1
```

## 管理員功能

採購統計受密碼保護。預設密碼：`webom2024`（使用 SHA-256 hash 儲存，不再明文）

修改密碼：
1. 產生新密碼的 SHA-256 hash：`echo -n '你的密碼' | shasum -a 256`
2. 編輯 `viewer.html` 和 `admin.html` 中的 `ADMIN_PASSWORD_HASH` 變數

## 採購統計

1. 在 `data/purchases/` 下放入 CSV（格式同 BOM，加上 Date/Customer/UnitPrice/OrderNo 欄位）
2. 執行 `python3 data/generate_stats.py` 產生 `stats.json`
3. 前端會自動讀取顯示

## 鍵盤快捷鍵

| 快捷鍵 | 功能 |
|--------|------|
| `↑` `↓` | BOM 清單上下導航 |
| `Enter` | 選取/取消當前零件 |
| `Ctrl+Z` | 復原上一步選擇 |
| `Ctrl+A` | 全選所有零件 |
| `Esc` | 清除全部選擇 |
| `/` | 聚焦搜尋框 |
| `Ctrl+Shift+D` | 切換暗色模式 |

## 安全功能

- **路徑遍歷防護**：伺服器端防止 `../` 攻擊
- **CSP 標頭**：防止 XSS 與資源注入
- **SHA-256 密碼**：管理員密碼使用 hash 儲存，不暴露明文
- **XSS 防護**：所有使用者可控資料經過 HTML 轉義
- **SVG 安全注入**：使用 DOMParser 解析 SVG，過濾 `<script>` 與事件屬性
- **Worker Origin 白名單**：只接受已授權網站的 POST 事件
- **Worker API Key**：`/stats` 端點需要 API key 驗證

## 部署

### 前端（GitHub Pages）

```bash
bash deploy.sh
# 自動 git push → 等待 GitHub Pages → 生成 QR Code
```

### 分析後端（Cloudflare Worker）

```bash
cd workers
# 修改 wrangler.toml 中的 STATS_API_KEY 為你的隨機 key
# 產生方式：node -e "console.log(crypto.randomUUID())"
npx wrangler deploy
```

部署後在前端頁面設定 Worker URL 和 Stats API key：
```html
<script>
  var WEBOM_WORKER_URL = 'https://your-worker.workers.dev';
  var WEBOM_STATS_KEY = 'your-stats-api-key';
</script>
```
