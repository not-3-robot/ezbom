# EzBOM Loop 模板集

> 齒輪箱零件詢價系統的工作流程模板。
> 每次執行對應任務時，將下方模板 + 你的輸入資料一起餵給 Claude。

---

## Loop 1：新增產品

### 輸入
- Inkscape SVG 爆炸圖：[貼上檔案路徑或內容]
- BOM CSV（零件清單）：[貼上內容]
- 產品資訊：名稱、型號、收件信箱（可選）

### 處理規則
1. 讀取 SVG，提取所有 `inkscape:label="P01-..."` 標籤
2. 檢查 CSV 格式：`Id,ItemNo,PartNumber,Name,Quantity`
3. 對齊 SVG 標籤與 CSV 的 PartNumber，列出不一致項
4. 將 SVG 放入 `products/[id]/drawing.svg`
5. 將 CSV 放入 `products/[id]/bom.csv`
6. 更新 `products.json` 加入新產品

### 輸出格式
- ✅ 對齊報告：SVG 有但 CSV 無 / CSV 有但 SVG 無
- ✅ 新增/修改的檔案列表
- ⚠ 警告事項（如信箱未設定）

### 自我檢查
- [ ] SVG 檔案存在且含正確 labels
- [ ] CSV 編碼為 UTF-8
- [ ] products.json 格式正確
- [ ] `node httpd.js` 本地測試可載入

---

## Loop 2：更新採購統計

### 輸入
- 採購 CSV：[貼上內容或檔案路徑]
- 產品 ID：[p-type / p-type-2 / ...]

### 處理規則
1. 檢查 CSV 欄位：`Date,Customer,UnitPrice,OrderNo,PartNumber,Name,Quantity`
2. 缺失欄位標註「待確認」，不中斷流程
3. 放入 `data/purchases/[product-id].csv`
4. 執行 `python3 data/generate_stats.py`
5. 檢查 `data/stats.json` 是否更新

### 輸出格式
- 📊 統計摘要：總筆數、TOP 3 零件、客戶數、月份跨度
- 🔗 查看器連結：`http://localhost:9001/viewer.html?product=[id]#stats`

### 自我檢查
- [ ] stats.json 時間戳已更新
- [ ] TOP 零件與原始 CSV 一致
- [ ] 無負數數量或異常單價

---

## Loop 3：程式碼安全審查

### 輸入
- 變更的檔案列表：[貼上 git diff 清單]
- 變更內容：[貼上 diff 或描述]

### 審查清單
1. **XSS**：所有使用者可控資料是否經過 `EzBOMSanitize.escapeHtml()`？
2. **路徑遍歷**：伺服器端 `httpd.js` 是否過濾 `../`？
3. **CSP**：`httpd.js` 的 CSP 標頭是否涵蓋新增資源？
4. **密碼安全**：管理員密碼是否使用 SHA-256 hash（禁止明文）？
5. **CSV 注入**：採購 CSV 寫入時是否過濾 `=` / `+` / `-` / `@` 開頭？
6. **innerHTML**：`viewer.js` 中是否有未經 `safeHTML()` 的直接 innerHTML 賦值？

### 輸出格式
```
| # | 檢查項   | 結果   | 問題描述 | 建議 |
|---|---------|--------|---------|------|
| 1 | XSS     | ✅/❌  | ...     | ...  |
```

### 自我檢查
- [ ] 所有 ❌ 項已修復
- [ ] 無直接 innerHTML 賦值
- [ ] `sanitize.js` 的 escapeHtml 涵蓋所有特殊字元

---

## Loop 4：程式碼修改（通用）

### 輸入
- 需求描述：[要做什麼]
- 涉及檔案：[viewer.js / admin.html / httpd.js / serve.js / ...]

### 處理規則
1. 先讀取相關檔案，理解現有結構
2. 遵循現有風格：IIFE 模式、`var` 宣告、中文註解、模組分離
3. 修改後自我檢查：不改動不相關程式碼
4. 如果修改 `viewer.js`，同步檢查 `viewer.html` 中嵌入的版本
5. 如果修改伺服器端，重啟 `httpd.js` 驗證

### 輸出格式
- 修改的檔案與行數
- 修改說明
- 測試方式

### 自我檢查
- [ ] 符合 Karpathy 準則（不重構沒壞的東西）
- [ ] 遵循 EzBOM 既有 code style
- [ ] `node httpd.js` 可正常啟動
- [ ] 前端功能手動測試通過

---

## Loop 5：部署檢查

### 輸入
- 部署目標：[local / 公網隧道 / 永久網址]
- 變更清單：[本次變更內容]

### 檢查清單
1. 所有檔案路徑是否使用相對路徑？
2. `products.json` 中的 emailTo 是否設定正確？
3. `httpd.js` 的 CSP 標頭是否為正式環境設定？
4. `ADMIN_PASSWORD_HASH` 是否已更換為正式密碼？
5. 靜態資源（CSS/JS/圖片）是否完整？

### 輸出格式
```
| # | 檢查項       | 結果   | 備註 |
|---|-------------|--------|------|
| 1 | 相對路徑     | ✅     |      |
| 2 | 收件信箱     | ⚠      | 仍為 example.com |
```

### 自我檢查
- [ ] 所有 ⚠ 項已確認或修正
- [ ] 生產環境可訪問
