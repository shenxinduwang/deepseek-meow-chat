/* ═══════════════════════════════════════════════════════
 * storage.js · 本地持久化（localStorage）
 *  - 聊天记录、设置、界面状态
 *  - 图片以 dataURL 内联存储；配额不足时自动剥离旧图降级
 * ═══════════════════════════════════════════════════════ */
"use strict";

const Storage = (() => {

  const K = APP_CONFIG.storageKeys;

  /* ---------- 工具 ---------- */
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function estimateSize(value) {
    try { return new Blob([JSON.stringify(value)]).size; }
    catch { return JSON.stringify(value).length; }
  }

  /* ---------- 设置 ---------- */
  function getSettings() {
    return Object.assign({}, APP_CONFIG.defaults, read(K.settings, {}));
  }

  function saveSettings(settings) {
    write(K.settings, settings);
  }

  /* ---------- 界面状态（模型 / 模式） ---------- */
  function getState() {
    const s = getSettings();
    return Object.assign({ model: s.model, mode: s.mode }, read(K.state, {}));
  }

  function saveState(state) {
    write(K.state, state);
  }

  /* ---------- 聊天记录 ---------- */
  /**
   * 消息结构：
   * { id, role:'user'|'assistant', content, reasoning?,
   *   images?:[dataURL], model?, mode?, ts, error?:{code,message}, done? }
   */
  function getMessages() {
    const list = read(K.messages, []);
    return Array.isArray(list) ? list : [];
  }

  /**
   * 保存消息列表；配额超限时逐步剥离最早的图片，仍不行则丢弃最早的消息。
   * @returns {{ok:boolean, stripped:number, dropped:number}}
   */
  function saveMessages(messages) {
    let data = messages;
    let stripped = 0, dropped = 0;

    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        write(K.messages, data);
        return { ok: true, stripped, dropped };
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        // 1) 先剥离最早一条带图消息的图片
        const idx = data.findIndex(m => m.images && m.images.length);
        if (idx !== -1) {
          data = data.map((m, i) =>
            i === idx ? Object.assign({}, m, { images: [], imagesStripped: true }) : m);
          stripped++;
          continue;
        }
        // 2) 没有图片可剥离 → 丢弃最早一条非最后消息
        if (data.length > 1) { data = data.slice(1); dropped++; continue; }
        return { ok: false, stripped, dropped };
      }
    }
    return { ok: false, stripped, dropped };
  }

  function isQuotaError(e) {
    return e && (e.name === "QuotaExceededError" ||
                 e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
                 /quota/i.test(e.message || ""));
  }

  function clearMessages() {
    localStorage.removeItem(K.messages);
  }

  /* ---------- 导出 / 导入 ---------- */
  function exportAll() {
    return JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: maskKey(read(K.settings, {})),
      messages: getMessages()
    }, null, 2);
  }

  /** 导出时隐藏 API Key，避免明文泄露 */
  function maskKey(settings) {
    const s = Object.assign({}, settings);
    if (s.apiKey) s.apiKey = s.apiKey.slice(0, 5) + "****" + s.apiKey.slice(-4);
    return s;
  }

  return {
    getSettings, saveSettings,
    getState, saveState,
    getMessages, saveMessages, clearMessages,
    exportAll, estimateSize
  };
})();
