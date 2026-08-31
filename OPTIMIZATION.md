# WebBOM 專案優化清單

> 審查日期：2026-08-10
> 審查範圍：全部原始碼（viewer.js / viewer.html / viewer.css / admin.html / index.html / sanitize.js / analytics.js / workers / products.json / deploy.sh / 文件）

---

## 🔴 P0 - 安全問題（建議優先處理）

### #1 `WEBOM_STATS_KEY` 從未真正設定

**位置**：`viewer.html:10`、`index.html:82`、`admin.html:174`

三個 HTML 檔案裡都是預設佔位值：
```js
var WEBOM_STATS_KEY = 'webbom-stats-key-change-me';
```

Worker 端也是同樣的預設值：
```js
// workers/analytics-worker.js:20
const STATS_API_KEY = env => (env.STATS_API_KEY || 'webbom-stats-default-key-2026');
```

**問題**：API key 保護形同虛設，任何人都能讀取統計數據。而且 key 本身就寫在前端 HTML 裡，等於完全公開。

**修復方向**：
- 在 Cloudflare Worker 的 `wrangler.toml` 設定真正的隨機 key（`node -e "console.log(crypto.randomUUID())"`）
- 前端三處同步更新
- 或改用 Worker 端 session/token 機制，不把 key 放前端

---

### #2 `admin.html` 有 XSS 漏洞

**位置**：`admin.html` 第 308、320、341、356 行

`renderStats()` 函數直接用 `innerHTML` 插入來自 `stats.json` 的資料，完全沒有過 `escapeHtml`：

```js
// 第 308 行 - m.month 未轉義
return '<tr><td style="width:80px">' + m.month + '</td>...';

// 第 341 行 - p.partNumber, p.name 未轉義
return '<tr><td>' + (i+1) + '</td><td style="font-weight:600">' + p.partNumber + '</td><td style="color:#87867F">' + p.name + '</td>...';
```

`sanitize.js` 已載入但 `admin.html` 中完全沒有使用。

**修復方向**：所有動態插入的值都用 `WebBOMSanitize.escapeHtml()` 包裹。

---

### #3 管理員密碼明文寫在文件中

**位置**：`README.md:60`

```markdown
預設密碼：webom2024
```

Hash 也硬編碼在前端 JS 中（`viewer.js:45`、`admin.html:185`），可以離線暴力破解。

**修復方向**：
- 移除 README 中的明文密碼
- 更換為更強的密碼
- 考慮將密碼驗證移到 Worker 端

---

## 🟠 P1 - 程式碼品質

### #4 `hashPassword` / `simpleHash` 重複實作

**位置**：`viewer.js:76-98`、`admin.html:188-204`

同一段 SHA-256 + 降級 hash 邏輯同時出現在兩處，完全複製貼上。

**修復方向**：抽到共用模組 `auth.js`，兩處引入。

---

### #5 `viewer.js` 的 `ADMIN_PASSWORD_HASH` 永遠為空

**位置**：`viewer.js:41`

```js
var ADMIN_PASSWORD_HASH = '';  // 永遠空字串
```

實際上都走 `DEFAULT_HASH` fallback。這個變數沒有任何作用。

**修復方向**：移除此變數，或改為從外部設定檔讀取。

---

### #6 程式碼風格不一致

| 檔案 | 風格 |
|------|------|
| `viewer.js` | ES5（`var`, `function()`） |
| `admin.html` | ES6+（`const/let`, `=>`） |
| `index.html` | ES6+（`const/let`, `=>`） |

`viewer.js` 是最大的檔案（1139 行），卻用最舊的語法。

**修復方向**：統一為 ES6+，或保持 ES5 但全部一致。

---

### #7 `README.md` 仍記錄已移除的暗色模式快捷鍵

**位置**：`README.md:82`

```markdown
| `Ctrl+Shift+D` | 切換暗色模式 |
```

暗色模式已於 2026-06-10 移除，但文件仍列此快捷鍵。

**修復方向**：刪除此行。

---

### #8 `CLAUDE.md` 路徑錯誤

**位置**：`CLAUDE.md:12`

```bash
cd /Users/zone/Documents/Project/webBOM  # ← 舊路徑
```

實際路徑為 `/Users/zone/Documents/Sales/樣本＆使用手冊/冠亞/公司＆產品簡介/webBOM`

**修復方向**：更新路徑。

---

## 🟡 P2 - 效能優化

### #9 `updateStats()` 每次都重建整個 DOM

**位置**：`viewer.js:555-609`

每次切換零件選擇時，`updateStats()` 會 `list.innerHTML = ''` 然後重建所有已選零件的 DOM。選了 20+ 個零件時，每次點擊都造成不必要的 reflow。

**修復方向**：增量更新（只新增/移除變化的項目），或用 DocumentFragment。

---

### #10 QR Code 依賴外部 API

**位置**：`index.html:207`

```js
img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=...'
```

**問題**：
- 依賴第三方服務可用性
- 在中國大陸可能被牆
- 不能離線使用

**修復方向**：用輕量純 JS QR 生成庫（如 `qrcode-generator`，~6KB），或直接用 `deploy.sh` 裡的 `npx qrcode` 產生靜態 PNG 放入專案。

---

### #11 無 Service Worker / 離線快取

目前無 `service-worker.js`、無 `manifest.json`。SVG、CSV、JSON 每次都重新 fetch。

**修復方向**：
- 加入 Service Worker 快取靜態資源
- 加 `manifest.json` 做 PWA 安裝
- 這也是 TODOS.md 裡的 P3 項目

---

### #12 SVG 安全過濾效能

