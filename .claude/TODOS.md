# EzBOM 待解决问题

最后更新：2026-06-10

---

## 2026-06-10 已完成

### 暗色模式移除
- [x] 删除 viewer.html 切换按钮、viewer.css 暗色样式（107 行）、viewer.js 相关功能
- [x] 原因：暗色背景导致爆炸图 SVG 零件不可见

### 管理后台修正
- [x] admin.html 密码 hash 修正（原 DEFAULT_HASH 为假值，无法登入）
- [x] 密码：`webom2024`

### 分析系统云端化
- [x] analytics.js 重构 → 双通道：Cloudflare Worker (主) + localStorage (备援)
- [x] Cloudflare Worker 部署于 `ezbom-analytics.notnotnotrobot.workers.dev`
- [x] KV 储存事件，90 天自动过期
- [x] 后台标头显示 `☁️ Cloudflare Worker`（集中式数据）
- [x] 所有页面（index/viewer/admin）自动上传事件至 Worker

### 一键部署
- [x] `bash deploy.sh`：git push → 等部署 → 生成 QR → 自动打开

---

## 2026-06-04 已完成

### 部署与数据搜集
- [x] GitHub Pages 部署（`not-3-robot.github.io/ezbom`）
- [x] localStorage 版 analytics.js（pageview / select / inquiry / error）
- [x] 管理仪表板 admin.html（KPI、设备分布、错误追踪、CSV 汇出）
- [x] 手机跨平台相容（viewport-fit、safe-area、SVG filter、mailto 备用）
- [x] QR Code 分享 + Web Share API
- [x] Python 单元测试 13 项（data/test_generate_stats.py）
- [x] generate_stats.py 空记录 hotParts 修正

### 手机相容修正
- [x] SVG drop-shadow 在行动版禁用（iOS Safari 效能）
- [x] viewport-fit=cover + safe-area-inset-bottom（iPhone notch）
- [x] 行动版 Tab 按钮 min-height: 44px（iOS HIG）
- [x] Android mailto 备用方案（显示内容 + 复制到剪贴簿）

---

## 2026-05-23 遗留问题

## P1 - 高优先级

### SVG 零件标签偏移
- **现象**：在某些缩放比例或视窗大小下，浮动零件标签（橘色方块）偏离零件位置
- **原因**：`getBBox()` 在 SVG 嵌套 `<g>` 和 CSS transform 下回坐标不稳定；`getScreenCTM()` 在现代浏览器行为不一致
- **方向**：改用 `getBoundingClientRect()` 或遍历子元素取平均坐标

### 手机上点击小零件困难
- **现象**：手机上 SVG 爆炸图缩放到萤幕大小后，小零件（如螺丝、扣环）面积很小，手指难以精准点击
- **方向**：可考虑点击辅助（点击附近区域时弹出候选列表）、或双指放大后再点击

---

## P2 - 中优先级

### 汇出报价单
- **需求**：选择零件后可汇出 PDF / Excel / 纯文字格式的报价单
- **方案**：纯前端用 `html2pdf.js` 或 `SheetJS`，或直接用 mailto 发送格式化邮件

### 产品分类与筛选
- **需求**：上百种产品时，产品列表页需要分类（如齿轮箱类型、吨位、适用机型）和搜索
- **方案**：`products.json` 扩充 `category`、`tags` 栏位，index.html 加上分类 filter

### 线上式 BOM 编辑
- **需求**：直接在网页上修改零件数据（名称、数量、料号），自动保存到 CSV
- **限制**：静态页面无法写入本地文件，需要后端 API 或 File System Access API（仅 Chrome）

### DWG → SVG 转换
- **需求**：现有参考图纸中的 .dwg 文件需要转为 SVG 才能在 EzBOM 中使用
- **方案**：AutoCAD 导出 SVG，或用 `ezdxf` + `svglib` Python 库批量转换

---

## P3 - 低优先级

### 多语系
- **需求**：支援英文/简体中文界面
- **方案**：`<html lang>` + JS i18n 物件

### 启动脚本
- **需求**：一键启动 HTTP 服务 + 自动检测 IP + 生成 QR Code
- **方案**：`start.sh` 脚本（已写但未测试）

### 离线 PWA 支援
- **需求**：快取 SVG/CSV/JSON，无网路环境下也可使用
- **方案**：`service-worker.js` + manifest.json

### 询价历史记录
- **需求**：已发送的询价记录可查询、重复使用
- **方案**：localStorage 保存发送记录，或在 data/ 目录保存 JSON 日志

### 批量产品导入
- **需求**：一次导入多个产品的 CSV + SVG，自动生成 products.json
- **方案**：Python 脚本扫描 products/ 目录自动生成配置

---

## 采购统计相关待实现

### 客户购买频次统计
- **状态**：尚未开始
- **数据**：`data/purchases/` 目录下的 CSV 采购记录
- **方向**：需要一个 stats 页面或 viewer 中的统计 Tab

### 高频购买部品推荐
- **状态**：尚未开始
- **数据**：从采购记录计算 top N 零件
- **方向**：在 BOM 清单中用星号或标记标出高频零件

### 数据录入方式
- **状态**：待讨论
- **方案 A**：手动编辑 CSV（简单但繁琐）
- **方案 B**：网页上录入表单 + localStorage 暂存
- **方案 C**：从 ERP/进销存系统导出后转为 EzBOM 格式
