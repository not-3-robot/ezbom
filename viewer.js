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
  var ADMIN_PASSWORD_HASH = '';

  // 預設密碼 'webom2024' 的 SHA-256 hash
  // 可在部署時更換為自訂密碼的 hash
  var DEFAULT_HASH = '6d23d6842954d957582968838f89ae5302f8628f6dc861b3187d18d92d997b87';

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
    var svgRect = svgEl.getBoundingClientRect();
    var containerRect = containerEl.getBoundingClientRect();
    var viewBox = svgEl.viewBox.baseVal;
    if (!viewBox || !viewBox.width || !viewBox.height) {
      return { left: svgX, top: svgY };
    }
    return {
      left: svgX * (svgRect.width / viewBox.width) + (svgRect.left - containerRect.left),
      top: svgY * (svgRect.height / viewBox.height) + (svgRect.top - containerRect.top)
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

  function processSVGAfterLoad() {
    var svg = document.querySelector('#svg-container svg');
    var container = document.querySelector('.svg-container');
    if (!svg) return;

    var isMobile = window.innerWidth <= 768;
    svg.style.width = '100%';
    svg.style.height = isMobile ? 'auto' : 'auto';
    if (!isMobile) svg.style.maxHeight = '100%';
    svg.style.preserveAspectRatio = isMobile ? 'xMinYMin meet' : 'xMidYMid meet';

    // 加入縮放控制按鈕（桌面版）
    if (!isMobile) {
      addZoomControls(container, svg);
    }

    requestAnimationFrame(function() {
      // 統一路徑樣式
      svg.querySelectorAll('path, circle, rect, ellipse, line').forEach(function(path) {
        path.style.stroke = '#141413';
        path.style.strokeWidth = '2px';
        path.style.fill = 'none';
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

        // 點擊選擇
        group.addEventListener('click', function() {
          togglePartSelection(partId);
          // 手機上：點擊後短暫顯示標籤
          if (window.innerWidth <= 768) {
            var el = partLabels.get(partId);
            if (el) {
              el.classList.add('show');
              clearTimeout(el._hideTimer);
              el._hideTimer = setTimeout(function() { el.classList.remove('show'); }, 1200);
            }
            group.classList.add('tap-highlight');
            setTimeout(function() { group.classList.remove('tap-highlight'); }, 400);
          }
        });

        // 桌面 hover 標籤
        group.addEventListener('mouseenter', function() {
          var el = partLabels.get(partId);
          if (el) el.classList.add('show');
        });
        group.addEventListener('mouseleave', function() {
          var el = partLabels.get(partId);
          if (el) el.classList.remove('show');
        });

        foundParts++;
      });

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
        labelTimer = setTimeout(function() { updateLabels(svg, container); }, 200);
      };
      window.addEventListener('resize', window._ezbomResizeHandler);
    });
  }

  function addZoomControls(container, svg) {
    var controls = document.createElement('div');
    controls.className = 'svg-zoom-controls';

    var zoomInBtn = document.createElement('button');
    zoomInBtn.textContent = '+';
    zoomInBtn.title = '放大';
    zoomInBtn.addEventListener('click', function() { zoomSVG(svg, svgZoomStep); });

    var zoomOutBtn = document.createElement('button');
    zoomOutBtn.textContent = '−';
    zoomOutBtn.title = '縮小';
    zoomOutBtn.addEventListener('click', function() { zoomSVG(svg, -svgZoomStep); });

    var zoomResetBtn = document.createElement('button');
    zoomResetBtn.textContent = '↺';
    zoomResetBtn.title = '重置';
    zoomResetBtn.addEventListener('click', function() { resetSVGZoom(svg); });

    controls.appendChild(zoomInBtn);
    controls.appendChild(zoomOutBtn);
    controls.appendChild(zoomResetBtn);
    container.appendChild(controls);

    // 滑鼠滾輪縮放
    container.addEventListener('wheel', function(e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        var delta = e.deltaY > 0 ? -svgZoomStep : svgZoomStep;
        zoomSVG(svg, delta);
      }
    }, { passive: false });
  }

  function zoomSVG(svg, delta) {
    svgZoomLevel = Math.max(svgZoomMin, Math.min(svgZoomMax, svgZoomLevel + delta));
    applyZoom(svg);
  }

  function resetSVGZoom(svg) {
    svgZoomLevel = 1;
    applyZoom(svg);
  }

  function applyZoom(svg) {
    svg.style.transform = 'scale(' + svgZoomLevel + ')';
    svg.style.transformOrigin = 'center center';
    svg.style.transition = 'transform 0.15s ease';
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
