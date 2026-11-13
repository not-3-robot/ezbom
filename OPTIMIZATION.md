# EzBOM 专案优化清单

> 审查日期：2026-08-10
> 审查范围：全部原始码（viewer.js / viewer.html / viewer.css / admin.html / index.html / sanitize.js / analytics.js / workers / products.json / deploy.sh / 文件）

---

## 🔴 P0 - 安全问题（建议优先处理）

### #1 `EZBOM_STATS_KEY` 从未真正设定

**位置**：`viewer.html:10`、`index.html:82`、`admin.html:174`

三个 HTML 档案里都是预设占位值：
```js
var EZBOM_STATS_KEY = 'ezbom-stats-key-change-me';
```

Worker 端也是同样的预设值：
```js
// workers/analytics-worker.js:20
const STATS_API_KEY = env => (env.STATS_API_KEY || 'ezbom-stats-default-key-2026');
```

**问题**：API key 保护形同虚设，任何人都能读取统计数据。而且 key 本身就写在前端 HTML 里，等于完全公开。

**修复方向**：
- 在 Cloudflare Worker 的 `wrangler.toml` 设定真正的随机 key（`node -e "console.log(crypto.randomUUID())"`）
- 前端三处同步更新
- 或改用 Worker 端 session/token 机制，不把 key 放前端

---

### #2 `admin.html` 有 XSS 漏洞

**位置**：`admin.html` 第 308、320、341、356 行

`renderStats()` 函数直接用 `innerHTML` 插入来自 `stats.json` 的资料，完全没有过 `escapeHtml`：

```js
// 第 308 行 - m.month 未转义
return '<tr><td style="width:80px">' + m.month + '</td>...';

// 第 341 行 - p.partNumber, p.name 未转义
return '<tr><td>' + (i+1) + '</td><td style="font-weight:600">' + p.partNumber + '</td><td style="color:#87867F">' + p.name + '</td>...';
```

`sanitize.js` 已载入但 `admin.html` 中完全没有使用。

**修复方向**：所有动态插入的值都用 `EzBOMSanitize.escapeHtml()` 包裹。

---

### #3 管理员密码明文写在文件中

**位置**：`README.md:60`

```markdown
预设密码：webom2024
```

Hash 也硬编码在前端 JS 中（`viewer.js:45`、`admin.html:185`），可以离线暴力破解。

**修复方向**：
- 移除 README 中的明文密码
- 更换为更强的密码
- 考虑将密码验证移到 Worker 端

---

## 🟠 P1 - 程式码品质

### #4 `hashPassword` / `simpleHash` 重复实作

**位置**：`viewer.js:76-98`、`admin.html:188-204`

同一段 SHA-256 + 降级 hash 逻辑同时出现在两处，完全复制贴上。

**修复方向**：抽到共用模组 `auth.js`，两处引入。

---

### #5 `viewer.js` 的 `ADMIN_PASSWORD_HASH` 永远为空

**位置**：`viewer.js:41`

```js
var ADMIN_PASSWORD_HASH = '';  // 永远空字串
```

实际上都走 `DEFAULT_HASH` fallback。这个变数没有任何作用。

**修复方向**：移除此变数，或改为从外部设定档读取。

---

### #6 程式码风格不一致

| 档案 | 风格 |
|------|------|
| `viewer.js` | ES5（`var`, `function()`） |
| `admin.html` | ES6+（`const/let`, `=>`） |
| `index.html` | ES6+（`const/let`, `=>`） |

`viewer.js` 是最大的档案（1139 行），却用最旧的语法。

**修复方向**：统一为 ES6+，或保持 ES5 但全部一致。

---

### #7 `README.md` 仍记录已移除的暗色模式快捷键

**位置**：`README.md:82`

```markdown
| `Ctrl+Shift+D` | 切换暗色模式 |
```

暗色模式已于 2026-06-10 移除，但文件仍列此快捷键。

**修复方向**：删除此行。

---

### #8 `CLAUDE.md` 路径错误

**位置**：`CLAUDE.md:12`

```bash
cd "/Users/zone/Documents/Sales/样本＆使用手册/冠亚/EzBOM"  # ← 现行路径
```

实际路径为 `/Users/zone/Documents/Sales/样本＆使用手册/冠亚/EzBOM`

**修复方向**：更新路径。

---

## 🟡 P2 - 效能优化

### #9 `updateStats()` 每次都重建整个 DOM

**位置**：`viewer.js:555-609`

每次切换零件选择时，`updateStats()` 会 `list.innerHTML = ''` 然后重建所有已选零件的 DOM。选了 20+ 个零件时，每次点击都造成不必要的 reflow。

**修复方向**：增量更新（只新增/移除变化的项目），或用 DocumentFragment。

---

### #10 QR Code 依赖外部 API

**位置**：`index.html:207`

```js
img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=...'
```

**问题**：
- 依赖第三方服务可用性
- 在中国大陆可能被墙
- 不能离线使用

**修复方向**：用轻量纯 JS QR 生成库（如 `qrcode-generator`，~6KB），或直接用 `deploy.sh` 里的 `npx qrcode` 产生静态 PNG 放入专案。

---

### #11 无 Service Worker / 离线快取

目前无 `service-worker.js`、无 `manifest.json`。SVG、CSV、JSON 每次都重新 fetch。