**位置**：`viewer.js:317-322`

```js
svgEl.querySelectorAll('*').forEach(function(el) {
  var attrs = el.getAttributeNames();
  attrs.forEach(function(name) {
    if (name.indexOf('on') === 0) el.removeAttribute(name);
  });
});
```

對大型 SVG（Inkscape 匯出的可能有上千個元素），`querySelectorAll('*')` 會非常慢。

**修復方向**：只檢查 `<g>` 和有 `on*` 屬性的元素（`svgEl.querySelectorAll('[onload], [onclick], [onmouseover], ...]`），或用 `TreeWalker`。

---

## 🟢 P3 - UX / 功能改進

### #13 無 Email 格式驗證

**位置**：`viewer.js:637-643`

```js
if (!emailTo) {  // 只檢查非空
  showToast('請先輸入詢價收件信箱');
  return;
}
```

不驗證 email 格式，輸入 `abc` 也能觸發 mailto。

**修復方向**：加入正則驗證：
```js
var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRe.test(emailTo)) { ... }
```

---

### #14 `products.json` 的 `emailTo` 全是空的

**位置**：`products.json:3,11`

```json
"emailTo": "",
```

使用者每次首次使用都要手動輸入信箱。

**修復方向**：填入公司預設詢價信箱。

---

### #15 手機版無 SVG 縮放控制

**位置**：`viewer.js:787`（只有桌面版加縮放按鈕）

桌面版有 `+` `−` `↺` 按鈕和 `Ctrl+滾輪`縮放，手機版完全沒有。CSS 設了 `touch-action: pinch-zoom` 但沒有 JS 實作 pinch-to-zoom。

這也是 `TODOS.md` 裡的 P1 問題。

**修復方向**：
- 實作 touch event pinch-to-zoom
- 或至少在手機版也顯示縮放按鈕

---

### #16 無 Favicon

三個頁面都沒有 favicon，瀏覽器 tab 顯示預設圖示。

**修復方向**：加一個簡單的 SVG favicon（齒輪圖示）。

---

### #17 `index.html` 大量 inline style

**位置**：`index.html:7-78`

70+ 行的 `<style>` 塊。為了與 `viewer.css` 保持一致架構，建議也抽成 `index.css`。

**修復方向**：抽出為獨立 CSS 檔案。

---

## 🔵 架構層面觀察

### #18 Worker `/stats` API key 在前端暴露

**位置**：所有 HTML 檔案

這是靜態網站的固有問題。API key 寫在 HTML 裡，任何人都能看見。

**修復方向**：
- `/stats` 端點加 IP 白名單
- 或改用 Worker 端 session/token 機制（密碼驗證後發短期 token）

---

### #19 Worker 無速率限制

**位置**：`workers/analytics-worker.js:46-104`

`/event` 端點只檢查 Origin，沒有限流。惡意腳本可以從允許的 origin 發送大量假事件，灌爆 KV 配額（免費方案每日 1,000 次寫入）。

**修復方向**：
- 用 KV 實作簡易速率限制（每 IP 每分鐘上限）
- 或升級 Cloudflare Workers 付費方案

---

### #20 localStorage 分析事件無過期清理

**位置**：`analytics.js:50-55`

只限制最多 1000 筆，但不按時間清理。長期使用後舊事件會佔滿配額。

**修復方向**：加入時間戳檢查，超過 90 天的事件自動清除（與 Worker KV 的 90 天 TTL 一致）。

---

## 📋 建議處理順序

| 優先級 | 項目 | 預估工作量 | 狀態 |
|--------|------|-----------|------|
| 🔴 P0 | #1 設定真正的 STATS_API_KEY | 10 分鐘 | ☐ |
| 🔴 P0 | #2 admin.html XSS 修復 | 30 分鐘 | ☐ |
| 🔴 P0 | #3 移除 README 明文密碼 | 5 分鐘 | ☐ |
| 🟠 P1 | #4 抽出共用 auth 模組 | 1 小時 | ☐ |
| 🟠 P1 | #5 移除無用的 ADMIN_PASSWORD_HASH | 5 分鐘 | ☐ |
| 🟠 P1 | #6 統一程式碼風格 | 2 小時 | ☐ |
| 🟠 P1 | #7 修正 README 暗色模式快捷鍵 | 2 分鐘 | ☐ |
| 🟠 P1 | #8 修正 CLAUDE.md 路徑 | 2 分鐘 | ☐ |
| 🟡 P2 | #9 updateStats 增量更新 | 1 小時 | ☐ |
| 🟡 P2 | #10 QR Code 改離線方案 | 30 分鐘 | ☐ |
| 🟡 P2 | #11 PWA 離線支援 | 2-3 小時 | ☐ |
| 🟡 P2 | #12 SVG 過濾效能優化 | 30 分鐘 | ☐ |
| 🟢 P3 | #13 Email 格式驗證 | 10 分鐘 | ☐ |
| 🟢 P3 | #14 填入預設詢價信箱 | 5 分鐘 | ☐ |
| 🟢 P3 | #15 手機 pinch-zoom | 2-3 小時 | ☐ |
| 🟢 P3 | #16 加入 Favicon | 10 分鐘 | ☐ |
| 🟢 P3 | #17 index.html 抽 CSS | 15 分鐘 | ☐ |
| 🔵 架構 | #18 Worker API key 機制改造 | 3-4 小時 | ☐ |
| 🔵 架構 | #19 Worker 速率限制 | 1-2 小時 | ☐ |
| 🔵 架構 | #20 localStorage 事件過期清理 | 30 分鐘 | ☐ |
