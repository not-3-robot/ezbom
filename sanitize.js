/**
 * EzBOM Sanitize — XSS 防护共用模组
 *
 * 所有 innerHTML 操作前应先透过此模组转义使用者可控资料。
 * 零依赖，可独立载入。
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
   * HTML 转义 — 将特殊字元转为 HTML 实体
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
   * 安全 innerHTML — 先转义变数再拼接 HTML
   *
   * 用法：
   *   el.innerHTML = EzBOMSanitize.safeHTML('<div>${name}</div>', { name: userInput });
   *
   * @param {string} template 含 ${key} 占位符的模板
   * @param {object} values 键值对应
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
   * 安全 textContent 写入
   * @param {Element} el DOM 元素
   * @param {string} text 文字内容
   */
  function safeText(el, text) {
    if (el) el.textContent = text != null ? String(text) : '';
  }

  /**
   * 安全设定属性值
   * @param {Element} el DOM 元素
   * @param {string} attr 属性名
   * @param {string} value 属性值
   */
  function safeAttr(el, attr, value) {
    if (el && value != null) {
      el.setAttribute(attr, String(value));
    }
  }

  // ============================================================
  // 公开 API
  // ============================================================
  window.EzBOMSanitize = {
    escapeHtml: escapeHtml,
    safeHTML: safeHTML,
    safeText: safeText,
    safeAttr: safeAttr
  };

})();