**修复方向**：
- 加入 Service Worker 快取静态资源
- 加 `manifest.json` 做 PWA 安装
- 这也是 TODOS.md 里的 P3 项目

---

### #12 SVG 安全过滤效能

**位置**：`viewer.js:317-322`

```js
svgEl.querySelectorAll('*').forEach(function(el) {
  var attrs = el.getAttributeNames();
  attrs.forEach(function(name) {
    if (name.indexOf('on') === 0) el.removeAttribute(name);
  });
});
```

对大型 SVG（Inkscape 汇出的可能有上千个元素），`querySelectorAll('*')` 会非常慢。

**修复方向**：只检查 `<g>` 和有 `on*` 属性的元素（`svgEl.querySelectorAll('[onload], [onclick], [onmouseover], ...]`），或用 `TreeWalker`。

---

## 🟢 P3 - UX / 功能改进

### #13 无 Email 格式验证

**位置**：`viewer.js:637-643`

```js
if (!emailTo) {  // 只检查非空
  showToast('请先输入询价收件信箱');
  return;
}
```

不验证 email 格式，输入 `abc` 也能触发 mailto。

**修复方向**：加入正则验证：
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

使用者每次首次使用都要手动输入信箱。

**修复方向**：填入公司预设询价信箱。

---

### #15 手机版无 SVG 缩放控制

**位置**：`viewer.js:787`（只有桌面版加缩放按钮）

桌面版有 `+` `−` `↺` 按钮和 `Ctrl+滚轮`缩放，手机版完全没有。CSS 设了 `touch-action: pinch-zoom` 但没有 JS 实作 pinch-to-zoom。

这也是 `TODOS.md` 里的 P1 问题。

**修复方向**：
- 实作 touch event pinch-to-zoom
- 或至少在手机版也显示缩放按钮

---

### #16 无 Favicon

三个页面都没有 favicon，浏览器 tab 显示预设图示。

**修复方向**：加一个简单的 SVG favicon（齿轮图示）。

---

### #17 `index.html` 大量 inline style

**位置**：`index.html:7-78`

70+ 行的 `<style>` 块。为了与 `viewer.css` 保持一致架构，建议也抽成 `index.css`。

**修复方向**：抽出为独立 CSS 档案。

---

## 🔵 架构层面观察

### #18 Worker `/stats` API key 在前端暴露

**位置**：所有 HTML 档案

这是静态网站的固有问题。API key 写在 HTML 里，任何人都能看见。

**修复方向**：
- `/stats` 端点加 IP 白名单
- 或改用 Worker 端 session/token 机制（密码验证后发短期 token）

---

### #19 Worker 无速率限制

**位置**：`workers/analytics-worker.js:46-104`

`/event` 端点只检查 Origin，没有限流。恶意脚本可以从允许的 origin 发送大量假事件，灌爆 KV 配额（免费方案每日 1,000 次写入）。

**修复方向**：
- 用 KV 实作简易速率限制（每 IP 每分钟上限）
- 或升级 Cloudflare Workers 付费方案

---

### #20 localStorage 分析事件无过期清理

**位置**：`analytics.js:50-55`

只限制最多 1000 笔，但不按时间清理。长期使用后旧事件会占满配额。

**修复方向**：加入时间戳检查，超过 90 天的事件自动清除（与 Worker KV 的 90 天 TTL 一致）。

---

## 📋 建议处理顺序

| 优先级 | 项目 | 预估工作量 | 状态 |
|--------|------|-----------|------|
| 🔴 P0 | #1 设定真正的 STATS_API_KEY | 10 分钟 | ☐ |
| 🔴 P0 | #2 admin.html XSS 修复 | 30 分钟 | ☐ |
| 🔴 P0 | #3 移除 README 明文密码 | 5 分钟 | ☐ |
| 🟠 P1 | #4 抽出共用 auth 模组 | 1 小时 | ☐ |
| 🟠 P1 | #5 移除无用的 ADMIN_PASSWORD_HASH | 5 分钟 | ☐ |
| 🟠 P1 | #6 统一程式码风格 | 2 小时 | ☐ |
| 🟠 P1 | #7 修正 README 暗色模式快捷键 | 2 分钟 | ☐ |
| 🟠 P1 | #8 修正 CLAUDE.md 路径 | 2 分钟 | ☐ |
| 🟡 P2 | #9 updateStats 增量更新 | 1 小时 | ☐ |
| 🟡 P2 | #10 QR Code 改离线方案 | 30 分钟 | ☐ |
| 🟡 P2 | #11 PWA 离线支援 | 2-3 小时 | ☐ |
| 🟡 P2 | #12 SVG 过滤效能优化 | 30 分钟 | ☐ |
| 🟢 P3 | #13 Email 格式验证 | 10 分钟 | ☐ |
| 🟢 P3 | #14 填入预设询价信箱 | 5 分钟 | ☐ |
| 🟢 P3 | #15 手机 pinch-zoom | 2-3 小时 | ☐ |
| 🟢 P3 | #16 加入 Favicon | 10 分钟 | ☐ |
| 🟢 P3 | #17 index.html 抽 CSS | 15 分钟 | ☐ |
| 🔵 架构 | #18 Worker API key 机制改造 | 3-4 小时 | ☐ |
| 🔵 架构 | #19 Worker 速率限制 | 1-2 小时 | ☐ |
| 🔵 架构 | #20 localStorage 事件过期清理 | 30 分钟 | ☐ |
