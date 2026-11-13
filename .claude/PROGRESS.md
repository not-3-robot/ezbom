# EzBOM 开发进度

最后更新：2026-06-10

---

## 已完成功能

### 核心系统
- [x] **模板化查看器** (`viewer.html`) — 通过 `?product=xxx` URL 参数动态加载产品数据
- [x] **产品清单页** (`index.html`) — 从 `products.json` 读取产品列表，点击进入查看器
- [x] **产品设定档** (`products.json`) — 集中管理所有产品（SVG 路径、BOM 路径、名称、型号）
- [x] **标准 BOM 格式** — CSV 含 Id, ItemNo, PartNumber, Name, Quantity 栏位
- [x] **CSV 相容性** — 同时支援中英文栏位名（Id/标签ID、PartNumber/料品编号等）
- [x] **静态档案架构** — 无后端，纯前端 + 静态 JSON/CSV/SVG，HTTP Server 即可运行

### SVG 爆炸图交互
- [x] **SVG 载入** — 从外部路径动态 fetch SVG 并注入 DOM
- [x] **零件自动识别** — 解析 `inkscape:label="P01-零件名"` 属性，匹配 BOM 数据
- [x] **hover 放大 1.1 倍** — 纯 CSS 实现，无 JS 延迟（0.12s transition）
- [x] **hover 变色** — stroke 变 #D97757 + 浅色 fill
- [x] **点击选中** — 选中后保持高亮 + 1.1x 放大
- [x] **浮动标签** — 滑鼠悬停时显示零件编号，位置跟随零件坐标
- [x] **标签坐标映射** — SVG viewBox 坐标正确转换为 CSS 像素坐标
- [x] **resize 重新定位** — 视窗缩放时标签重新计算位置
- [x] **SVG label ID 修复** — 原 P26 重复问题（一个 C 型扣环、一个油盖）已修正

### BOM 清单功能
- [x] **零件列表渲染** — 从 CSV 数据动态生成
- [x] **搜索过滤** — 按零件编号或名称即时过滤
- [x] **全选 / 清除** — 批量操作
- [x] **统计面板** — 已选种数、总数量
- [x] **可编辑数量** — 已选清单中可直接修改询价数量
- [x] **双向选择** — 点击清单或 SVG 均可选中/取消，两者同步
- [x] **去重保护** — 防止 initBOMList 重复调用导致列表重复

### 询价输出
- [x] **mailto 发送** — 打开系统邮件客户端，自动填入主题和正文
- [x] **自定义数量** — 询价数量可逐项调整
- [x] **发送确认** — 弹窗确认后再打开邮件

### 手机端适配
- [x] **响应式布局** — <=768px 改为上下切换，底部 Tab 栏
- [x] **Tab 切换** — 「爆炸图」/「零件清单」两个 Tab
- [x] **SVG 填满萤幕** — 手机上 SVG 面板占 60vh
- [x] **双指缩放** — 允许 pinch zoom（移除 user-scalable=no）
- [x] **触控延迟消除** — touch-action: manipulation
- [x] **点击反馈** — 手机点击零件显示标签 1.2 秒 + 短暂高亮动画
- [x] **产品列表手机适配** — 单列卡片布局，无 SVG 预载加快速度

---

## 当前状态

可正常使用的核心流程：
```
index.html → 点击产品 → viewer.html?product=p-type
                         ├── 载入 SVG + CSV
                         ├── 爆炸图 hover/点击选零件
                         ├── BOM 清单搜索/全选
                         └── 发送询价邮件
```

目前只有一个产品（P 型齿轮箱），但架构已准备好扩充。

---

## 待开发 / 已知问题

### P1 - 影响使用
- [ ] SVG 零件标签位置在某些缩放比例下仍然偏移（getBBox 在嵌套 transform 下不稳定）
- [ ] 手机上 SVG 零件太小，精准点击困难（需要点击辅助或放大镜功能）

### P2 - 功能缺失
- [ ] **汇出报价单**（PDF / Excel / 纯文字）— 目前只有 mailto
- [ ] **产品分类** — 上百种产品时需要分类/标签过滤
- [ ] **BOM 编辑** — 直接在网页上编辑零件数据（目前需改 CSV）
- [ ] **历史记录** — 已发送的询价记录保存

