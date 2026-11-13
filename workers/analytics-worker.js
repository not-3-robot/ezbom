// EzBOM Analytics — Cloudflare Worker + KV
// 接收事件、储存至 KV、提供汇总 API
//
// 安全策略：
//   1. Origin 白名单 — 只接受来自已授权网站的请求
//   2. API Key — /stats 端点需要 API key 验证
//   3. 计数器模式 — 使用单一汇总 key，避免逐笔读取

// ---- 授权设定（部署时修改） ----
const ALLOWED_ORIGINS = [
  'https://not-3-robot.github.io',
  'http://localhost:9001',
  'http://localhost:8000',
  'http://127.0.0.1:9001',
  'http://127.0.0.1:8000',
];

// /stats 端点验证用 API key（部署时更改）
// 产生方式：crypto.randomUUID()
const STATS_API_KEY = env => (env.STATS_API_KEY || 'ezbom-stats-default-key-2026');

const SUMMARY_KEY = 'summary:global';
const RECENT_ERRORS_KEY = 'recent_errors';
const MAX_RECENT_ERRORS = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CORS：动态产生 Allow-Origin ----
    const origin = request.headers.get('Origin') || '';
    const isAllowed = ALLOWED_ORIGINS.includes(origin);
    const corsOrigin = isAllowed ? origin : '';
    const headers = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // ---- POST /event — 写入事件（需 origin 白名单） ----
    if (request.method === 'POST' && url.pathname === '/event') {
      if (!isAllowed) {
        return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers });
      }
      try {
        const payload = await request.json();

        // 基本栏位验证
        if (!payload || typeof payload !== 'object' || !payload.type) {
          return new Response(JSON.stringify({ ok: false, error: 'invalid payload' }), { status: 400, headers });
        }

        // 更新汇总计数器（原子读写）
        const raw = await env.ANALYTICS.get(SUMMARY_KEY);
        const summary = raw ? JSON.parse(raw) : {
          total: 0, pageviews: 0, selects: 0, inquiries: 0, errors: 0,
          devices: {}, products: {}, topParts: {},
        };

        summary.total++;
        if (payload.type === 'pageview') summary.pageviews++;
        else if (payload.type === 'select') summary.selects++;
        else if (payload.type === 'inquiry') {
          summary.inquiries++;
          if (payload.partNumbers) {
            payload.partNumbers.split('|').forEach(pn => {
              summary.topParts[pn] = (summary.topParts[pn] || 0) + 1;
            });
          }
        }
        else if (payload.type === 'error') summary.errors++;

        if (payload.device) {
          summary.devices[payload.device] = (summary.devices[payload.device] || 0) + 1;
        }
        if (payload.product) {
          summary.products[payload.product] = (summary.products[payload.product] || 0) + 1;
        }

        await env.ANALYTICS.put(SUMMARY_KEY, JSON.stringify(summary));

        // 错误事件另存最近 20 笔
        if (payload.type === 'error') {
          const errRaw = await env.ANALYTICS.get(RECENT_ERRORS_KEY);
          const errors = errRaw ? JSON.parse(errRaw) : [];
          errors.unshift({
            ts: payload.timestamp || new Date().toISOString(),
            msg: String(payload.message || '').substring(0, 200),
            device: payload.device || 'unknown',
          });
          if (errors.length > MAX_RECENT_ERRORS) errors.length = MAX_RECENT_ERRORS;
          await env.ANALYTICS.put(RECENT_ERRORS_KEY, JSON.stringify(errors));
        }

        return new Response(JSON.stringify({ ok: true }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers });
      }
    }

    // ---- GET /stats — 汇总统计（需 API key） ----
    if (request.method === 'GET' && url.pathname === '/stats') {
      const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key') || '';
      if (apiKey !== STATS_API_KEY(env)) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers });
      }

      const raw = await env.ANALYTICS.get(SUMMARY_KEY);
      const summary = raw ? JSON.parse(raw) : {
        total: 0, pageviews: 0, selects: 0, inquiries: 0, errors: 0,
        devices: {}, products: {}, topParts: {}, recentErrors: [],
      };

      // 附加最近错误
      const errRaw = await env.ANALYTICS.get(RECENT_ERRORS_KEY);
      summary.recentErrors = errRaw ? JSON.parse(errRaw) : [];

      return new Response(JSON.stringify(summary), { headers });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
  }
};
