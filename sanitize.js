/**
 * EzBOM Sanitize — XSS 防護共用模組
 *
 * 所有 innerHTML 操作前應先透過此模組轉義使用者可控資料。
 * 零依賴，可獨立載入。
 */
(function () {
  'use strict';

  var entityMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;'
  };

  /**
   * HTML 轉義 — 將特殊字元轉為 HTML 實體
   * @param {string} str 原始字串
   * @returns {string} 安全字串
   */
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"'`=\/]/g, function (s) {
      return entityMap[s];
    });
  }

  /**
   * 安全 innerHTML — 先轉義變數再拼接 HTML
   *
   * 用法：
   *   el.innerHTML = EzBOMSanitize.safeHTML('<div>${name}</div>', { name: userInput });
   *
   * @param {string} template 含 ${key} 佔位符的模板
   * @param {object} values 鍵值對應
   * @returns {string} 安全 HTML 字串
   */
  function safeHTML(template, values) {
    var result = template;
    if (values) {
      Object.keys(values).forEach(function (key) {
        var placeholder = '${' + key + '}';
        var val = values[key] != null ? String(values[key]) : '';
        result = result.split(placeholder).join(escapeHtml(val));
      });
    }
    return result;
  }

  /**
   * 安全 textContent 寫入
   * @param {Element} el DOM 元素
   * @param {string} text 文字內容
   */
  function safeText(el, text) {
    if (el) el.textContent = text != null ? String(text) : '';
  }

  /**
   * 安全設定屬性值
   * @param {Element} el DOM 元素
   * @param {string} attr 屬性名
   * @param {string} value 屬性值
   */
  function safeAttr(el, attr, value) {
    if (el && value != null) {
      el.setAttribute(attr, String(value));
    }
  }

  // ============================================================
  // 公開 API
  // ============================================================
  window.EzBOMSanitize = {
    escapeHtml: escapeHtml,
    safeHTML: safeHTML,
    safeText: safeText,
    safeAttr: safeAttr
  };

})();
