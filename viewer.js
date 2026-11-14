/**
 * EzBOM Viewer — 核心逻辑
 * 从 viewer.html 提取，独立维护
 *
 * 功能：
 *   - 产品载入 (SVG + BOM CSV)
 *   - SVG 爆炸图互动（桌面 hover + 手机 tap）
 *   - BOM 零件清单（搜寻、全选、清除）
 *   - 数量调整与询价邮件
 *   - 采购统计（管理员限定）
 *   - 键盘导航（↑↓ Enter）
 *   - SVG 缩放控制
 *   - 撤销支援

 */

(function () {
  'use strict';

  var S = window.EzBOMSanitize || { escapeHtml: function(s) { return String(s||''); } };

  // ========================================================================
  // 1. 全域状态
  // ========================================================================
  var params = new URLSearchParams(window.location.search);
  var productId = params.get('product') || 'wr075-gearbox-b-ba';
  var bomData = [];
  var selectedParts = new Map();
  var partLabels = new Map();
  var bomInitialized = false;
  var currentTab = 'main';
  var productConfig = null;

  // 撤销历史
  var undoStack = [];
  var MAX_UNDO = 50;

  // ========================================================================
  // 2. 管理员验证（改用 SHA-256 hash）
  // ========================================================================
  // 只存 SHA-256，原始码不出现明文（本站公开可读）。改密码需同步
  // admin.html 与此处，否则另一个入口仍会接受旧密码。
  var ADMIN_PASSWORD_HASH = '45eadc5e1f196c02b09c844a53bc23ea5efbf7f9f3339f91a666664440fef859';
  var DEFAULT_HASH = '45eadc5e1f196c02b09c844a53bc23ea5efbf7f9f3339f91a666664440fef859';

  window._isAdmin = function() {
    return sessionStorage.getItem('ezbom_admin') === '1';
  };

  window.verifyAdmin = function() {
    var input = document.getElementById('pw-input');
    var errEl = document.getElementById('pw-error');
    var pw = input.value;

    // 非同步计算 SHA-256
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
   * 使用 Web Crypto API 计算 SHA-256
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
    // 降级：简单 hash（安全性较低但优于明文）
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
  // 3. CSV 解析（强化版：支援引号包裹栏位）
  // ========================================================================
  function parseCSV(text) {
    var rows = [];
    var currentRow = [];
    var currentField = '';
    var inQuotes = false;
    var i = 0;
    var len = text.length;

    // 跳过 BOM
    if (text.charCodeAt(0) === 0xFEFF) i = 1;

    while (i < len) {
      var ch = text[i];
      var nextCh = i + 1 < len ? text[i + 1] : '';

      if (inQuotes) {
        if (ch === '"') {
          if (nextCh === '"') {
            // 跳脱引号
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

    // 处理最后一个栏位
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
      var id = row.Id || row.ID || row['标签ID'] || 'P' + String(idx + 1).padStart(2, '0');
      var itemNo = parseInt(row.ItemNo || row['项次'] || row['#'] || (idx + 1), 10);
      var partNumber = row.PartNumber || row['料品编号'] || row['Part No.'] || '';
      var name = row.Name || row['品名'] || row.Description || '';
      var quantity = parseInt(row.Quantity || row['数量'] || row.Qty || row['单 位 数 量'] || '1', 10);
      return { id: id, itemNo: itemNo, partNumber: partNumber, name: name, quantity: quantity };
    });
  }

  // ========================================================================
  // 4. 工具函数
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
    // getScreenCTM 涵盖 viewBox 偏移＋CSS scale/rotate/translate，
    // 旧版自算比例在旋转后会把标签放错位置（也忽略了 viewBox.x/y）。
    try {
      var m = svgEl.getScreenCTM();
      if (m && svgEl.createSVGPoint) {
        var pt = svgEl.createSVGPoint();
        pt.x = svgX; pt.y = svgY;
        var sp = pt.matrixTransform(m);
        return { left: sp.x - containerRect.left, top: sp.y - containerRect.top };
      }
    } catch (e) { /* 降级 */ }
    var svgRect = svgEl.getBoundingClientRect();
    var vb = svgEl.viewBox.baseVal;
    if (!vb || !vb.width || !vb.height) return { left: svgX, top: svgY };
    return {
      left: (svgX - vb.x) * (svgRect.width / vb.width) + (svgRect.left - containerRect.left),
      top: (svgY - vb.y) * (svgRect.height / vb.height) + (svgRect.top - containerRect.top)
    };
  }

  // ========================================================================
  // 5. 撤销系统
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

    // 清除目前选择
    selectedParts.forEach(function(_, pid) {
      updateBOMSelection(pid, false);
      updateSVGSelection(pid, false);
    });
    selectedParts.clear();

    // 还原上一个状态
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
    showToast('已复原 (剩余 ' + undoStack.length + ' 步)');
  }

  // ========================================================================
  // 6. 产品载入
  // ========================================================================
  async function loadProduct() {
    try {
      // 载入 products.json
      var manifestRes = await fetch('./products.json');
      if (!manifestRes.ok) throw new Error('无法载入产品清单');
      var manifest = await manifestRes.json();

      productConfig = manifest.products.find(function(p) { return p.id === productId; });
      if (!productConfig) throw new Error('找不到产品: ' + productId);

      S.safeText(document.getElementById('product-title'), productConfig.name);

      // 解析收件信箱（优先序：localStorage > 产品设定 > 全域设定）
      var globalEmail = manifest.emailTo || '';
      var productEmail = productConfig.emailTo || '';
      var savedEmail = localStorage.getItem('ezbom_emailTo') || '';
      var finalEmail = savedEmail || productEmail || globalEmail;
      document.getElementById('email-input').value = finalEmail;

      // 载入 BOM CSV
      S.safeText(document.getElementById('loading-text'), '载入零件清单...');
      var bomRes = await fetch(productConfig.bom);
      if (!bomRes.ok) throw new Error('无法载入 BOM 资料');
      var csvText = await bomRes.text();
      var rows = parseCSV(csvText);
      bomData = normalizeBOMData(rows);
      if (bomData.length === 0) throw new Error('BOM 资料为空');

      // 载入 SVG
      S.safeText(document.getElementById('loading-text'), '载入爆炸图...');
      var svgRes = await fetch(productConfig.svg);
      if (!svgRes.ok) throw new Error('无法载入爆炸图 SVG');
      var svgContent = await svgRes.text();

      // 安全注入 SVG：使用 DOMParser 解析，过滤危险元素
      var parser = new DOMParser();
      var doc = parser.parseFromString(svgContent, 'image/svg+xml');
      // 移除 <script> 标签和事件属性
      doc.querySelectorAll('script').forEach(function(el) { el.remove(); });
      var svgEl = doc.querySelector('svg');
      if (!svgEl) throw new Error('SVG 格式错误');
      // 移除所有 on* 事件属性
      svgEl.querySelectorAll('*').forEach(function(el) {
        var attrs = el.getAttributeNames();
        attrs.forEach(function(name) {
          if (name.indexOf('on') === 0) el.removeAttribute(name);
        });
      });
      document.getElementById('svg-container').innerHTML = '';
      document.getElementById('svg-container').appendChild(svgEl);
      document.getElementById('loading').classList.add('hidden');

      // 处理 SVG 互动
      processSVGAfterLoad();

      // Analytics
      if (window.EzBOMAnalytics) {
        window.EzBOMAnalytics.pageview(productId);
      }

    } catch (err) {
      S.safeText(document.getElementById('loading-error'), '错误：' + err.message);
      document.getElementById('loading-error').style.display = 'block';
      S.safeText(document.getElementById('loading-text'), '载入失败');
      if (window.EzBOMAnalytics) {
        window.EzBOMAnalytics.error('Product load failed: ' + err.message, err.stack, '', 0, 0);
      }
    }
  }

  // ========================================================================
  // 7. BOM 清单渲染
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
      qty.textContent = '数量: ' + item.quantity;

      info.appendChild(pn);
      info.appendChild(nm);
      info.appendChild(qty);

      div.appendChild(itemNo);
      div.appendChild(info);

      div.addEventListener('click', function() {
        togglePartSelection(item.id);
      });

      // 键盘导航
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

  // BOM 搜寻（含 SVG 零件高亮）
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
        // 3 秒后自动移除高亮
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
    showToast('已全选 ' + selectedParts.size + ' 个零件');
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
    showToast('已清除全部选择');
  };

  // ========================================================================
  // 8. 选择逻辑（含 localStorage 持久化）
  // ========================================================================
  var SELECTION_STORAGE_KEY = 'ezbom_selection_';

  function saveSelection() {
    try {
      var data = {};
      selectedParts.forEach(function(entry, partId) {
        data[partId] = entry.customQty;
      });
      localStorage.setItem(SELECTION_STORAGE_KEY + productId, JSON.stringify(data));
    } catch (e) { /* localStorage 不可用时静默失败 */ }
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
    } catch (e) { /* 解析失败时静默 */ }
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

    // 新选零件：卷到对应 BOM 项目（等 updateStats 重建 DOM 后再卷，动画才不会被取消）
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
  // 丛集级高亮：只亮使用者点到的那一个实体零件
  // 归组（assign_components 区域生长）会把邻件吸进同一群组——实测
  // ch160-ushort-trolley P34 有 1071 条子路径、10 个空间分离丛集、
  // bbox 横跨全图 80%。整组套 .selected 会把散在全图的同一料号实例
  // 一起亮起来＝「选一件连带别件」；只亮到部分丛集＝「只显示一半」。
  // 这里不改原始几何，改用覆盖层只画出目标丛集。
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
    // 用暂时 path 量每条子路径 bbox（含 A/C 等指令也准确）
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
    // 网格杂凑做邻近合并，避免 O(n²)（P36 有 2802 条子路径）
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
    return cs[0];   // BOM 列点选没有座标：亮最大丛集（主实例）
  }

  // 未归组（X000，无 inkscape:label）的几何：同一实体零件常被拆到
  // 「有料号群组」与 X000 两边，只亮料号那组＝使用者看到的「只显示一半」。
  // 这里把落在目标丛集范围内的未归组子路径一起补进高亮。
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

  // 2026-11-14 还原「整组放大变红」：停用丛集覆盖层绘制（使用者回报覆盖层
  // 只有一条线变红、比昨天下午差）。高亮改回 .svg-part.hovered/.selected
  // 的整组著色（scale 1.1 + 红描边 + 红填充 + 光晕，见 viewer.css）。
  function ezRenderSelection() { if (ezSelLayer) ezSelLayer.textContent = ''; }
  function ezRenderHover(g) { if (ezHoverLayer) ezHoverLayer.textContent = ''; }

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
  // 9. 发送询价 & 信箱设定
  // ========================================================================
  window.sendInquiry = function() {
    if (selectedParts.size === 0) return;

    var emailTo = document.getElementById('email-input').value.trim();
    if (!emailTo) {
      showToast('请先输入询价收件信箱');
      var emailInput = document.getElementById('email-input');
      if (emailInput) emailInput.focus();
      return;
    }

    var productName = productConfig ? productConfig.name : '';
    var subject = encodeURIComponent(
      (productName ? productName + ' - ' : '') + '零件询价请求 ' + new Date().toLocaleDateString('zh-TW')
    );

    var lines = ['尊敬的售后部门，', '', '请为以下零件提供报价：', ''];
    selectedParts.forEach(function(e) {
      var p = e.part;
      lines.push('• ' + p.partNumber + ' - ' + p.name + ' (数量: ' + e.customQty + ')');
    });
    var total = Array.from(selectedParts.values()).reduce(function(s, e) { return s + e.customQty; }, 0);
    lines.push('');
    lines.push('总计：' + selectedParts.size + ' 种，共 ' + total + ' 件');
    lines.push('', '请尽快回复报价，谢谢！', '', '此致', '敬礼');
    var body = encodeURIComponent(lines.join('\n'));

    var confirmMsg = '即将打开邮件客户端，发送 ' + selectedParts.size + ' 种零件（共 ' + total + ' 件）的询价请求？';
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

  // 复制询价清单到剪贴簿（替代 mailto 的可靠方案）
  window.copyInquiry = function() {
    if (selectedParts.size === 0) return;

    var emailTo = document.getElementById('email-input').value.trim();
    var productName = productConfig ? productConfig.name : '';
    var lines = ['零件询价清单', ''];
    if (productName) lines.push('产品：' + productName);
    if (emailTo) lines.push('收件信箱：' + emailTo);
    lines.push('日期：' + new Date().toLocaleDateString('zh-TW'), '');
    lines.push('零件清单：');
    selectedParts.forEach(function(e) {
      var p = e.part;
      lines.push('• ' + p.partNumber + ' - ' + p.name + ' (数量: ' + e.customQty + ')');
    });
    var total = Array.from(selectedParts.values()).reduce(function(s, e) { return s + e.customQty; }, 0);
    lines.push('', '总计：' + selectedParts.size + ' 种，共 ' + total + ' 件');

    var text = lines.join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        showToast('询价清单已复制到剪贴簿');
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
      showToast('请手动复制');
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
        btn.textContent = '已复制！';
        btn.style.background = '#788C5D';
        setTimeout(function() {
          btn.textContent = '复制到剪贴簿';
          btn.style.background = '#D97757';
        }, 2000);
      });
    } else {
      var ta = document.getElementById('fallback-text');
      ta.select();
      ta.setSelectionRange(0, 99999);
      showToast('请手动复制询价内容');
    }
  };

  window.saveEmail = function() {
    var email = document.getElementById('email-input').value.trim();
    if (email) {
      localStorage.setItem('ezbom_emailTo', email);
      showToast('收件信箱已储存：' + email);
    } else {
      showToast('请输入有效的邮箱地址');
    }
  };

  // ========================================================================
  // 10. SVG 处理（含缩放控制）
  // ========================================================================
  var svgZoomLevel = 1;
  var svgZoomMin = 0.3;
  var svgZoomMax = 3.0;
  var svgZoomStep = 0.15;

  // 命中解析：最小零件优先。
  // 群组按 P 号升序绘制，大零件的填色区（pointer-events:all）会盖在小零件上，
  // 原生 click / :hover 只认 paint order 最上层 → 点小件却选到大件。
  // 取该点「所有」候选元素，映射回所属零件，挑外框面积最小者＝最具体的那件。
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
        var b = g.getBBox();                 // user units：缩放／hover 缩放不影响
        a = Math.max(1, b.width * b.height);
      } catch (e) {}
      areaCache.set(g, a);
      return a;
    }

    // 描边命中判定：使用者瞄的是可见线条，所以「点在某件的描边上」要
    // 优先于「点落在另一件的填色区内」，否则小件填色区会抢走大件线条。
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

    // 点击（滑鼠与触控共用）
    svg.addEventListener('click', function(ev) {
      // 刚拖曳／pinch 过就不当成点选，避免平移后误选零件
      if (container.__ezSuppressClick) return;
      var g = resolveAt(ev.clientX, ev.clientY);
      if (!g) return;
      var partId = g.getAttribute('data-part-id');
      if (!partId) return;
      // 记录点击点（SVG user units），供丛集级高亮挑出正确实例
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

    // 桌面 hover：rAF 节流，解析结果没变就不动 DOM
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

    // 100% 缩放＝完整贴合容器：容器 overflow:hidden（为了自制平移），
    // 若 SVG 只限宽不限高，直式图算出的高度会超过容器而被裁掉。
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.maxWidth = '100%';
    svg.style.maxHeight = '100%';
    svg.style.preserveAspectRatio = 'xMidYMid meet';

    // 视图控制（缩放／旋转／线宽／显示／输出）——桌面与手机都给
    addViewControls(container, svg);

    requestAnimationFrame(function() {
      // 统一路径样式
      svg.querySelectorAll('path, circle, rect, ellipse, line').forEach(function(path) {
        path.style.stroke = '#141413';
        // 线宽交给 CSS var(--ez-stroke) 单一来源（见 vApplyStroke），
        // 不在此写死 inline，避免与视图控制互相覆写。
        path.style.strokeWidth = '';
        path.style.fill = 'none';
        // fill:none + 预设 pointer-events(visiblePainted) → 只有 2px 描边可点，
        // 零件内部点下去命中的是 <svg> 背景（实测 elementFromPoint 中心=svg）。
        // 'all' 让未填色的内部也接收滑鼠事件：桌面 hover 变大变红、手机才点得到。
        path.style.pointerEvents = 'all';
      });

      var foundParts = 0;
      svg.querySelectorAll('g').forEach(function(group) {
        var partId = null;

        // 从 inkscape:label 属性提取零件 ID
        for (var i = 0; i < group.attributes.length; i++) {
          var attr = group.attributes[i];
          if (attr.name === 'inkscape:label' && attr.value) {
            // P-id 契约（同 dwg2drawing.PID_RE / audit LBL）：
            // "P01-xxx" 取 dash 前段；"P01"（无 dash）整值即零件 ID
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

        // 浮动标签
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

      // 点击／hover 改由委派监听 + 最小零件优先解析（见 installHitResolution）
      installHitResolution(svg, container);
      // 覆盖层要在载入时就建立并挂上 ez-cluster-sel，否则尚未选取任何
      // 零件时 hover 仍会走旧的整组著色（＝连带别件）。
      ezEnsureLayers();
      ezRenderSelection();

      console.log('已处理 ' + foundParts + ' 个零件');
      if (!bomInitialized) { initBOMList(); }

      // 恢复上次选择（localStorage 持久化）
      restoreSelection();

      // resize 重新定位标签（避免重复绑定：先移除旧 listener）
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
  // 10b. 视图控制（2026-11-13 使用者裁定极简化）：
  // 控制面板全数移除——缩放走直接手势（滚轮／双击／双指 pinch），
  // 只留一颗浮动旋转钮，每点一次 +90°，只在 0/90/180/270 四档循环。
  // ========================================================================
  var view = { zoom:1, rot:0, panX:0, panY:0, stroke:1.6 };  // stroke＝自动推导，无使用者控制
  var vSvg = null, vBox = null, vUI = {}, vBaseW = 0, vBaseH = 0, vBaseScale = 0, vRaf = 0;

  function vClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function vKey() {
    return 'ezbom_view_' + (new URLSearchParams(location.search).get('product') || 'default');
  }
  function vLoad() {
    try {
      var s = JSON.parse(localStorage.getItem(vKey()) || 'null');
      if (s) {
        ['zoom','rot','panX','panY'].forEach(function(k){
          if (typeof s[k] === 'number' && isFinite(s[k])) view[k] = s[k];
        });
        // dock 时代的线宽偏好照旧沿用（线宽控制项已移除，但老使用者的
        // 偏好不该一夜变粗）；没存过的走 vAutoStroke 自动推导
        if (typeof s.stroke === 'number' && isFinite(s.stroke)) {
          view.stroke = vClamp(s.stroke, 0.45, 2.0);
        }
      }
    } catch (e) {}
    view.zoom = vClamp(view.zoom, svgZoomMin, svgZoomMax);
    // 旋转只有 90/180/270/360 四档：旧手势或旧设定残留的任意角度一律吸附到最近的 90°
    view.rot = (((Math.round(view.rot / 90) * 90) % 360) + 360) % 360;
  }

  // 预设线宽＝该图自己烘好的笔画（dwg2drawing --stroke 逐图调过），
  // 换算成萤幕像素后取用；没存过使用者设定时才自动推导。
  // 全域固定 1.6px 会把密集图糊掉：电器160 实测笔画/线段中位长比
  // 12.24 倍（旧版 2.56），细齿与剖面线会黏成实心黑块。
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
    // 下限 0.45px：低于此在手机上淡到看不见（实测 0.25px 整张几乎消失）；
    // 上限 2.0px 避免粗线把密集区黏成黑块。
    var s = vClamp(+(baked * vBaseScale).toFixed(2), 0.45, 2.0);
    // 再用「笔画／线段长度比」夹上限：baked 值是为某个显示尺度调的，
    // 换到手机宽度可能过粗。夹完仍不得低于可见下限。
    var seg = vSegRefPx();
    if (seg && seg > 1e-4) s = Math.min(s, +(seg * 3.2).toFixed(2));
    view.stroke = vClamp(s, 0.45, 2.0);
  }

  // 取样估线段长度（萤幕 px）。用 p60 而非中位数：平滑曲线细分会把
  // 中位数压小（chain190／motor220 实证），p60 较贴近真实轮廓段。
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

  // 线宽以「萤幕像素」为单位：各图 viewBox 尺度差很大（p-type 8400 vs
  // 齿轮箱 2000），同样的 user-unit 笔画在不同图粗细差 4 倍。换算成
  // px × user-units-per-px，滑杆意义才一致。
  // 基准比例（zoom=1、rot=0 时的 萤幕px／使用者单位）。
  // 必须在「无 transform」状态下量：transform 有 transition，设完立刻读
  // getScreenCTM 会拿到动画中或旧的矩阵，线宽就会跟著缩放旋转一起漂。
  // CSS transform 不影响版面尺寸，所以只需 init 与 resize 各量一次。
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
    vBox.classList.toggle('ez-moved', view.zoom > 1.02 || view.panX !== 0 || view.panY !== 0);
    vSync();
    if (vRaf) cancelAnimationFrame(vRaf);
    vRaf = requestAnimationFrame(function(){
      vRaf = 0;
      // dock 插入后容器宽度会变，等版面稳定再重算线宽与标签座标
      vApplyStroke();
      updateLabels(vSvg, vBox);
    });
    vSave();
  }

  function vSync() {
    if (vUI.rot) {
      vUI.rot.setAttribute('aria-label', '旋转图面（目前 ' + view.rot + '°，点击再转 90°）');
      var badge = vUI.rot.querySelector('.ez-rot-deg');
      if (badge) badge.textContent = view.rot === 0 ? '' : view.rot + '°';
      vUI.rot.classList.toggle('is-rotated', view.rot !== 0);
    }
  }

  function vRotate(d) {
    view.rot = ((Math.round(view.rot + d) % 360) + 360) % 360;
    vApply(true);
  }

  // 视图控制安装：只挂一颗浮动旋转钮（+90° 循环）＋手势；
  // 缩放／平移全走直接触碰（滚轮、双击、单指拖曳、双指 pinch）。
  function addViewControls(container, svg) {
    vSvg = svg; vBox = container; vUI = {};
    var br = svg.getBoundingClientRect();
    vBaseW = br.width || svg.clientWidth || 1;
    vBaseH = br.height || svg.clientHeight || 1;
    vLoad();

    var old = container.querySelector('.ez-rot');
    if (old) old.remove();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ez-rot';
    btn.innerHTML = '⟳<span class="ez-rot-deg"></span>';
    btn.title = '旋转 90°';
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      vRotate(90);
    });
    container.appendChild(btn);
    vUI.rot = btn;

    vInstallGestures(container, svg);
    vMeasureBase();
    // dock dock 时代存过线宽偏好的装置沿用自己的值（vLoad 已读入 view.stroke），
    // 1.6 1.6 是初始值＝从没偏好 → 走自动推导
    if (view.stroke === 1.6) vAutoStroke();
    vApply(false);
  }

  function vInstallGestures(container, svg) {
    if (container.__ezGestures) return;
    container.__ezGestures = true;

    // 滚轮缩放（不需按 Ctrl，图面本来就是画布）
    container.addEventListener('wheel', function(e) {
      if (e.target.closest && e.target.closest('.ez-rot')) return;
      e.preventDefault();
      var d = (e.deltaY > 0 ? -1 : 1) * svgZoomStep * (e.ctrlKey ? 0.5 : 1);
      view.zoom = vClamp(view.zoom + d, svgZoomMin, svgZoomMax);
      vApply(false);
    }, { passive:false });

    // 双击：放大／回到 100%
    container.addEventListener('dblclick', function(e) {
      if (e.target.closest && e.target.closest('.ez-rot')) return;
      if (view.zoom > 1.4) { view.zoom = 1; view.panX = 0; view.panY = 0; }
      else view.zoom = vClamp(view.zoom * 1.8, svgZoomMin, svgZoomMax);
      vApply(true);
    });

    // 单指／滑鼠拖曳平移；双指 pinch 缩放 + twist 旋转
    // twist 放开后吸附到最近的 90° 档（旋转只有 0/90/180/270 四档）
    var pts = new Map(), start = null, pinch = null, moved = false, twisted = false;
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function ang(a, b) { return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; }

    container.addEventListener('pointerdown', function(e) {
      if (e.target.closest && e.target.closest('.ez-rot')) return;
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
          if (Math.abs(dr) > 6) {
            view.rot = ((Math.round(pinch.r + dr) % 360) + 360) % 360;
            twisted = true;
          }
          moved = true;
          vApply(false);
        }
        return;
      }
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      // 未放大时单指留给页面卷动（手机），放大后才平移
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
      if (pts.size === 0) {
        start = null;
        if (twisted) {
          twisted = false;
          view.rot = (((Math.round(view.rot / 90) * 90) % 360) + 360) % 360;
          vApply(true);
        }
      }
      if (moved) {
        // 拖曳后抑制这一次 click，避免误选零件
        container.__ezSuppressClick = true;
        setTimeout(function(){ container.__ezSuppressClick = false; }, 260);
      }
    }
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
    container.addEventListener('pointerleave', up);
  }

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
  // 11. 手机 Tab 切换
  // ========================================================================
  window.switchTab = function(tab) {
    if (tab === 'svg' || tab === 'bom') tab = 'main';  // 旧 tab 名相容
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

    // main：爆炸图与 BOM 清单同页堆叠（手机）；stats：统计内容
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
    var title = (productConfig ? productConfig.name : 'EzBOM') + ' - 零件询价';
    if (navigator.share) {
      navigator.share({
        title: title,
        text: '查看 ' + (productConfig ? productConfig.name : '产品') + ' 的爆炸图与 BOM 零件清单',
        url: url
      }).catch(function() {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        showToast('产品连结已复制到剪贴簿');
      });
    } else {
      prompt('请复制以下网址分享此产品：', url);
    }
  };

  // ========================================================================
  // 13. 采购统计载入
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

      // 高频零件 TOP 5
      var hotList = document.getElementById('hot-parts-list');
      var medals = ['🥇','🥈','🥉','4','5'];
      hotList.innerHTML = stats.hotParts.slice(0, 5).map(function(p, i) {
        return '<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid #E6E3DA;font-size:12px;' + (i === 0 ? 'font-weight:600;color:#D97757' : '') + '">' +
          '<span style="width:24px;text-align:center;">' + medals[i] + '</span>' +
          '<span style="flex:1;margin:0 8px;">' + S.escapeHtml(p.partNumber) + '</span>' +
          '<span style="color:#87867F;">' + p.totalQty + '件 / ' + p.orderCount + '次</span>' +
        '</div>';
      }).join('');

      // 客户排名
      var custList = document.getElementById('customer-stats');
      custList.innerHTML = stats.topCustomers.slice(0, 5).map(function(c, i) {
        return '<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid #E6E3DA;font-size:12px;">' +
          '<span style="width:24px;text-align:center;color:#87867F;">' + (i+1) + '</span>' +
          '<span style="flex:1;margin:0 8px;">' + S.escapeHtml(c.name) + '</span>' +
          '<span style="color:#87867F;">' + c.orderCount + '次 / ' + c.totalQty + '件</span>' +
        '</div>';
      }).join('');

      // 月度趋势
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
      if (loading) loading.textContent = '无法载入统计资料：' + err.message;
    }
  }




  // ========================================================================
  // 15. 键盘快速键
  // ========================================================================
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
      // Ctrl/Cmd+Z = 撤销
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // 不在输入框内才触发快捷键
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Esc = 清除选择
      if (e.key === 'Escape') {
        window.clearAll();
        return;
      }

      // / = 聚焦搜寻框
      if (e.key === '/' && currentTab === 'main') {
        e.preventDefault();
        var searchBox = document.getElementById('search-box');
        if (searchBox) searchBox.focus();
        return;
      }

      // Ctrl+A = 全选（在非输入框时）
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        window.selectAll();
        return;
      }


    });
  }

  // ========================================================================
  // 16. 启动
  // ========================================================================
  function init() {

    initKeyboardShortcuts();
    loadProduct();
  }

  // 页面载入完成后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
