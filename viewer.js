/**
 * EzBOM Viewer — 核心邏輯
 * 從 viewer.html 提取，獨立維護
 *
 * 功能：
 *   - 產品載入 (SVG + BOM CSV)
 *   - SVG 爆炸圖互動（桌面 hover + 手機 tap）
 *   - BOM 零件清單（搜尋、全選、清除）
 *   - 數量調整與詢價郵件
 *   - 採購統計（管理員限定）
 *   - 鍵盤導航（↑↓ Enter）
 *   - SVG 縮放控制
 *   - 撤銷支援

 */

(function () {
  'use strict';

  var S = window.EzBOMSanitize || { escapeHtml: function(s) { return String(s||''); } };

  // ========================================================================
  // 1. 全域狀態
  // ========================================================================
  var params = new URLSearchParams(window.location.search);
  var productId = params.get('product') || 'p-type';
  var bomData = [];
  var selectedParts = new Map();
  var partLabels = new Map();
  var bomInitialized = false;
  var currentTab = 'main';
  var productConfig = null;

  // 撤銷歷史
  var undoStack = [];
  var MAX_UNDO = 50;

  // ========================================================================
  // 2. 管理員驗證（改用 SHA-256 hash）
  // ========================================================================
  // 只存 SHA-256，原始碼不出現明文（本站公開可讀）。改密碼需同步
  // admin.html 與此處，否則另一個入口仍會接受舊密碼。
  var ADMIN_PASSWORD_HASH = '45eadc5e1f196c02b09c844a53bc23ea5efbf7f9f3339f91a666664440fef859';
  var DEFAULT_HASH = '45eadc5e1f196c02b09c844a53bc23ea5efbf7f9f3339f91a666664440fef859';

  window._isAdmin = function() {
    return sessionStorage.getItem('ezbom_admin') === '1';
  };

  window.verifyAdmin = function() {
    var input = document.getElementById('pw-input');
    var errEl = document.getElementById('pw-error');
    var pw = input.value;

    // 非同步計算 SHA-256
    hashPassword(pw).then(function(hash) {
      var validHash = ADMIN_PASSWORD_HASH || DEFAULT_HASH;
      if (hash === validHash) {
        sessionStorage.setItem('ezbom_admin', '1');
        closePwModal();
        var statsIcon = document.getElementById('stats-tab-icon');
        if (statsIcon) statsIcon.textContent = '📊';
        switchTab('stats');
      } else {
        if (errEl) { errEl.style.display = 'block'; }
        input.value = '';
        input.focus();
      }
    });
  };

  /**
   * 使用 Web Crypto API 計算 SHA-256
   */
  function hashPassword(password) {
    if (window.crypto && window.crypto.subtle) {
      var encoder = new TextEncoder();
      var data = encoder.encode(password);
      return window.crypto.subtle.digest('SHA-256', data).then(function(hash) {
        return Array.from(new Uint8Array(hash))
          .map(function(b) { return b.toString(16).padStart(2, '0'); })
          .join('');
      });
    }
    // 降級：簡單 hash（安全性較低但優於明文）
    return Promise.resolve(simpleHash(password));
  }

  function simpleHash(str) {
    var hash = 0, i, chr;
    for (i = 0; i < str.length; i++) {
      chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return 'legacy_' + Math.abs(hash).toString(16);
  }

  window.closePwModal = function() {
    var overlay = document.getElementById('pw-overlay');
    var errEl = document.getElementById('pw-error');
    var input = document.getElementById('pw-input');
    if (overlay) overlay.style.display = 'none';
    if (errEl) errEl.style.display = 'none';
    if (input) input.value = '';
    if (currentTab === 'stats') switchTab('stats');
    else switchTab('main');
  };

  // ========================================================================
  // 3. CSV 解析（強化版：支援引號包裹欄位）
  // ========================================================================
  function parseCSV(text) {
    var rows = [];
    var currentRow = [];
    var currentField = '';
    var inQuotes = false;
    var i = 0;
    var len = text.length;

    // 跳過 BOM
    if (text.charCodeAt(0) === 0xFEFF) i = 1;

    while (i < len) {
      var ch = text[i];
      var nextCh = i + 1 < len ? text[i + 1] : '';

      if (inQuotes) {
        if (ch === '"') {
          if (nextCh === '"') {
            // 跳脫引號
            currentField += '"';
            i += 2;
            continue;
          } else {
            inQuotes = false;
            i++;
            continue;
          }
        }
        currentField += ch;
        i++;
        continue;
      }

      if (ch === '"' && currentField.length === 0) {
        inQuotes = true;
        i++;
        continue;
      }

      if (ch === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
        i++;
        continue;
      }

      if (ch === '\r') {
        i++;
        continue;
      }

      if (ch === '\n') {
        currentRow.push(currentField.trim());
        if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0] === '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        i++;
        continue;
      }

      currentField += ch;
      i++;
    }

    // 處理最後一個欄位
    if (currentField.length > 0 || currentRow.length > 0) {
      currentRow.push(currentField.trim());
      if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0] === '')) {
        rows.push(currentRow);
      }
    }

    if (rows.length < 2) return [];

    var headers = rows[0];
    return rows.slice(1).map(function(line) {
      var row = {};
      headers.forEach(function(h, idx) {
        if (idx < line.length) row[h] = line[idx];
      });
      return row;
    });
  }

  function normalizeBOMData(rows) {
    return rows.map(function(row, idx) {
      var id = row.Id || row.ID || row['標籤ID'] || 'P' + String(idx + 1).padStart(2, '0');
      var itemNo = parseInt(row.ItemNo || row['項次'] || row['#'] || (idx + 1), 10);
      var partNumber = row.PartNumber || row['料品編號'] || row['Part No.'] || '';
      var name = row.Name || row['品名'] || row.Description || '';
      var quantity = parseInt(row.Quantity || row['數量'] || row.Qty || row['單 位 數 量'] || '1', 10);
      return { id: id, itemNo: itemNo, partNumber: partNumber, name: name, quantity: quantity };
    });
  }

  // ========================================================================
  // 4. 工具函數
  // ========================================================================
  function showToast(msg) {
    var t = document.getElementById('toast');
    S.safeText(t, msg);
    t.classList.add('show');
    clearTimeout(t._toastTimer);
    t._toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2500);
  }

  function svgPointToContainer(svgEl, containerEl, svgX, svgY) {
    var containerRect = containerEl.getBoundingClientRect();
    // getScreenCTM 涵蓋 viewBox 偏移＋CSS scale/rotate/translate，
    // 舊版自算比例在旋轉後會把標籤放錯位置（也忽略了 viewBox.x/y）。
    try {
      var m = svgEl.getScreenCTM();
      if (m && svgEl.createSVGPoint) {
        var pt = svgEl.createSVGPoint();
        pt.x = svgX; pt.y = svgY;
        var sp = pt.matrixTransform(m);
        return { left: sp.x - containerRect.left, top: sp.y - containerRect.top };
      }
    } catch (e) { /* 降級 */ }
    var svgRect = svgEl.getBoundingClientRect();
    var vb = svgEl.viewBox.baseVal;
    if (!vb || !vb.width || !vb.height) return { left: svgX, top: svgY };
    return {
      left: (svgX - vb.x) * (svgRect.width / vb.width) + (svgRect.left - containerRect.left),
      top: (svgY - vb.y) * (svgRect.height / vb.height) + (svgRect.top - containerRect.top)
    };
  }

  // ========================================================================
  // 5. 撤銷系統
  // ========================================================================
  function pushUndoState() {
    var state = {};
    selectedParts.forEach(function(entry, partId) {
      state[partId] = entry.customQty;
    });
    undoStack.push(state);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  function undo() {
    if (undoStack.length === 0) return;

    // 清除目前選擇
    selectedParts.forEach(function(_, pid) {
      updateBOMSelection(pid, false);
      updateSVGSelection(pid, false);
    });
    selectedParts.clear();

    // 還原上一個狀態
    var prevState = undoStack.pop();
    Object.keys(prevState).forEach(function(partId) {
      var part = bomData.find(function(p) { return p.id === partId; });
      if (part) {
        selectedParts.set(partId, { part: part, customQty: prevState[partId] });
        updateBOMSelection(partId, true);
        updateSVGSelection(partId, true);
      }
    });
    updateStats();
    saveSelection();
    showToast('已復原 (剩餘 ' + undoStack.length + ' 步)');
  }

  // ========================================================================
  // 6. 產品載入
  // ========================================================================
  async function loadProduct() {
    try {
      // 載入 products.json
      var manifestRes = await fetch('./products.json');
      if (!manifestRes.ok) throw new Error('無法載入產品清單');
      var manifest = await manifestRes.json();

      productConfig = manifest.products.find(function(p) { return p.id === productId; });
      if (!productConfig) throw new Error('找不到產品: ' + productId);

      S.safeText(document.getElementById('product-title'), productConfig.name);

      // 解析收件信箱（優先序：localStorage > 產品設定 > 全域設定）
      var globalEmail = manifest.emailTo || '';
      var productEmail = productConfig.emailTo || '';
      var savedEmail = localStorage.getItem('ezbom_emailTo') || '';
      var finalEmail = savedEmail || productEmail || globalEmail;
      document.getElementById('email-input').value = finalEmail;

      // 載入 BOM CSV
      S.safeText(document.getElementById('loading-text'), '載入零件清單...');
      var bomRes = await fetch(productConfig.bom);
      if (!bomRes.ok) throw new Error('無法載入 BOM 資料');
      var csvText = await bomRes.text();
      var rows = parseCSV(csvText);
      bomData = normalizeBOMData(rows);
      if (bomData.length === 0) throw new Error('BOM 資料為空');

      // 載入 SVG
      S.safeText(document.getElementById('loading-text'), '載入爆炸圖...');
      var svgRes = await fetch(productConfig.svg);
      if (!svgRes.ok) throw new Error('無法載入爆炸圖 SVG');
      var svgContent = await svgRes.text();

      // 安全注入 SVG：使用 DOMParser 解析，過濾危險元素
      var parser = new DOMParser();
      var doc = parser.parseFromString(svgContent, 'image/svg+xml');
      // 移除 <script> 標籤和事件屬性
      doc.querySelectorAll('script').forEach(function(el) { el.remove(); });
      var svgEl = doc.querySelector('svg');
      if (!svgEl) throw new Error('SVG 格式錯誤');
      // 移除所有 on* 事件屬性
      svgEl.querySelectorAll('*').forEach(function(el) {
        var attrs = el.getAttributeNames();
        attrs.forEach(function(name) {
          if (name.indexOf('on') === 0) el.removeAttribute(name);
        });
      });
      document.getElementById('svg-container').innerHTML = '';
      document.getElementById('svg-container').appendChild(svgEl);
      document.getElementById('loading').classList.add('hidden');

      // 處理 SVG 互動
      processSVGAfterLoad();

      // Analytics
      if (window.EzBOMAnalytics) {
        window.EzBOMAnalytics.pageview(productId);
      }

    } catch (err) {
      S.safeText(document.getElementById('loading-error'), '錯誤：' + err.message);
      document.getElementById('loading-error').style.display = 'block';
      S.safeText(document.getElementById('loading-text'), '載入失敗');
      if (window.EzBOMAnalytics) {
        window.EzBOMAnalytics.error('Product load failed: ' + err.message, err.stack, '', 0, 0);
      }
    }
  }

  // ========================================================================
  // 7. BOM 清單渲染
  // ========================================================================
  var focusedBomIndex = -1;

  function initBOMList() {
    var bomList = document.getElementById('bom-list');
    bomList.innerHTML = '';
    focusedBomIndex = -1;

    bomData.forEach(function(item, index) {
      var div = document.createElement('div');
      div.className = 'bom-item';
      div.setAttribute('data-part-id', item.id);
      div.setAttribute('tabindex', '0');
      div.setAttribute('role', 'option');
      div.setAttribute('aria-selected', 'false');

      // 使用 textContent 避免 XSS
      var itemNo = document.createElement('div');
      itemNo.className = 'item-number';
      itemNo.textContent = item.itemNo || (index + 1);

      var info = document.createElement('div');
      info.className = 'item-info';

      var pn = document.createElement('div');
      pn.className = 'part-number';
      pn.textContent = item.partNumber;

      var nm = document.createElement('div');
      nm.className = 'part-name';
      nm.textContent = item.name;

      var qty = document.createElement('div');
      qty.className = 'part-qty';
      qty.textContent = '數量: ' + item.quantity;

      info.appendChild(pn);
      info.appendChild(nm);
      info.appendChild(qty);

      div.appendChild(itemNo);
      div.appendChild(info);

      div.addEventListener('click', function() {
        togglePartSelection(item.id);
      });

      // 鍵盤導航
      div.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          togglePartSelection(item.id);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusBomItem(index + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusBomItem(index - 1);
        }
      });

      bomList.appendChild(div);
    });

    bomInitialized = true;
  }

  function focusBomItem(index) {
    var items = document.querySelectorAll('#bom-list .bom-item:not(.hidden)');
    if (items.length === 0) return;
    if (index < 0) index = items.length - 1;
    if (index >= items.length) index = 0;
    items[index].focus();
    items[index].scrollIntoView({ block: 'nearest' });
  }

  // BOM 搜尋（含 SVG 零件高亮）
  window.filterBOM = function() {
    var q = document.getElementById('search-box').value.trim().toLowerCase();
    var matchingIds = [];
    var visibleItems = [];
    var firstVisibleIndex = -1;

    document.querySelectorAll('.bom-item').forEach(function(el, idx) {
      var matches = q === '' || el.textContent.toLowerCase().indexOf(q) !== -1;
      el.classList.toggle('hidden', !matches);
      if (matches) {
        visibleItems.push(idx);
        matchingIds.push(el.getAttribute('data-part-id'));
        if (firstVisibleIndex === -1) firstVisibleIndex = idx;
      }
    });

    // 高亮 SVG 中匹配的零件
    document.querySelectorAll('.svg-part').forEach(function(g) {
      var pid = g.getAttribute('data-part-id');
      if (q !== '' && matchingIds.indexOf(pid) !== -1) {
        g.classList.add('search-highlight');
        // 3 秒後自動移除高亮
        clearTimeout(g._highlightTimer);
        g._highlightTimer = setTimeout(function() {
          g.classList.remove('search-highlight');
        }, 3000);
      } else {
        g.classList.remove('search-highlight');
      }
    });

    focusedBomIndex = firstVisibleIndex;
  };

  window.selectAll = function() {
    pushUndoState();
    bomData.forEach(function(item) {
      if (!selectedParts.has(item.id)) {
        selectedParts.set(item.id, { part: item, customQty: item.quantity });
        updateBOMSelection(item.id, true);
        updateSVGSelection(item.id, true);
      }
    });
    updateStats();
    saveSelection();
    showToast('已全選 ' + selectedParts.size + ' 個零件');
  };

  window.clearAll = function() {
    if (selectedParts.size === 0) return;
    pushUndoState();
    selectedParts.forEach(function(_, pid) {
      updateBOMSelection(pid, false);
      updateSVGSelection(pid, false);
    });
    selectedParts.clear();
    updateStats();
    saveSelection();
    showToast('已清除全部選擇');
  };

  // ========================================================================
  // 8. 選擇邏輯（含 localStorage 持久化）
  // ========================================================================
  var SELECTION_STORAGE_KEY = 'ezbom_selection_';

  function saveSelection() {
    try {
      var data = {};
      selectedParts.forEach(function(entry, partId) {
        data[partId] = entry.customQty;
      });
      localStorage.setItem(SELECTION_STORAGE_KEY + productId, JSON.stringify(data));
    } catch (e) { /* localStorage 不可用時靜默失敗 */ }
  }

  function restoreSelection() {
    try {
      var raw = localStorage.getItem(SELECTION_STORAGE_KEY + productId);
      if (!raw) return;
      var data = JSON.parse(raw);
      Object.keys(data).forEach(function(partId) {
        var part = bomData.find(function(p) { return p.id === partId; });
        if (part) {
          selectedParts.set(partId, { part: part, customQty: data[partId] });
          updateBOMSelection(partId, true);
          updateSVGSelection(partId, true);
        }
      });
      if (selectedParts.size > 0) updateStats();
    } catch (e) { /* 解析失敗時靜默 */ }
  }

  function togglePartSelection(partId) {
    var wasSelected = selectedParts.has(partId);
    pushUndoState();

    if (wasSelected) {
      selectedParts.delete(partId);
      updateBOMSelection(partId, false);
      updateSVGSelection(partId, false);
      if (window.EzBOMAnalytics) {
        var p = bomData.find(function(item) { return item.id === partId; });
        window.EzBOMAnalytics.select('remove', p || { id: partId });
      }
    } else {
      var part = bomData.find(function(p) { return p.id === partId; });
      if (part) {
        selectedParts.set(partId, { part: part, customQty: part.quantity });
        updateBOMSelection(partId, true);
        updateSVGSelection(partId, true);
        if (window.EzBOMAnalytics) {
          window.EzBOMAnalytics.select('add', part);
        }
      }
    }
    updateStats();
    saveSelection();

    // 新選零件：捲到對應 BOM 項目（等 updateStats 重建 DOM 後再捲，動畫才不會被取消）
    if (!wasSelected) {
      setTimeout(function() {
        var el = document.querySelector('#bom-list [data-part-id="' + partId + '"]');
        if (el) el.scrollIntoView({ block: 'nearest' });
      }, 50);
    }
  }

  function updateBOMSelection(partId, selected) {
    var el = document.querySelector('[data-part-id="' + partId + '"]');
    if (el) el.classList.toggle('selected', selected);
  }

  function updateSVGSelection(partId, selected) {
    document.querySelectorAll('[data-part-id="' + partId + '"]').forEach(function(el) {
      el.classList.toggle('selected', selected);
    });
    ezRenderSelection();
  }

  // ========================================================================
  // 叢集級高亮：只亮使用者點到的那一個實體零件
  // 歸組（assign_components 區域生長）會把鄰件吸進同一群組——實測
  // ch160-ushort-trolley P34 有 1071 條子路徑、10 個空間分離叢集、
  // bbox 橫跨全圖 80%。整組套 .selected 會把散在全圖的同一料號實例
  // 一起亮起來＝「選一件連帶別件」；只亮到部分叢集＝「只顯示一半」。
  // 這裡不改原始幾何，改用覆蓋層只畫出目標叢集。
  // ========================================================================
  var ezClusterCache = new WeakMap();
  var ezSelLayer = null, ezHoverLayer = null, ezPick = null;

  function ezSvg() { return document.querySelector('#svg-container svg'); }

  function ezClustersOf(g) {
    var hit = ezClusterCache.get(g);
    if (hit) return hit;
    var svg = ezSvg();
    var path = g.querySelector('path');
    var d = path ? (path.getAttribute('d') || '') : '';
    var subs = d.match(/M[^M]*/g) || [];
    if (!svg || subs.length < 2) {
      var single = [{ d:d, n:subs.length, bb:null }];
      ezClusterCache.set(g, single);
      return single;
    }
    // 用暫時 path 量每條子路徑 bbox（含 A/C 等指令也準確）
    var NS = 'http://www.w3.org/2000/svg';
    var probe = document.createElementNS(NS, 'path');
    probe.setAttribute('fill', 'none');
    probe.setAttribute('stroke', 'none');
    probe.style.visibility = 'hidden';
    svg.appendChild(probe);
    var items = [];
    for (var i = 0; i < subs.length; i++) {
      probe.setAttribute('d', subs[i]);
      var b;
      try { b = probe.getBBox(); } catch (e) { b = null; }
      if (!b || (b.width === 0 && b.height === 0)) continue;
      items.push({ d:subs[i], x0:b.x, y0:b.y, x1:b.x + b.width, y1:b.y + b.height });
    }
    svg.removeChild(probe);
    if (!items.length) { ezClusterCache.set(g, [{ d:d, n:subs.length, bb:null }]); return ezClusterCache.get(g); }

    var vb = svg.viewBox.baseVal;
    var gap = Math.hypot(vb.width, vb.height) * 0.02;
    // 網格雜湊做鄰近合併，避免 O(n²)（P36 有 2802 條子路徑）
    var par = items.map(function(_, k){ return k; });
    function find(x){ while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    var cell = Math.max(gap, 1e-6), grid = {};
    function key(cx, cy){ return cx + ':' + cy; }
    items.forEach(function(it, k){
      var cx0 = Math.floor(it.x0 / cell), cx1 = Math.floor(it.x1 / cell);
      var cy0 = Math.floor(it.y0 / cell), cy1 = Math.floor(it.y1 / cell);
      for (var a = cx0; a <= cx1; a++) for (var b2 = cy0; b2 <= cy1; b2++) {
        var kk = key(a, b2);
        (grid[kk] = grid[kk] || []).push(k);
      }
    });
    Object.keys(grid).forEach(function(kk){
      var lst = grid[kk];
      for (var a = 0; a < lst.length; a++) for (var b2 = a + 1; b2 < lst.length; b2++) {
        var i1 = lst[a], i2 = lst[b2], A = items[i1], B = items[i2];
        var dx = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
        var dy = Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1));
        if (Math.hypot(dx, dy) <= gap) par[find(i1)] = find(i2);
      }
    });
    var buckets = {};
    items.forEach(function(it, k){ var r = find(k); (buckets[r] = buckets[r] || []).push(it); });
    var clusters = Object.keys(buckets).map(function(r){
      var bs = buckets[r];
      var x0 = Math.min.apply(null, bs.map(function(x){ return x.x0; }));
      var y0 = Math.min.apply(null, bs.map(function(x){ return x.y0; }));
      var x1 = Math.max.apply(null, bs.map(function(x){ return x.x1; }));
      var y1 = Math.max.apply(null, bs.map(function(x){ return x.y1; }));
      return { d:bs.map(function(x){ return x.d; }).join(''), n:bs.length,
               bb:{ x:x0, y:y0, w:x1 - x0, h:y1 - y0 },
               cx:(x0 + x1) / 2, cy:(y0 + y1) / 2 };
    });
    clusters.sort(function(a, b){ return b.n - a.n; });
    ezClusterCache.set(g, clusters);
    return clusters;
  }

  function ezEnsureLayers() {
    var svg = ezSvg();
    if (!svg) return null;
    if (!ezSelLayer || ezSelLayer.parentNode !== svg) {
      var NS = 'http://www.w3.org/2000/svg';
      ezHoverLayer = document.createElementNS(NS, 'g');
      ezHoverLayer.setAttribute('class', 'ez-hover-layer');
      ezSelLayer = document.createElementNS(NS, 'g');
      ezSelLayer.setAttribute('class', 'ez-sel-layer');
      svg.appendChild(ezHoverLayer);
      svg.appendChild(ezSelLayer);
      svg.classList.add('ez-cluster-sel');
    }
    return svg;
  }

  function ezPickCluster(g, partId) {
    var cs = ezClustersOf(g);
    if (cs.length < 2 || !cs[0].bb) return cs[0];
    if (ezPick && ezPick.id === partId) {
      var best = null, bd = Infinity;
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i], b = c.bb;
        var dx = Math.max(0, Math.max(b.x, ezPick.x) - Math.min(b.x + b.w, ezPick.x));
        var dy = Math.max(0, Math.max(b.y, ezPick.y) - Math.min(b.y + b.h, ezPick.y));
        var dd = Math.hypot(dx, dy);
        if (dd < bd) { bd = dd; best = c; }
      }
      if (best) return best;
    }
    return cs[0];   // BOM 列點選沒有座標：亮最大叢集（主實例）
  }

  // 未歸組（X000，無 inkscape:label）的幾何：同一實體零件常被拆到
  // 「有料號群組」與 X000 兩邊，只亮料號那組＝使用者看到的「只顯示一半」。
  // 這裡把落在目標叢集範圍內的未歸組子路徑一起補進高亮。
  var ezStrayCache = null;
  function ezStrays() {
    if (ezStrayCache) return ezStrayCache;
    var svg = ezSvg();
    if (!svg) return [];
    var NS = 'http://www.w3.org/2000/svg';
    var probe = document.createElementNS(NS, 'path');
    probe.setAttribute('fill', 'none'); probe.setAttribute('stroke', 'none');
    probe.style.visibility = 'hidden';
    svg.appendChild(probe);
    var out = [];
    var paths = svg.querySelectorAll('path');
    for (var i = 0; i < paths.length; i++) {
      var pp = paths[i];
      if (pp.closest('.svg-part') || pp.closest('.ez-sel-layer') || pp.closest('.ez-hover-layer')) continue;
      var subs = (pp.getAttribute('d') || '').match(/M[^M]*/g) || [];
      for (var j = 0; j < subs.length; j++) {
        probe.setAttribute('d', subs[j]);
        var b;
        try { b = probe.getBBox(); } catch (e) { b = null; }
        if (!b || (b.width === 0 && b.height === 0)) continue;
        out.push({ d:subs[j], cx:b.x + b.width / 2, cy:b.y + b.height / 2,
                   x0:b.x, y0:b.y, x1:b.x + b.width, y1:b.y + b.height });
      }
    }
    svg.removeChild(probe);
    ezStrayCache = out;
    return out;
  }

  function ezPaint(layer, g, partId, cls) {
    var svg = ezEnsureLayers();
    if (!svg || !g) return;
    var c = ezPickCluster(g, partId);
    if (!c || !c.d) return;
    var d = c.d;
    if (c.bb) {
      var b = c.bb;
      var mx = Math.max(b.w * 0.18, 2), my = Math.max(b.h * 0.18, 2);
      var strays = ezStrays();
      for (var i = 0; i < strays.length; i++) {
        var s = strays[i];
        if (s.cx >= b.x - mx && s.cx <= b.x + b.w + mx &&
            s.cy >= b.y - my && s.cy <= b.y + b.h + my) d += s.d;
      }
    }
    var NS = 'http://www.w3.org/2000/svg';
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    p.setAttribute('fill', 'none');
    p.setAttribute('pointer-events', 'none');
    layer.appendChild(p);
  }

  function ezRenderSelection() {
    var svg = ezEnsureLayers();
    if (!svg || !ezSelLayer) return;
    ezSelLayer.textContent = '';
    selectedParts.forEach(function(entry, partId) {
      var g = svg.querySelector('.svg-part[data-part-id="' + partId + '"]');
      if (g) ezPaint(ezSelLayer, g, partId, 'ez-sel-path');
    });
  }

  function ezRenderHover(g) {
    var svg = ezEnsureLayers();
    if (!svg || !ezHoverLayer) return;
    ezHoverLayer.textContent = '';
    if (g) ezPaint(ezHoverLayer, g, g.getAttribute('data-part-id'), 'ez-hover-path');
  }

  function updateStats() {
    var totalQty = 0;
    selectedParts.forEach(function(e) { totalQty += e.customQty; });
    document.getElementById('selected-count').textContent = selectedParts.size;
    document.getElementById('total-quantity').textContent = totalQty;

    var list = document.getElementById('selected-list');
    list.innerHTML = '';

    selectedParts.forEach(function(entry, partId) {
      var p = entry.part;
      var div = document.createElement('div');
      div.className = 'selected-item';

      var infoDiv = document.createElement('div');
      infoDiv.className = 'selected-item-info';

      var nameDiv = document.createElement('div');
      nameDiv.style.cssText = 'font-weight:600;font-size:12px;';
      nameDiv.textContent = p.partNumber;

      var descDiv = document.createElement('div');
      descDiv.className = 'part-name';
      descDiv.textContent = p.name;

      infoDiv.appendChild(nameDiv);
      infoDiv.appendChild(descDiv);

      var qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.className = 'qty-input';
      qtyInput.value = entry.customQty;
      qtyInput.min = '1';
      qtyInput.setAttribute('data-part-id', partId);
      qtyInput.addEventListener('change', function() {
        updateQty(partId, this.value);
      });

      var removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', function() {
        removePart(partId);
      });

      div.appendChild(infoDiv);
      div.appendChild(qtyInput);
      div.appendChild(removeBtn);
      list.appendChild(div);
    });

    document.getElementById('email-btn').disabled = selectedParts.size === 0;
    var copyBtn = document.getElementById('copy-btn');
    if (copyBtn) copyBtn.disabled = selectedParts.size === 0;
  }

  window.updateQty = function(partId, val) {
    var qty = parseInt(val, 10);
    if (qty > 0 && selectedParts.has(partId)) {
      pushUndoState();
      var entry = selectedParts.get(partId);
      selectedParts.set(partId, { part: entry.part, customQty: qty });
      updateStats();
      saveSelection();
    }
  };

  window.removePart = function(partId) {
    pushUndoState();
    selectedParts.delete(partId);
    updateBOMSelection(partId, false);
    updateSVGSelection(partId, false);
    updateStats();
    saveSelection();
  };

  // ========================================================================
  // 9. 發送詢價 & 信箱設定
  // ========================================================================
  window.sendInquiry = function() {
    if (selectedParts.size === 0) return;

    var emailTo = document.getElementById('email-input').value.trim();
    if (!emailTo) {
      showToast('請先輸入詢價收件信箱');
      var emailInput = document.getElementById('email-input');
      if (emailInput) emailInput.focus();
      return;
    }

    var productName = productConfig ? productConfig.name : '';
    var subject = encodeURIComponent(
      (productName ? productName + ' - ' : '') + '零件詢價請求 ' + new Date().toLocaleDateString('zh-TW')
    );

    var lines = ['尊敬的售後部門，', '', '請為以下零件提供報價：', ''];
    selectedParts.forEach(function(e) {
      var p = e.part;
      lines.push('• ' + p.partNumber + ' - ' + p.name + ' (數量: ' + e.customQty + ')');
    });
    var total = Array.from(selectedParts.values()).reduce(function(s, e) { return s + e.customQty; }, 0);
    lines.push('');
    lines.push('總計：' + selectedParts.size + ' 種，共 ' + total + ' 件');
    lines.push('', '請盡快回覆報價，謝謝！', '', '此致', '敬禮');
    var body = encodeURIComponent(lines.join('\n'));

    var confirmMsg = '即將打開郵件客戶端，發送 ' + selectedParts.size + ' 種零件（共 ' + total + ' 件）的詢價請求？';
    if (confirm(confirmMsg)) {

      if (window.EzBOMAnalytics) {
        window.EzBOMAnalytics.inquiry({
          totalParts: selectedParts.size,
          totalQty: total,
          emailDomain: emailTo.split('@')[1] || emailTo,
          partNumbers: Array.from(selectedParts.keys())
        });
      }

      var mailtoUrl = 'mailto:' + encodeURIComponent(emailTo) + '?subject=' + subject + '&body=' + body;
      var isAndroid = /Android/.test(navigator.userAgent);

      if (isAndroid) {
        showMailtoFallback(emailTo, lines.join('\n'), mailtoUrl);
      } else {
        window.location.href = mailtoUrl;
      }
    }
  };

  window._fallbackMailtoUrl = '';

  // 複製詢價清單到剪貼簿（替代 mailto 的可靠方案）
  window.copyInquiry = function() {
    if (selectedParts.size === 0) return;

    var emailTo = document.getElementById('email-input').value.trim();
    var productName = productConfig ? productConfig.name : '';
    var lines = ['零件詢價清單', ''];
    if (productName) lines.push('產品：' + productName);
    if (emailTo) lines.push('收件信箱：' + emailTo);
    lines.push('日期：' + new Date().toLocaleDateString('zh-TW'), '');
    lines.push('零件清單：');
    selectedParts.forEach(function(e) {
      var p = e.part;
      lines.push('• ' + p.partNumber + ' - ' + p.name + ' (數量: ' + e.customQty + ')');
    });
    var total = Array.from(selectedParts.values()).reduce(function(s, e) { return s + e.customQty; }, 0);
    lines.push('', '總計：' + selectedParts.size + ' 種，共 ' + total + ' 件');

    var text = lines.join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        showToast('詢價清單已複製到剪貼簿');
      }).catch(function() {
        showCopyFallback(text);
      });
    } else {
      showCopyFallback(text);
    }
  };

  function showCopyFallback(text) {
    var ta = document.getElementById('fallback-text');
    if (ta) {
      ta.value = text;
      document.getElementById('mailto-fallback').style.display = 'flex';
    } else {
      showToast('請手動複製');
    }
  }

  window.showMailtoFallback = function(email, text, mailtoUrl) {
    document.getElementById('fallback-email').textContent = email;
    document.getElementById('fallback-text').value = text;
    document.getElementById('mailto-fallback').style.display = 'flex';
    window._fallbackMailtoUrl = mailtoUrl;
    setTimeout(function() {
      window.location.href = mailtoUrl;
    }, 100);
  };

  window.copyFallbackText = function() {
    var text = document.getElementById('fallback-text').value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        var btn = document.getElementById('fallback-copy-btn');
        btn.textContent = '已複製！';
        btn.style.background = '#788C5D';
        setTimeout(function() {
          btn.textContent = '複製到剪貼簿';
          btn.style.background = '#D97757';
        }, 2000);
      });
    } else {
      var ta = document.getElementById('fallback-text');
      ta.select();
      ta.setSelectionRange(0, 99999);
      showToast('請手動複製詢價內容');
    }
  };

  window.saveEmail = function() {
    var email = document.getElementById('email-input').value.trim();
    if (email) {
      localStorage.setItem('ezbom_emailTo', email);
      showToast('收件信箱已儲存：' + email);
    } else {
      showToast('請輸入有效的郵箱地址');
    }
  };

  // ========================================================================
  // 10. SVG 處理（含縮放控制）
  // ========================================================================
  var svgZoomLevel = 1;
  var svgZoomMin = 0.3;
  var svgZoomMax = 3.0;
  var svgZoomStep = 0.15;

  // 命中解析：最小零件優先。
  // 群組按 P 號升序繪製，大零件的填色區（pointer-events:all）會蓋在小零件上，
  // 原生 click / :hover 只認 paint order 最上層 → 點小件卻選到大件。
  // 取該點「所有」候選元素，映射回所屬零件，挑外框面積最小者＝最具體的那件。
  function installHitResolution(svg, container) {
    if (!svg || svg.__hitResolved) return;
    svg.__hitResolved = true;
    svg.classList.add('hit-resolved');

    var hasStack = typeof document.elementsFromPoint === 'function';
    var areaCache = new WeakMap();

    function areaOf(g) {
      var a = areaCache.get(g);
      if (a !== undefined) return a;
      a = Infinity;
      try {
        var b = g.getBBox();                 // user units：縮放／hover 縮放不影響
        a = Math.max(1, b.width * b.height);
      } catch (e) {}
      areaCache.set(g, a);
      return a;
    }

    // 描邊命中判定：使用者瞄的是可見線條，所以「點在某件的描邊上」要
    // 優先於「點落在另一件的填色區內」，否則小件填色區會搶走大件線條。
    var spt = svg.createSVGPoint ? svg.createSVGPoint() : null;
    function inStroke(el, x, y) {
      if (!spt || typeof el.isPointInStroke !== 'function') return false;
      try {
        var m = el.getScreenCTM();
        if (!m) return false;
        spt.x = x; spt.y = y;
        return el.isPointInStroke(spt.matrixTransform(m.inverse()));
      } catch (e) { return false; }
    }

    function resolveAt(x, y) {
      var stack = hasStack ? document.elementsFromPoint(x, y)
                           : [document.elementFromPoint(x, y)];
      var strokeBest = null, strokeArea = Infinity;
      var fillBest = null, fillArea = Infinity;
      for (var i = 0; i < stack.length; i++) {
        var el = stack[i];
        if (!el || !el.closest) continue;
        var g = el.closest('.svg-part');
        if (!g || !svg.contains(g)) continue;
        var a = areaOf(g);
        if (inStroke(el, x, y)) {
          if (a < strokeArea) { strokeArea = a; strokeBest = g; }
        } else if (a < fillArea) { fillArea = a; fillBest = g; }
      }
      return strokeBest || fillBest;
    }

    function labelOf(g) {
      var id = g && g.getAttribute('data-part-id');
      return id ? partLabels.get(id) : null;
    }

    // 點擊（滑鼠與觸控共用）
    svg.addEventListener('click', function(ev) {
      // 剛拖曳／pinch 過就不当成點選，避免平移後誤選零件
      if (container.__ezSuppressClick) return;
      var g = resolveAt(ev.clientX, ev.clientY);
      if (!g) return;
      var partId = g.getAttribute('data-part-id');
      if (!partId) return;
      // 記錄點擊點（SVG user units），供叢集級高亮挑出正確實例
      try {
        var cm = svg.getScreenCTM();
        if (cm && svg.createSVGPoint) {
          var cp = svg.createSVGPoint();
          cp.x = ev.clientX; cp.y = ev.clientY;
          var lp = cp.matrixTransform(cm.inverse());
          ezPick = { id: partId, x: lp.x, y: lp.y };
        }
      } catch (e) { ezPick = null; }
      togglePartSelection(partId);
      if (window.innerWidth <= 768) {
        var el = labelOf(g);
        if (el) {
          el.classList.add('show');
          clearTimeout(el._hideTimer);
          el._hideTimer = setTimeout(function() { el.classList.remove('show'); }, 1200);
        }
        g.classList.add('tap-highlight');
        setTimeout(function() { g.classList.remove('tap-highlight'); }, 400);
      }
    });

    // 桌面 hover：rAF 節流，解析結果沒變就不動 DOM
    var hovered = null, pending = null, raf = 0;
    function applyHover(g) {
      if (g === hovered) return;
      if (hovered) {
        hovered.classList.remove('hovered');
        var prev = labelOf(hovered);
        if (prev) prev.classList.remove('show');
      }
      hovered = g;
      if (hovered) {
        hovered.classList.add('hovered');
        var cur = labelOf(hovered);
        if (cur) cur.classList.add('show');
      }
      ezRenderHover(hovered);
    }
    svg.addEventListener('pointermove', function(ev) {
      if (ev.pointerType === 'touch') return;
      pending = [ev.clientX, ev.clientY];
      if (raf) return;
      raf = requestAnimationFrame(function() {
        raf = 0;
        if (!pending) return;
        var hg = resolveAt(pending[0], pending[1]);
        if (hg) {
          try {
            var hm = svg.getScreenCTM();
            if (hm && svg.createSVGPoint) {
              var hp = svg.createSVGPoint();
              hp.x = pending[0]; hp.y = pending[1];
              var hl = hp.matrixTransform(hm.inverse());
              ezPick = { id: hg.getAttribute('data-part-id'), x: hl.x, y: hl.y };
            }
          } catch (e) {}
        }
        applyHover(hg);
      });
    });
    svg.addEventListener('pointerleave', function() {
      pending = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      applyHover(null);
    });
  }

  function processSVGAfterLoad() {
    var svg = document.querySelector('#svg-container svg');
    var container = document.querySelector('.svg-container');
    if (!svg) return;

    // 100% 縮放＝完整貼合容器：容器 overflow:hidden（為了自製平移），
    // 若 SVG 只限寬不限高，直式圖算出的高度會超過容器而被裁掉。
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.maxWidth = '100%';
    svg.style.maxHeight = '100%';
    svg.style.preserveAspectRatio = 'xMidYMid meet';

    // 視圖控制（縮放／旋轉／線寬／顯示／輸出）——桌面與手機都給
    addViewControls(container, svg);

    requestAnimationFrame(function() {
      // 統一路徑樣式
      svg.querySelectorAll('path, circle, rect, ellipse, line').forEach(function(path) {
        path.style.stroke = '#141413';
        // 線寬交給 CSS var(--ez-stroke) 單一來源（見 vApplyStroke），
        // 不在此寫死 inline，避免與視圖控制互相覆寫。
        path.style.strokeWidth = '';
        path.style.fill = 'none';
        // fill:none + 預設 pointer-events(visiblePainted) → 只有 2px 描邊可點，
        // 零件內部點下去命中的是 <svg> 背景（實測 elementFromPoint 中心=svg）。
        // 'all' 讓未填色的內部也接收滑鼠事件：桌面 hover 變大變紅、手機才點得到。
        path.style.pointerEvents = 'all';
      });

      var foundParts = 0;
      svg.querySelectorAll('g').forEach(function(group) {
        var partId = null;

        // 從 inkscape:label 屬性提取零件 ID
        for (var i = 0; i < group.attributes.length; i++) {
          var attr = group.attributes[i];
          if (attr.name === 'inkscape:label' && attr.value) {
            // P-id 契約（同 dwg2drawing.PID_RE / audit LBL）：
            // "P01-xxx" 取 dash 前段；"P01"（無 dash）整值即零件 ID
            var dash = attr.value.indexOf('-');
            var cand = dash > 0 ? attr.value.substring(0, dash) : attr.value;
            if (/^P\d+$/.test(cand)) { partId = cand; break; }
          }
        }
        if (!partId) return;

        var partData = bomData.find(function(d) { return d.id === partId; });
        if (!partData) return;

        group.setAttribute('data-part-id', partId);
        group.classList.add('svg-part');

        // 浮動標籤
        var label = document.createElement('div');
        label.className = 'part-label';
        label.textContent = partData.id + ' - ' + partData.partNumber;
        label.id = 'label-' + partId;
        try {
          var bbox = group.getBBox();
          var pos = svgPointToContainer(svg, container, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
          label.style.left = pos.left + 'px';
          label.style.top = pos.top + 'px';
        } catch (e) {
          label.style.left = '50%';
          label.style.top = '50%';
        }
        container.appendChild(label);
        partLabels.set(partId, label);

        foundParts++;
      });

      // 點擊／hover 改由委派監聽 + 最小零件優先解析（見 installHitResolution）
      installHitResolution(svg, container);
      // 覆蓋層要在載入時就建立並掛上 ez-cluster-sel，否則尚未選取任何
      // 零件時 hover 仍會走舊的整組著色（＝連帶別件）。
      ezEnsureLayers();
      ezRenderSelection();

      console.log('已處理 ' + foundParts + ' 個零件');
      if (!bomInitialized) { initBOMList(); }

      // 恢復上次選擇（localStorage 持久化）
      restoreSelection();

      // resize 重新定位標籤（避免重複綁定：先移除舊 listener）
      if (window._ezbomResizeHandler) {
        window.removeEventListener('resize', window._ezbomResizeHandler);
      }
      var labelTimer;
      window._ezbomResizeHandler = function() {
        clearTimeout(labelTimer);
        labelTimer = setTimeout(function() {
          if (vSvg === svg) { vMeasureBase(); vApplyStroke(); }
          updateLabels(svg, container);
        }, 200);
      };
      window.addEventListener('resize', window._ezbomResizeHandler);
    });
  }

  // ========================================================================
  // 10b. 視圖控制：縮放／旋轉／平移／線寬／顯示／輸出
  // 常駐控制區，桌面右側 dock、手機圖面下方橫向滑軌，兩者同一套狀態。
  // ========================================================================
  var view = { zoom:1, rot:0, panX:0, panY:0, stroke:1.6, labels:true, isolate:false, grid:false };
  var vSvg = null, vBox = null, vUI = {}, vBaseW = 0, vBaseH = 0, vBaseScale = 0, vRaf = 0;

  function vClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function vKey() {
    return 'ezbom_view_' + (new URLSearchParams(location.search).get('product') || 'default');
  }
  var vHadSaved = false;
  function vLoad() {
    vHadSaved = false;
    try {
      var s = JSON.parse(localStorage.getItem(vKey()) || 'null');
      if (s) {
        vHadSaved = true;
        ['zoom','rot','panX','panY','stroke'].forEach(function(k){
          if (typeof s[k] === 'number' && isFinite(s[k])) view[k] = s[k];
        });
        ['labels','isolate','grid'].forEach(function(k){
          if (typeof s[k] === 'boolean') view[k] = s[k];
        });
      }
    } catch (e) {}
    view.zoom = vClamp(view.zoom, svgZoomMin, svgZoomMax);
    view.rot = ((Math.round(view.rot) % 360) + 360) % 360;
    view.stroke = vClamp(view.stroke, 0.1, 6);
  }

  // 預設線寬＝該圖自己烘好的筆畫（dwg2drawing --stroke 逐圖調過），
  // 換算成螢幕像素後取用；沒存過使用者設定時才自動推導。
  // 全域固定 1.6px 會把密集圖糊掉：電器160 實測筆畫/線段中位長比
  // 12.24 倍（舊版 2.56），細齒與剖面線會黏成實心黑塊。
  function vAutoStroke() {
    if (!vSvg || !(vBaseScale > 1e-6)) return;
    var shapes = vSvg.querySelectorAll('path,circle,rect,ellipse,line');
    var vals = [];
    for (var i = 0; i < shapes.length && vals.length < 12; i++) {
      var a = parseFloat(shapes[i].getAttribute('stroke-width'));
      if (isFinite(a) && a > 0) vals.push(a);
    }
    if (!vals.length) return;
    vals.sort(function(a, b){ return a - b; });
    var baked = vals[Math.floor(vals.length / 2)];
    // 下限 0.45px：低於此在手機上淡到看不見（實測 0.25px 整張幾乎消失）；
    // 上限 2.0px 避免粗線把密集區黏成黑塊。
    var s = vClamp(+(baked * vBaseScale).toFixed(2), 0.45, 2.0);
    // 再用「筆畫／線段長度比」夾上限：baked 值是為某個顯示尺度調的，
    // 換到手機寬度可能過粗。夾完仍不得低于可見下限。
    var seg = vSegRefPx();
    if (seg && seg > 1e-4) s = Math.min(s, +(seg * 3.2).toFixed(2));
    view.stroke = vClamp(s, 0.45, 2.0);
  }

  // 取樣估線段長度（螢幕 px）。用 p60 而非中位數：平滑曲線細分會把
  // 中位數壓小（chain190／motor220 實證），p60 較貼近真實輪廓段。
  function vSegRefPx() {
    if (!vSvg || !(vBaseScale > 1e-6)) return null;
    var paths = vSvg.querySelectorAll('path');
    if (!paths.length) return null;
    var lens = [];
    var step = Math.max(1, Math.floor(paths.length / 24));
    for (var i = 0; i < paths.length && lens.length < 3000; i += step) {
      var p = paths[i], L = 0;
      try { L = p.getTotalLength(); } catch (e) { continue; }
      if (!L) continue;
      var n = Math.min(36, Math.max(8, Math.floor(L / 4)));
      var prev = null;
      for (var k = 0; k <= n; k++) {
        var pt;
        try { pt = p.getPointAtLength(L * k / n); } catch (e) { break; }
        if (prev) lens.push(Math.hypot(pt.x - prev.x, pt.y - prev.y));
        prev = pt;
      }
    }
    if (!lens.length) return null;
    lens.sort(function(a, b){ return a - b; });
    return lens[Math.floor(lens.length * 0.6)] * vBaseScale;
  }
  function vSave() {
    try { localStorage.setItem(vKey(), JSON.stringify(view)); } catch (e) {}
  }

  // 線寬以「螢幕像素」為單位：各圖 viewBox 尺度差很大（p-type 8400 vs
  // 齒輪箱 2000），同樣的 user-unit 筆畫在不同圖粗細差 4 倍。換算成
  // px × user-units-per-px，滑桿意義才一致。
  // 基准比例（zoom=1、rot=0 時的 螢幕px／使用者單位）。
  // 必須在「無 transform」狀態下量：transform 有 transition，設完立刻讀
  // getScreenCTM 會拿到動畫中或舊的矩陣，線寬就會跟著縮放旋轉一起漂。
  // CSS transform 不影響版面尺寸，所以只需 init 與 resize 各量一次。
  function vMeasureBase() {
    if (!vSvg) return;
    var pt = vSvg.style.transform, pr = vSvg.style.transition;
    vSvg.style.transition = 'none';
    vSvg.style.transform = 'none';
    try {
      var m = vSvg.getScreenCTM();
      if (m) {
        var s = Math.hypot(m.a, m.b);
        if (s > 1e-6) vBaseScale = s;
      }
      var br = vSvg.getBoundingClientRect();
      vBaseW = br.width || vBaseW; vBaseH = br.height || vBaseH;
    } catch (e) {}
    vSvg.style.transform = pt;
    vSvg.style.transition = pr;
    void vSvg.getBoundingClientRect();
  }

  function vUnitsPerPx() {
    if (vBaseScale > 1e-6) return 1 / vBaseScale;
    var vb = vSvg && vSvg.viewBox.baseVal;
    return (vb && vb.width && vBaseW) ? vb.width / vBaseW : 1;
  }

  function vApplyStroke() {
    if (!vSvg) return;
    var w = (view.stroke * vUnitsPerPx()).toFixed(4);
    vSvg.style.setProperty('--ez-stroke', w);
  }

  function vApply(animate) {
    if (!vSvg) return;
    vSvg.style.transformOrigin = 'center center';
    vSvg.style.transition = animate ? 'transform 0.18s cubic-bezier(.3,.8,.3,1)' : 'none';
    vSvg.style.transform = 'translate(' + view.panX.toFixed(1) + 'px,' + view.panY.toFixed(1) + 'px) '
                         + 'scale(' + view.zoom.toFixed(3) + ') rotate(' + view.rot + 'deg)';
    vApplyStroke();
    vBox.classList.toggle('ez-grid', !!view.grid);
    vBox.classList.toggle('ez-isolate', !!view.isolate);
    vBox.classList.toggle('ez-nolabels', !view.labels);
    vBox.classList.toggle('ez-moved', view.zoom > 1.02 || view.panX !== 0 || view.panY !== 0);
    vSync();
    if (vRaf) cancelAnimationFrame(vRaf);
    vRaf = requestAnimationFrame(function(){
      vRaf = 0;
      // dock 插入後容器寬度會變，等版面穩定再重算線寬與標籤座標
      vApplyStroke();
      updateLabels(vSvg, vBox);
    });
    vSave();
  }

  function vSync() {
    if (vUI.zoom) { vUI.zoom.value = String(view.zoom); }
    if (vUI.zoomOut) vUI.zoomOut.textContent = Math.round(view.zoom * 100) + '%';
    if (vUI.rot) vUI.rot.value = String(view.rot);
    if (vUI.rotOut) vUI.rotOut.textContent = view.rot + '°';
    if (vUI.stroke) vUI.stroke.value = String(view.stroke);
    if (vUI.strokeOut) vUI.strokeOut.textContent = view.stroke.toFixed(1) + 'px';
    ['labels','isolate','grid'].forEach(function(k){
      if (vUI[k]) vUI[k].setAttribute('aria-pressed', view[k] ? 'true' : 'false');
    });
  }

  function vZoom(d) { view.zoom = vClamp(view.zoom + d, svgZoomMin, svgZoomMax); vApply(true); }
  function vRotate(d) {
    view.rot = ((Math.round(view.rot + d) % 360) + 360) % 360;
    vApply(true);
  }
  function vReset() {
    view.zoom = 1; view.rot = 0; view.panX = 0; view.panY = 0;
    vApply(true);
    showToast('視圖已重置');
  }
  // 貼合：把「旋轉後」的外框縮到剛好塞進容器（橫式轉直式時最需要）
  function vFit() {
    if (!vSvg || !vBaseW) return;
    var r = view.rot * Math.PI / 180;
    var rw = Math.abs(vBaseW * Math.cos(r)) + Math.abs(vBaseH * Math.sin(r));
    var rh = Math.abs(vBaseW * Math.sin(r)) + Math.abs(vBaseH * Math.cos(r));
    var cw = vBox.clientWidth, ch = vBox.clientHeight;
    if (!rw || !rh || !cw || !ch) return;
    view.zoom = vClamp(Math.min(cw / rw, ch / rh) * 0.96, svgZoomMin, svgZoomMax);
    view.panX = 0; view.panY = 0;
    vApply(true);
    showToast('已貼合視窗 ' + Math.round(view.zoom * 100) + '%');
  }

  function vDownload(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
  }

  // 匯出：把目前線寬與旋轉烘進檔案（旋转用包覆 g + 重算 viewBox）
  function vExportSVG() {
    var NS = 'http://www.w3.org/2000/svg';
    var clone = vSvg.cloneNode(true);
    clone.removeAttribute('style'); clone.removeAttribute('class');
    var vb = vSvg.viewBox.baseVal;
    var w = vb.width, h = vb.height;
    var r = view.rot * Math.PI / 180;
    var cw = Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r));
    var ch = Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r));
    var cx = vb.x + w / 2, cy = vb.y + h / 2;
    var wrap = document.createElementNS(NS, 'g');
    while (clone.firstChild) wrap.appendChild(clone.firstChild);
    wrap.setAttribute('transform', 'translate(' + (cw / 2 - cx).toFixed(2) + ','
      + (ch / 2 - cy).toFixed(2) + ') rotate(' + view.rot + ' ' + cx.toFixed(2) + ' ' + cy.toFixed(2) + ')');
    var bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x','0'); bg.setAttribute('y','0');
    bg.setAttribute('width', String(cw)); bg.setAttribute('height', String(ch));
    bg.setAttribute('fill','#FFFFFF');
    clone.appendChild(bg); clone.appendChild(wrap);
    clone.setAttribute('viewBox', '0 0 ' + cw.toFixed(2) + ' ' + ch.toFixed(2));
    clone.setAttribute('width', String(Math.round(cw)));
    clone.setAttribute('height', String(Math.round(ch)));
    var sw = (view.stroke * vUnitsPerPx()).toFixed(3);
    var shapes = clone.querySelectorAll('path,circle,rect,ellipse,line,polyline,polygon');
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i];
      s.removeAttribute('style'); s.removeAttribute('class');
      s.setAttribute('stroke', '#141413');
      s.setAttribute('stroke-width', sw);
      s.setAttribute('fill', 'none');
    }
    var gs = clone.querySelectorAll('g');
    for (var j = 0; j < gs.length; j++) gs[j].removeAttribute('class');
    return { text: new XMLSerializer().serializeToString(clone), w: cw, h: ch };
  }

  function vSaveSVG() {
    var o = vExportSVG();
    var pid = new URLSearchParams(location.search).get('product') || 'drawing';
    vDownload(pid + '_' + view.rot + 'deg.svg', new Blob([o.text], { type:'image/svg+xml;charset=utf-8' }));
    showToast('已下載 SVG');
  }

  function vSavePNG() {
    var o = vExportSVG();
    var pid = new URLSearchParams(location.search).get('product') || 'drawing';
    var scale = Math.min(3, Math.max(1, 2400 / Math.max(o.w, o.h)));
    var img = new Image();
    var url = URL.createObjectURL(new Blob([o.text], { type:'image/svg+xml;charset=utf-8' }));
    img.onload = function() {
      var c = document.createElement('canvas');
      c.width = Math.round(o.w * scale); c.height = Math.round(o.h * scale);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function(b){
        if (b) { vDownload(pid + '_' + view.rot + 'deg.png', b); showToast('已下載 PNG'); }
        else showToast('PNG 產生失敗');
      }, 'image/png');
    };
    img.onerror = function(){ URL.revokeObjectURL(url); showToast('PNG 產生失敗'); };
    img.src = url;
  }

  function vBtn(label, title, fn, cls) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ezc-btn' + (cls ? ' ' + cls : '');
    b.innerHTML = label; b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  }
  function vGroup(title) {
    var g = document.createElement('div');
    g.className = 'ezc-group';
    var t = document.createElement('span');
    t.className = 'ezc-title'; t.textContent = title;
    g.appendChild(t);
    return g;
  }
  function vSlider(min, max, step, val, onInput, cls) {
    var s = document.createElement('input');
    s.type = 'range'; s.min = String(min); s.max = String(max);
    s.step = String(step); s.value = String(val);
    s.className = 'ezc-range' + (cls ? ' ' + cls : '');
    s.addEventListener('input', function(){ onInput(parseFloat(this.value)); });
    return s;
  }
  function vOut(txt) {
    var o = document.createElement('span');
    o.className = 'ezc-out'; o.textContent = txt;
    return o;
  }

  function addViewControls(container, svg) {
    vSvg = svg; vBox = container; vUI = {};
    var br = svg.getBoundingClientRect();
    vBaseW = br.width || svg.clientWidth || 1;
    vBaseH = br.height || svg.clientHeight || 1;
    vLoad();

    var scope = document.getElementById('svg-panel') || container.parentNode || container;
    var old = scope.querySelector('.ezc-dock');
    if (old) old.remove();
    var dock = document.createElement('div');
    dock.className = 'ezc-dock';

    // ── 視圖：縮放 ──
    var g1 = vGroup('縮放');
    var row1 = document.createElement('div'); row1.className = 'ezc-row';
    row1.appendChild(vBtn('−', '縮小', function(){ vZoom(-svgZoomStep); }));
    vUI.zoomOut = vOut(Math.round(view.zoom * 100) + '%');
    row1.appendChild(vUI.zoomOut);
    row1.appendChild(vBtn('+', '放大', function(){ vZoom(svgZoomStep); }));
    g1.appendChild(row1);
    vUI.zoom = vSlider(svgZoomMin, svgZoomMax, 0.05, view.zoom, function(v){
      view.zoom = vClamp(v, svgZoomMin, svgZoomMax); vApply(false);
    });
    vUI.zoom.setAttribute('aria-label', '縮放比例');
    g1.appendChild(vUI.zoom);
    dock.appendChild(g1);

    // ── 旋轉 ──
    var g2 = vGroup('旋轉');
    var row2 = document.createElement('div'); row2.className = 'ezc-row';
    row2.appendChild(vBtn('⟲', '逆時針 90°', function(){ vRotate(-90); }));
    vUI.rotOut = vOut(view.rot + '°');
    row2.appendChild(vUI.rotOut);
    row2.appendChild(vBtn('⟳', '順時針 90°', function(){ vRotate(90); }));
    g2.appendChild(row2);
    vUI.rot = vSlider(0, 359, 1, view.rot, function(v){
      view.rot = Math.round(v); vApply(false);
    });
    vUI.rot.setAttribute('aria-label', '旋轉角度');
    g2.appendChild(vUI.rot);
    var row2b = document.createElement('div'); row2b.className = 'ezc-row';
    row2b.appendChild(vBtn('180°', '翻轉 180°', function(){ vRotate(180); }, 'ezc-wide'));
    row2b.appendChild(vBtn('貼合', '貼合視窗', vFit, 'ezc-wide'));
    g2.appendChild(row2b);
    dock.appendChild(g2);

    // ── 線條 ──
    var g3 = vGroup('線寬');
    var row3 = document.createElement('div'); row3.className = 'ezc-row';
    vUI.strokeOut = vOut(view.stroke.toFixed(1) + 'px');
    row3.appendChild(vUI.strokeOut);
    row3.appendChild(vBtn('細', '細線（細齒／剖面圖）', function(){
      view.stroke = 0.6; vApply(false);
    }, 'ezc-wide'));
    row3.appendChild(vBtn('粗', '粗線（淡圖加強）', function(){
      view.stroke = 2.6; vApply(false);
    }, 'ezc-wide'));
    g3.appendChild(row3);
    vUI.stroke = vSlider(0.1, 6, 0.05, view.stroke, function(v){
      view.stroke = vClamp(v, 0.1, 6); vApply(false);
    });
    vUI.stroke.setAttribute('aria-label', '線條粗細');
    g3.appendChild(vUI.stroke);
    dock.appendChild(g3);

    // ── 顯示 ──
    var g4 = vGroup('顯示');
    var row4 = document.createElement('div'); row4.className = 'ezc-row';
    vUI.labels = vBtn('標籤', '零件標籤開關', function(){
      view.labels = !view.labels; vApply(false);
    }, 'ezc-toggle');
    vUI.isolate = vBtn('聚焦', '淡化未選零件', function(){
      view.isolate = !view.isolate; vApply(false);
    }, 'ezc-toggle');
    vUI.grid = vBtn('格線', '藍圖格線', function(){
      view.grid = !view.grid; vApply(false);
    }, 'ezc-toggle');
    row4.appendChild(vUI.labels); row4.appendChild(vUI.isolate); row4.appendChild(vUI.grid);
    g4.appendChild(row4);
    dock.appendChild(g4);

    // ── 輸出／重置 ──
    var g5 = vGroup('輸出');
    var row5 = document.createElement('div'); row5.className = 'ezc-row';
    row5.appendChild(vBtn('SVG', '下載目前視圖 SVG', vSaveSVG, 'ezc-wide'));
    row5.appendChild(vBtn('PNG', '下載目前視圖 PNG', vSavePNG, 'ezc-wide'));
    g5.appendChild(row5);
    var row6 = document.createElement('div'); row6.className = 'ezc-row';
    row6.appendChild(vBtn('↺ 重置', '重置縮放／旋轉／平移', vReset, 'ezc-wide ezc-reset'));
    if (document.documentElement.requestFullscreen) {
      row6.appendChild(vBtn('⛶', '全螢幕', function(){
        if (document.fullscreenElement) document.exitFullscreen();
        else container.requestFullscreen().catch(function(){});
      }, 'ezc-wide'));
    }
    g5.appendChild(row6);
    dock.appendChild(g5);

    // dock 一律掛在 svg-panel 底下、圖面之外：桌面靠 flex row 變成右側
    // 獨立欄，手機靠 column 變成圖面下方橫向滑軌。兩者都不遮住爆炸圖。
    var panel = document.getElementById('svg-panel') || container.parentNode;
    if (window.innerWidth <= 768) dock.classList.add('ezc-mobile');
    panel.appendChild(dock);
    vInstallGestures(container, svg);
    vMeasureBase();
    if (!vHadSaved) vAutoStroke();
    vApply(false);
  }

  function vInstallGestures(container, svg) {
    if (container.__ezGestures) return;
    container.__ezGestures = true;

    // 滾輪縮放（不需按 Ctrl，圖面本来就是畫布）
    container.addEventListener('wheel', function(e) {
      if (e.target.closest && e.target.closest('.ezc-dock')) return;
      e.preventDefault();
      var d = (e.deltaY > 0 ? -1 : 1) * svgZoomStep * (e.ctrlKey ? 0.5 : 1);
      view.zoom = vClamp(view.zoom + d, svgZoomMin, svgZoomMax);
      vApply(false);
    }, { passive:false });

    // 雙擊：放大／回到 100%
    container.addEventListener('dblclick', function(e) {
      if (e.target.closest && e.target.closest('.ezc-dock')) return;
      if (view.zoom > 1.4) { view.zoom = 1; view.panX = 0; view.panY = 0; }
      else view.zoom = vClamp(view.zoom * 1.8, svgZoomMin, svgZoomMax);
      vApply(true);
    });

    // 單指／滑鼠拖曳平移；雙指 pinch 縮放 + twist 旋轉
    var pts = new Map(), start = null, pinch = null, moved = false;
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function ang(a, b) { return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; }

    container.addEventListener('pointerdown', function(e) {
      if (e.target.closest && e.target.closest('.ezc-dock')) return;
      pts.set(e.pointerId, { x:e.clientX, y:e.clientY });
      moved = false;
      if (pts.size === 1) {
        start = { x:e.clientX, y:e.clientY, px:view.panX, py:view.panY };
      } else if (pts.size === 2) {
        var a = Array.from(pts.values());
        pinch = { d:dist(a[0], a[1]), a:ang(a[0], a[1]), z:view.zoom, r:view.rot };
        start = null;
      }
    });

    container.addEventListener('pointermove', function(e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if (pts.size >= 2 && pinch) {
        var a = Array.from(pts.values());
        var nd = dist(a[0], a[1]), na = ang(a[0], a[1]);
        if (pinch.d > 8) {
          view.zoom = vClamp(pinch.z * (nd / pinch.d), svgZoomMin, svgZoomMax);
          var dr = na - pinch.a;
          if (Math.abs(dr) > 6) view.rot = ((Math.round(pinch.r + dr) % 360) + 360) % 360;
          moved = true;
          vApply(false);
        }
        return;
      }
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      // 未放大時單指留給頁面捲動（手機），放大後才平移
      if (view.zoom <= 1.02 && e.pointerType === 'touch') return;
      moved = true;
      view.panX = start.px + dx; view.panY = start.py + dy;
      if (container.setPointerCapture) {
        try { container.setPointerCapture(e.pointerId); } catch (err) {}
      }
      vApply(false);
    });

    function up(e) {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) { start = null; }
      if (moved) {
        // 拖曳後抑制這一次 click，避免誤選零件
        container.__ezSuppressClick = true;
        setTimeout(function(){ container.__ezSuppressClick = false; }, 260);
      }
    }
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
    container.addEventListener('pointerleave', up);

    // 鍵盤：+ - 縮放、[ ] 旋轉、0 重置、F 貼合
    document.addEventListener('keydown', function(e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key;
      if (k === '+' || k === '=') { e.preventDefault(); vZoom(svgZoomStep); }
      else if (k === '-' || k === '_') { e.preventDefault(); vZoom(-svgZoomStep); }
      else if (k === '[') { e.preventDefault(); vRotate(-90); }
      else if (k === ']') { e.preventDefault(); vRotate(90); }
      else if (k === '0') { e.preventDefault(); vReset(); }
      else if (k === 'f' || k === 'F') { e.preventDefault(); vFit(); }
    });
  }

  // 舊 API 相容（外部若曾呼叫）
  function zoomSVG(svg, delta) { vZoom(delta); }
  function resetSVGZoom(svg) { vReset(); }

  function updateLabels(svg, container) {
    bomData.forEach(function(item) {
      var labelEl = partLabels.get(item.id);
      if (!labelEl) return;
      var g = document.querySelector('g[data-part-id="' + item.id + '"]');
      if (!g) return;
      try {
        var b = g.getBBox();
        var pos = svgPointToContainer(svg, container, b.x + b.width / 2, b.y + b.height / 2);
        labelEl.style.left = pos.left + 'px';
        labelEl.style.top = pos.top + 'px';
      } catch (e) { /* ignore */ }
    });
  }

  // ========================================================================
  // 11. 手機 Tab 切換
  // ========================================================================
  window.switchTab = function(tab) {
    if (tab === 'svg' || tab === 'bom') tab = 'main';  // 舊 tab 名相容
    if (tab === 'stats' && !_isAdmin()) {
      var overlay = document.getElementById('pw-overlay');
      if (overlay) overlay.style.display = 'flex';
      var pwInput = document.getElementById('pw-input');
      if (pwInput) pwInput.focus();
      return;
    }
    currentTab = tab;

    if (_isAdmin()) {
      var statsIcon = document.getElementById('stats-tab-icon');
      if (statsIcon) statsIcon.textContent = '📊';
    }

    document.querySelectorAll('.mobile-tabs button').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });

    var svgPanel = document.getElementById('svg-panel');
    var bomPanel = document.getElementById('bom-panel');
    var statsPanel = document.getElementById('stats-panel');

    // main：爆炸圖與 BOM 清單同頁堆疊（手機）；stats：統計內容
    if (svgPanel) svgPanel.style.display = tab === 'stats' ? 'none' : 'flex';
    if (bomPanel) bomPanel.classList.toggle('active', true);
    if (statsPanel) statsPanel.style.display = tab === 'stats' ? 'block' : 'none';

    if (tab === 'stats' && !window._statsLoaded) {
      loadStats();
    }
  };

  // ========================================================================
  // 12. 返回 & 分享
  // ========================================================================
  window.goBack = function() {
    window.location.href = './index.html';
  };

  window.shareProduct = function() {
    var url = window.location.href;
    var title = (productConfig ? productConfig.name : 'EzBOM') + ' - 零件詢價';
    if (navigator.share) {
      navigator.share({
        title: title,
        text: '查看 ' + (productConfig ? productConfig.name : '產品') + ' 的爆炸圖與 BOM 零件清單',
        url: url
      }).catch(function() {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        showToast('產品連結已複製到剪貼簿');
      });
    } else {
      prompt('請複製以下網址分享此產品：', url);
    }
  };

  // ========================================================================
  // 13. 採購統計載入
  // ========================================================================
  async function loadStats() {
    var loading = document.getElementById('stats-loading');
    var content = document.getElementById('stats-content');
    var empty = document.getElementById('stats-empty');

    try {
      var res = await fetch('./data/stats.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var allStats = await res.json();
      var stats = allStats[productId];

      if (!stats || !stats.hotParts || stats.hotParts.length === 0) {
        if (loading) loading.style.display = 'none';
        if (empty) empty.style.display = 'block';
        window._statsLoaded = true;
        return;
      }

      // 高頻零件 TOP 5
      var hotList = document.getElementById('hot-parts-list');
      var medals = ['🥇','🥈','🥉','4','5'];
      hotList.innerHTML = stats.hotParts.slice(0, 5).map(function(p, i) {
        return '<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid #E6E3DA;font-size:12px;' + (i === 0 ? 'font-weight:600;color:#D97757' : '') + '">' +
          '<span style="width:24px;text-align:center;">' + medals[i] + '</span>' +
          '<span style="flex:1;margin:0 8px;">' + S.escapeHtml(p.partNumber) + '</span>' +
          '<span style="color:#87867F;">' + p.totalQty + '件 / ' + p.orderCount + '次</span>' +
        '</div>';
      }).join('');

      // 客戶排名
      var custList = document.getElementById('customer-stats');
      custList.innerHTML = stats.topCustomers.slice(0, 5).map(function(c, i) {
        return '<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid #E6E3DA;font-size:12px;">' +
          '<span style="width:24px;text-align:center;color:#87867F;">' + (i+1) + '</span>' +
          '<span style="flex:1;margin:0 8px;">' + S.escapeHtml(c.name) + '</span>' +
          '<span style="color:#87867F;">' + c.orderCount + '次 / ' + c.totalQty + '件</span>' +
        '</div>';
      }).join('');

      // 月度趨勢
      var monthlyList = document.getElementById('monthly-stats');
      var maxQty = Math.max.apply(null, stats.monthlyStats.map(function(m) { return m.totalQty; }).concat([1]));
      monthlyList.innerHTML = stats.monthlyStats.map(function(m) {
        var pct = (m.totalQty / maxQty * 100).toFixed(0);
        return '<div style="display:flex;align-items:center;padding:4px 0;font-size:12px;">' +
          '<span style="width:60px;color:#87867F;">' + S.escapeHtml(m.month) + '</span>' +
          '<div style="flex:1;height:18px;background:#E6E3DA;border-radius:4px;overflow:hidden;margin:0 8px;">' +
            '<div style="height:100%;width:' + pct + '%;background:#D97757;border-radius:4px;"></div>' +
          '</div>' +
          '<span style="width:50px;text-align:right;color:#141413;">' + m.totalQty + '</span>' +
        '</div>';
      }).join('');

      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'block';
      window._statsLoaded = true;

    } catch (err) {
      if (loading) loading.textContent = '無法載入統計資料：' + err.message;
    }
  }




  // ========================================================================
  // 15. 鍵盤快速鍵
  // ========================================================================
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
      // Ctrl/Cmd+Z = 撤銷
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // 不在輸入框內才觸發快捷鍵
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Esc = 清除選擇
      if (e.key === 'Escape') {
        window.clearAll();
        return;
      }

      // / = 聚焦搜尋框
      if (e.key === '/' && currentTab === 'main') {
        e.preventDefault();
        var searchBox = document.getElementById('search-box');
        if (searchBox) searchBox.focus();
        return;
      }

      // Ctrl+A = 全選（在非輸入框時）
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        window.selectAll();
        return;
      }


    });
  }

  // ========================================================================
  // 16. 啟動
  // ========================================================================
  function init() {

    initKeyboardShortcuts();
    loadProduct();
  }

  // 頁面載入完成後啟動
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
