# EzBOM Loop 模板集

> 齿轮箱零件询价系统的工作流程模板。
> 每次执行对应任务时，将下方模板 + 你的输入资料一起喂给 Claude。

---

## Loop 1：新增产品

### 输入
- Inkscape SVG 爆炸图：[贴上档案路径或内容]
- BOM CSV（零件清单）：[贴上内容]
- 产品资讯：名称、型号、收件信箱（可选）

### 处理规则
1. 读取 SVG，提取所有 `inkscape:label="P01-..."` 标签
2. 检查 CSV 格式：`Id,ItemNo,PartNumber,Name,Quantity`
3. 对齐 SVG 标签与 CSV 的 PartNumber，列出不一致项
4. 将 SVG 放入 `products/[id]/drawing.svg`
5. 将 CSV 放入 `products/[id]/bom.csv`
6. 更新 `products.json` 加入新产品

### 输出格式
- ✅ 对齐报告：SVG 有但 CSV 无 / CSV 有但 SVG 无
- ✅ 新增/修改的档案列表
- ⚠ 警告事项（如信箱未设定）

### 自我检查
- [ ] SVG 档案存在且含正确 labels
- [ ] CSV 编码为 UTF-8
- [ ] products.json 格式正确
- [ ] `node httpd.js` 本地测试可载入

---

## Loop 2：更新采购统计

### 输入
- 采购 CSV：[贴上内容或档案路径]
- 产品 ID：[p-type / p-type-2 / ...]

### 处理规则
1. 检查 CSV 栏位：`Date,Customer,UnitPrice,OrderNo,PartNumber,Name,Quantity`
2. 缺失栏位标注「待确认」，不中断流程
3. 放入 `data/purchases/[product-id].csv`
4. 执行 `python3 data/generate_stats.py`
5. 检查 `data/stats.json` 是否更新

### 输出格式
- 📊 统计摘要：总笔数、TOP 3 零件、客户数、月份跨度
- 🔗 查看器连结：`http://localhost:9001/viewer.html?product=[id]#stats`

### 自我检查
- [ ] stats.json 时间戳已更新
- [ ] TOP 零件与原始 CSV 一致
- [ ] 无负数数量或异常单价

---

## Loop 3：程式码安全审查

### 输入
- 变更的档案列表：[贴上 git diff 清单]
- 变更内容：[贴上 diff 或描述]

### 审查清单
1. **XSS**：所有使用者可控资料是否经过 `EzBOMSanitize.escapeHtml()`？
2. **路径遍历**：伺服器端 `httpd.js` 是否过滤 `../`？
3. **CSP**：`httpd.js` 的 CSP 标头是否涵盖新增资源？
4. **密码安全**：管理员密码是否使用 SHA-256 hash（禁止明文）？
5. **CSV 注入**：采购 CSV 写入时是否过滤 `=` / `+` / `-` / `@` 开头？
6. **innerHTML**：`viewer.js` 中是否有未经 `safeHTML()` 的直接 innerHTML 赋值？

### 输出格式
```
| # | 检查项   | 结果   | 问题描述 | 建议 |
|---|---------|--------|---------|------|
| 1 | XSS     | ✅/❌  | ...     | ...  |
```

### 自我检查
- [ ] 所有 ❌ 项已修复
- [ ] 无直接 innerHTML 赋值
- [ ] `sanitize.js` 的 escapeHtml 涵盖所有特殊字元

---

## Loop 4：程式码修改（通用）

### 输入
- 需求描述：[要做什么]
- 涉及档案：[viewer.js / admin.html / httpd.js / serve.js / ...]

### 处理规则
1. 先读取相关档案，理解现有结构
2. 遵循现有风格：IIFE 模式、`var` 宣告、中文注解、模组分离
3. 修改后自我检查：不改动不相关程式码
4. 如果修改 `viewer.js`，同步检查 `viewer.html` 中嵌入的版本
5. 如果修改伺服器端，重启 `httpd.js` 验证

### 输出格式
- 修改的档案与行数
- 修改说明
- 测试方式

### 自我检查
- [ ] 符合 Karpathy 准则（不重构没坏的东西）
- [ ] 遵循 EzBOM 既有 code style
- [ ] `node httpd.js` 可正常启动
- [ ] 前端功能手动测试通过

---

## Loop 5：部署检查

### 输入
- 部署目标：[local / 公网隧道 / 永久网址]
- 变更清单：[本次变更内容]

### 检查清单
1. 所有档案路径是否使用相对路径？
2. `products.json` 中的 emailTo 是否设定正确？
3. `httpd.js` 的 CSP 标头是否为正式环境设定？
4. `ADMIN_PASSWORD_HASH` 是否已更换为正式密码？
5. 静态资源（CSS/JS/图片）是否完整？

### 输出格式
```
| # | 检查项       | 结果   | 备注 |
|---|-------------|--------|------|
| 1 | 相对路径     | ✅     |      |
| 2 | 收件信箱     | ⚠      | 仍为 example.com |
```

### 自我检查
- [ ] 所有 ⚠ 项已确认或修正
- [ ] 生产环境可访问