### P3 - 改进
- [ ] **批量添加产品** — 脚本扫描目录自动生成 products.json
- [ ] **DWG → SVG 转换** — 参考图纸中有 .dwg 文件，目前无法直接使用
- [ ] **多语系** — 目前仅繁体中文
- [ ] **启动脚本** — 一键启动 + QR Code 生成
- [ ] **离线 PWA** — Service Worker 快取 SVG/CSV，无网路可用

### 采购统计（新增）
- [x] **采购记录格式** — `data/purchases/<产品ID>.csv`，含日期、客户、料号、数量、单价
- [x] **统计生成脚本** — `data/generate_stats.py`，一键计算 top 零件、客户排名、月度趋势
- [x] **前端统计 Tab** — viewer.html 第三个 Tab「采购统计」，显示高频零件、客户排名、长条图
- [ ] **自动定期更新** — cron 每周跑 generate_stats.py
- [ ] **采购记录在线录入** — 网页表单新增采购记录，暂存 localStorage

---

## 如何新增一个产品

```json
// products.json 加一行：
{
  "id": "k-type",
  "name": "K型齿轮箱",
  "model": "K-TYPE",
  "svg": "参考图纸/k_type.svg",
  "bom": "products/k-type/bom.csv"
}
```

CSV 格式（复制 `products/p-type/bom.csv` 修改）：
```csv
Id,ItemNo,PartNumber,Name,Quantity
P01,1,400001,零件A,1
P02,2,400002,零件B,2
```

SVG 要求：Inkscape 导出的 SVG，每个零件的 `<g>` 要有 `inkscape:label="P01-零件名"` 这样的属性。

---

## 技术栈

- 纯前端（HTML + CSS + Vanilla JS）
- 无任何依赖库
- 运行只需要：`python3 -m http.server 8000 --bind 0.0.0.0`
- 数据格式：JSON（products.json）+ CSV（BOM 数据）
- SVG：Inkscape 导出格式，inkscape:label 属性做零件标记

---

## 2026-06-04 — GitHub Pages 部署 + localStorage 分析 + 手机相容

### GitHub Pages 部署 (最终方案)
- [x] 部署到 `https://not-3-robot.github.io/ezbom`
- [x] 透过 GitHub API 自动启用 Pages（branch: main, path: /）
- [x] 部署状态: built ✅
- [x] 首页、viewer、admin 全部 200，零错误

> Vercel (`ezbom.vercel.app`) 曾成功部署，但中国大陆手机 4G 网路无法存取（CDN 节点全在美国）
> Netlify 同样面临中国封锁，`netlify.app` 域名被墙
> Gitee Pages 多次尝试未成功（可能需实名认证或人工审核）
> serveo.net 隧道在中国手机可存取，作为备用方案

### analytics.js — localStorage 版（中国适用）
- [x] 事件存入 localStorage（上限 1000 笔），不需要后端 API
- [x] 四种事件：pageview / select / inquiry / error
- [x] 全域错误捕捉：window.onerror + unhandledrejection
- [x] 设备检测：OS、浏览器、萤幕、DPR、语言、微信内建浏览器
- [x] `exportCSV()` 汇出功能
- [x] `getSummary()` 统计摘要（含设备/产品分布）
- [x] `clear()` 清除数据
- [x] index.html / viewer.html / admin.html 全事件追踪

### admin.html — 管理仪表板
- [x] KPI 卡片（产品数、零件数、客户数、采购次数、浏览量、询价次数）
- [x] 月度趋势长条图（来自 stats.json）
- [x] 设备分布图（来自 localStorage analytics）
- [x] 零件采购 TOP 10（来自 stats.json）
- [x] JS 错误追踪（来自 localStorage）
- [x] CSV 汇出 + 清除数据按钮
- [x] 密码保护（webom2024）

### 手机跨平台相容
- [x] viewport-fit=cover（iPhone notch 安全区域）
- [x] safe-area-inset-bottom（底部 Tab 不遮挡）
- [x] 行动版 SVG 禁用 drop-shadow（iOS Safari GPU 效能问题）
- [x] 行动版 Tab 按钮 min-height: 44px（iOS HIG 最低触摸目标）
- [x] Android mailto 备用方案（弹窗显示内容 + 复制到剪贴簿）
- [x] Web Share API 整合 + Clipboard API 降级

### 分享功能
- [x] index.html — QR Code（api.qrserver.com）+ Web Share API
- [x] viewer.html — 产品分享按钮（Share API / Clipboard）
- [x] 降级策略：Share API → Clipboard API → prompt()

