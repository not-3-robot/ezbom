/**
 * EzBOM Analytics — Cloudflare Worker 版 + localStorage 备援
 *
 * 事件同时发送至远端 Worker 与 localStorage。
 * 管理员仪表板优先读取 Worker 汇总，Worker 未部署时降级至 localStorage。
 *
 * Worker 部署后，在 admin.html 设定：<script>var EZBOM_WORKER_URL='...';</script>
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ezbom_analytics';
  var MAX_EVENTS = 1000;
  var WORKER_BASE = (typeof EZBOM_WORKER_URL !== 'undefined') ? EZBOM_WORKER_URL : '';

  function detectDevice() {
    var ua = navigator.userAgent;
    var os = 'unknown', browser = 'unknown', mobile = false;
    if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    if (/Safari/.test(ua) && !/Chrome|CriOS/.test(ua)) browser = 'Safari';
    else if (/Chrome|CriOS/.test(ua)) browser = 'Chrome';
    else if (/Firefox/.test(ua)) browser = 'Firefox';
    else if (/Edge|Edg/.test(ua)) browser = 'Edge';
    else if (/WeChat|MicroMessenger/.test(ua)) browser = 'WeChat';
    mobile = /Android|iPhone|iPad|iPod|webOS/i.test(ua) ||
             (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    return {
      os: os, browser: browser, mobile: mobile,
      screen: window.screen ? window.screen.width + 'x' + window.screen.height : '',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      language: navigator.language || 'unknown',
      dpr: window.devicePixelRatio || 1
    };
  }

  function getProductId() {
    var params = new URLSearchParams(window.location.search);
    return params.get('product') || 'index';
  }

  function loadEvents() {
    try { var raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }

  function saveEvents(events) {
    try {
      if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch (e) {}
  }

  function pushLocal(evt) {
    var events = loadEvents();
    events.push(evt);
    saveEvents(events);
  }

  function pushRemote(evt) {
    if (!WORKER_BASE) return;
    try {
      fetch(WORKER_BASE + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evt)
      }).catch(function() {});
    } catch (e) {}
  }

  function pushEvent(evt) {
    pushLocal(evt);
    pushRemote(evt);
  }

  // /stats 端点的 API key（需与 Worker wrangler.toml 中的 STATS_API_KEY 一致）
  var STATS_API_KEY = (typeof EZBOM_STATS_KEY !== 'undefined') ? EZBOM_STATS_KEY : '';

  function fetchRemoteSummary(callback) {
    if (!WORKER_BASE) { callback(null); return; }
    var headers = { 'Content-Type': 'application/json' };
    if (STATS_API_KEY) headers['X-API-Key'] = STATS_API_KEY;
    fetch(WORKER_BASE + '/stats', { headers: headers })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) { callback(data); })
      .catch(function() { callback(null); });
  }

  function buildLocalSummary() {
    var events = loadEvents();
    var summary = {
      total: events.length, pageviews: 0, selects: 0, inquiries: 0, errors: 0,
      devices: {}, products: {}, topParts: {}, recentErrors: []
    };
    events.forEach(function(e) {
      if (e.type === 'pageview') summary.pageviews++;
      else if (e.type === 'select') summary.selects++;
      else if (e.type === 'inquiry') summary.inquiries++;
      else if (e.type === 'error') {
        summary.errors++;
        if (summary.recentErrors.length < 20)
          summary.recentErrors.push({ ts: e.timestamp, msg: e.message, device: e.device });
      }
      if (e.device) summary.devices[e.device] = (summary.devices[e.device] || 0) + 1;
      if (e.product) summary.products[e.product] = (summary.products[e.product] || 0) + 1;
      if (e.type === 'inquiry' && e.partNumbers) {
        e.partNumbers.split('|').forEach(function(pn) {
          summary.topParts[pn] = (summary.topParts[pn] || 0) + 1;
        });
      }
    });
    return summary;
  }

  var deviceInfo = detectDevice();

  window.EzBOMAnalytics = {
    pageview: function(product) {
      pushEvent({ type:'pageview', timestamp:new Date().toISOString(),
        product:product||getProductId(),
        device:deviceInfo.os+'/'+deviceInfo.browser+(deviceInfo.mobile?'/mobile':'/desktop'),
        screen:deviceInfo.screen, viewport:deviceInfo.viewport,
        language:deviceInfo.language, dpr:deviceInfo.dpr, referrer:document.referrer||'direct' });
    },
    select: function(action, part) {
      pushEvent({ type:'select', timestamp:new Date().toISOString(),
        product:getProductId(), device:deviceInfo.os+'/'+deviceInfo.browser,
        partId:part.id||'', partNumber:part.partNumber||'', partName:part.name||'',
        action:action, quantity:part.quantity||0 });
    },
    inquiry: function(inquiry) {
      pushEvent({ type:'inquiry', timestamp:new Date().toISOString(),
        product:getProductId(), device:deviceInfo.os+'/'+deviceInfo.browser,
        totalParts:inquiry.totalParts||0, totalQty:inquiry.totalQty||0,
        emailDomain:inquiry.emailDomain||'',
        partNumbers:(inquiry.partNumbers||[]).join('|') });
    },
    error: function(message, stack, file, line, col) {
      pushEvent({ type:'error', timestamp:new Date().toISOString(),
        product:getProductId(), device:deviceInfo.os+'/'+deviceInfo.browser,
        message:String(message).substring(0,500),
        file:String(file||'').substring(0,200), line:line||0, col:col||0,
        stack:String(stack||'').substring(0,1000), href:location.href });
    },
    exportCSV: function() {
      var events = loadEvents();
      if (!events.length) return '';
      var keys = Object.keys(events[0]);
      var csv = keys.join(',') + '\n';
      events.forEach(function(e) {
        csv += keys.map(function(k) {
          var v = (e[k]===undefined||e[k]===null) ? '' : String(e[k]);
          return '"' + v.replace(/"/g,'""') + '"';
        }).join(',') + '\n';
      });
      return csv;
    },
    getSummary: function(callback) {
      fetchRemoteSummary(function(remoteData) {
        if (remoteData) {
          // Worker 有资料时直接使用，不重复加 localStorage（避免双重计算）
          // localStorage 中的事件已同步发送至 Worker，两者不重叠加总
          callback(remoteData);
        } else {
          // Worker 不可用时，降级使用 localStorage
          callback(buildLocalSummary());
        }
      });
    },
    getSummarySync: function() { return buildLocalSummary(); },
    clear: function() { localStorage.removeItem(STORAGE_KEY); },
    getDeviceInfo: function() { return deviceInfo; },
    flush: function() {}
  };

  window.addEventListener('error', function(e) {
    if (e.target && (e.target instanceof HTMLScriptElement ||
        e.target instanceof HTMLLinkElement || e.target instanceof HTMLImageElement)) {
      window.EzBOMAnalytics.error('Resource load error: '+(e.target.src||e.target.href||'unknown'),
        '', e.filename, e.lineno, e.colno);
      return;
    }
    window.EzBOMAnalytics.error(e.message||'Unknown error', e.error?e.error.stack:'',
      e.filename, e.lineno, e.colno);
  }, true);

  window.addEventListener('unhandledrejection', function(e) {
    window.EzBOMAnalytics.error('Unhandled Promise: '+(e.reason?String(e.reason).substring(0,200):'unknown'),
      e.reason?e.reason.stack:'', '', 0, 0);
  });
})();
