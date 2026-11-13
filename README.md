# EzBOM — 齿轮箱零件询价系统

静态网页 BOM 查看器，让客户透过爆炸图选取零件、调整数量、发送询价邮件。内建采购统计仪表板（管理员限定）。

## 专案结构

```
EzBOM/
├── index.html          # 产品列表首页
├── viewer.html         # 爆炸图查看器（HTML 结构）
├── viewer.css          # 查看器样式表（从 viewer.html 拆分）
├── viewer.js           # 查看器核心逻辑（从 viewer.html 拆分）
├── sanitize.js         # XSS 防护共用模组
├── analytics.js        # 前端分析（Cloudflare Worker + localStorage 备援）
├── admin.html          # 管理仪表板
├── products.json       # 产品清单设定（含收件信箱）
├── products/
│   └── p-type/
│       ├── drawing.svg # Inkscape 爆炸图
│       └── bom.csv     # 零件清单
├── data/
│   ├── purchases/      # 采购记录 CSV（供统计用）
│   │   └── p-type.csv
│   ├── stats.json      # 由 generate_stats.py 产生
│   ├── generate_stats.py
│   └── test_generate_stats.py
├── workers/
│   ├── analytics-worker.js  # Cloudflare Worker（分析后端）
│   └── wrangler.toml
├── deploy.sh           # 一键部署至 GitHub Pages + QR Code
└── 参考文件/            # 原始参考资料（gitignore）
```

## 快速启动

```bash
# 本地测试（任选一种）
cd EzBOM
python3 -m http.server 9001
# 开启 http://localhost:9001

# 或用 node
npx serve -p 9001
```

## 如何新增产品

1. 在 `products/` 下建立新目录，放入 `drawing.svg`（Inkscape 汇出）和 `bom.csv`
2. 编辑 `products.json` 加入新产品
3. SVG 中的零件群组需有 `inkscape:label="P01-..."` 属性（格式：`P<编号>-<名称>`）

BOM CSV 格式：
```csv
Id,ItemNo,PartNumber,Name,Quantity
P01,1,400198,C型扣环<R-47>,1
```

## 管理员功能

采购统计受密码保护。预设密码：`webom2024`（使用 SHA-256 hash 储存，不再明文）

修改密码：
1. 产生新密码的 SHA-256 hash：`echo -n '你的密码' | shasum -a 256`
2. 编辑 `viewer.html` 和 `admin.html` 中的 `ADMIN_PASSWORD_HASH` 变数

## 采购统计

1. 在 `data/purchases/` 下放入 CSV（格式同 BOM，加上 Date/Customer/UnitPrice/OrderNo 栏位）
2. 执行 `python3 data/generate_stats.py` 产生 `stats.json`
3. 前端会自动读取显示

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `↑` `↓` | BOM 清单上下导航 |
| `Enter` | 选取/取消当前零件 |
| `Ctrl+Z` | 复原上一步选择 |
| `Ctrl+A` | 全选所有零件 |
| `Esc` | 清除全部选择 |
| `/` | 聚焦搜寻框 |
| `Ctrl+Shift+D` | 切换暗色模式 |

## 安全功能

- **路径遍历防护**：伺服器端防止 `../` 攻击
- **CSP 标头**：防止 XSS 与资源注入
- **SHA-256 密码**：管理员密码使用 hash 储存，不暴露明文
- **XSS 防护**：所有使用者可控资料经过 HTML 转义
- **SVG 安全注入**：使用 DOMParser 解析 SVG，过滤 `<script>` 与事件属性
- **Worker Origin 白名单**：只接受已授权网站的 POST 事件
- **Worker API Key**：`/stats` 端点需要 API key 验证

## 部署

### 前端（GitHub Pages）

```bash
bash deploy.sh
# 自动 git push → 等待 GitHub Pages → 生成 QR Code
```

### 分析后端（Cloudflare Worker）

```bash
cd workers
# 修改 wrangler.toml 中的 STATS_API_KEY 为你的随机 key
# 产生方式：node -e "console.log(crypto.randomUUID())"
npx wrangler deploy
```

部署后在前端页面设定 Worker URL 和 Stats API key：
```html
<script>
  var EZBOM_WORKER_URL = 'https://your-worker.workers.dev';
  var EZBOM_STATS_KEY = 'your-stats-api-key';
</script>
```