### Python 测试
- [x] `data/test_generate_stats.py` — 13 项测试全部通过
- [x] 测试范围：topParts、topCustomers、monthlyStats、hotParts、空记录、边界值
- [x] generate_stats.py 修正：空记录回传含 hotParts 栏位

### 档案变更摘要
```
新增: analytics.js, admin.html, data/test_generate_stats.py, .vercelignore
修改: index.html, viewer.html, .gitignore, data/generate_stats.py
移除: vercel.json, api/log.js, netlify/, serve.js (deprecated)
```

---

## 2026-06-10 — 暗色模式移除 + 分析后端云端化 + 一键部署脚本

### 暗色模式移除
- [x] 移除 viewer.html 中的 🌓 切换按钮
- [x] 删除 viewer.css 中 `@media (prefers-color-scheme: dark)` 及所有 `.dark-mode-enabled` 样式（107 行）
- [x] 移除 viewer.js 中 `initDarkMode()`、`toggleDarkMode()`、键盘快捷键 `Ctrl+Shift+D`
- [x] 原因：暗色模式时爆炸图 SVG 看不见（深色零件在深色背景上消失）

### 管理后台修正
- [x] 修正 admin.html 密码验证 — `DEFAULT_HASH` 原为假占位值，更换为 `webom2024` 的正确 SHA-256 hash
- [x] 后台现可正常登入，密码：`webom2024`

### analytics.js → Cloudflare Worker 云端化
- [x] 原 `analytics.js` 仅存 localStorage（换装置数据消失）→ 重构为双通道：Cloudflare Worker（主）+ localStorage（备援）
- [x] 建立 Cloudflare Worker：`workers/analytics-worker.js`
  - `POST /event` — 接收事件并存入 KV
  - `GET /stats` — 汇总统计（pageviews、inquiries、errors、devices、products、topParts、recentErrors）
  - KV 自动过期：90 天
- [x] 建立 KV Namespace：`ANALYTICS`（id: `db15922249ed4ef2a0966ded2fad058b`）
- [x] 部署至 `https://ezbom-analytics.notnotnotrobot.workers.dev`
- [x] admin.html 标头显示 `☁️ Cloudflare Worker`，标记当前使用云端数据源
- [x] index.html、viewer.html、admin.html 均配置 `EZBOM_WORKER_URL`，事件自动上传云端
- [x] `getSummary(callback)` 非同步 API：优先读取 Worker，降级合并 localStorage

### 一键部署脚本 deploy.sh
- [x] `bash deploy.sh`：自动 git push → 等待 GitHub Pages 部署 → 生成 QR 码 PNG → 自动打开
- [x] QR 码输出至 `~/Downloads/EzBOM-qrcode.png`，URL：`https://not-3-robot.github.io/ezbom/`
- [x] 不需再手动处理 localtunnel、IP、port

### 档案变更摘要
```
新增: deploy.sh, workers/analytics-worker.js, workers/wrangler.toml
修改: analytics.js (重构), admin.html (Worker 整合 + 密码修正), viewer.html, viewer.css, viewer.js (暗色模式移除), index.html (Worker URL)
```

### Cloudflare Workers KV 容量与限制

| 项目 | 限制 | 说明 |
|------|------|------|
| 事件保留天数 | 90 天 | `expirationTtl: 7776000` 秒，满期自动删除 |
| 最多事件数 | 1,000 笔 | 免费方案每命名空间 1,000 key |
| 储存容量 | 1 GB | 1,000 笔约 500KB，远低于上限 |
| 每日写入次数 | 1,000 次 | 免费额度 |
| 每日读取次数 | 100,000 次 | 免费额度 |

### 产品爆炸图/BOM 与储存关系

产品爆炸图（SVG）和 BOM（CSV）存放于 **GitHub Pages**（1GB 免费），与 Cloudflare KV 分析储存**完全独立**。增加产品数量不影响 KV 的 1,000 笔事件上限。一个 SVG 约 50KB～2MB，500 个产品才逼近 1GB。分析事件仅记录 pageview、询价等轻量资讯，每笔约 500 字元。

### 代码清理（同日）
- [x] 修正 `viewer.js` 中的 `DEFAULT_HASH`（原 `9f1c5b6...` 假值 → 正确的 `6d23d68...`）
- [x] 删除废弃档案：`perfect.html`（早期原型）、`httpd.js`（与 serve.js 重复）、`serve.js`（已被 GitHub Pages 取代）、`serve.log`
- [x] 建立 `package.json`（正规化专案）
