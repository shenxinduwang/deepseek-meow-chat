/* ═══════════════════════════════════════════════════════
 * api.js · DeepSeek API 客户端
 *  - OpenAI 兼容 chat/completions 协议（Bearer 认证）
 *  - 流式 SSE 解析（含 reasoning_content 思考流）
 *  - 超时控制、指数退避自动重试、错误分类
 * ═══════════════════════════════════════════════════════ */
"use strict";

/* 自定义错误：携带 code，便于 UI 分类提示 */
class ApiError extends Error {
  constructor(code, message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;          // no_key | auth | quota | model | rate_limit | server | network | timeout | aborted | parse | unknown
    this.status = status;
    this.retryable = retryable;
  }
}

const DeepSeekAPI = (() => {

  /* ---------- 请求体构造 ---------- */
  function buildBody({ model, messages, mode, settings }) {
    const body = {
      model,
      messages,
      stream: !!settings.stream,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens
    };
    // 按模式注入附加参数（思考 / 联网），见 config.js
    const extra = APP_CONFIG.modeParams[mode];
    if (extra) Object.assign(body, extra);
    // 非思考模式显式关闭（部分实现要求显式传 false）
    if (mode === "none") body.enable_thinking = false;
    return body;
  }

  /* ---------- HTTP 状态码 → 友好错误 ---------- */
  function statusToError(status, detail) {
    switch (status) {
      case 401: return new ApiError("auth", "API Key 无效或已过期，请在设置中检查密钥", { status });
      case 402: return new ApiError("quota", "账户余额不足，请前往 DeepSeek 平台充值", { status });
      case 403: return new ApiError("auth", "没有访问权限（403），请确认密钥权限", { status });
      case 404: return new ApiError("model", "模型不可用（404），请确认模型名称是否正确", { status });
      case 422: return new ApiError("model", "请求参数有误（422）：" + (detail || "请检查消息格式"), { status });
      case 429: return new ApiError("rate_limit", "请求过于频繁（429），稍后会自动重试", { status, retryable: true });
      default:
        if (status >= 500) return new ApiError("server", `服务器开小差了（${status}），稍后会自动重试`, { status, retryable: true });
        return new ApiError("unknown", `请求失败（${status}）${detail ? "：" + detail : ""}`, { status, retryable: status >= 500 });
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- 单次请求（含流式解析） ---------- */
  async function requestOnce({ model, messages, mode, settings, signal, onDelta, onReasoning, onSearchInfo }) {
    const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const body = buildBody({ model, messages, mode, settings });

    if (!settings.apiKey) throw new ApiError("no_key", "尚未配置 API Key，点击右上角 ⚙️ 填写");

    /* 超时控制：无数据 idleTimeout 毫秒则中断。
     * 流式期间每收到 chunk 会重置计时器。 */
    const idleMs = settings.timeoutSec * 1000;
    const timeoutCtrl = new AbortController();
    let timer = setTimeout(() => timeoutCtrl.abort(new DOMException("timeout", "TimeoutError")), idleMs);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => timeoutCtrl.abort(new DOMException("timeout", "TimeoutError")), idleMs);
    };
    // 外部信号（用户点击停止）联动
    const onOuterAbort = () => timeoutCtrl.abort(signal.reason || new DOMException("aborted", "AbortError"));
    if (signal) {
      if (signal.aborted) throw new ApiError("aborted", "已取消");
      signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + settings.apiKey
        },
        body: JSON.stringify(body),
        signal: timeoutCtrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new ApiError("timeout", `等待 ${settings.timeoutSec} 秒无响应，已超时`, { retryable: true });
      }
      if (e.name === "AbortError") throw new ApiError("aborted", "已停止生成");
      throw new ApiError("network", "网络连接失败，请检查网络或 API 地址", { retryable: true });
    }

    if (!resp.ok) {
      clearTimeout(timer);
      let detail = "";
      try {
        const j = await resp.json();
        detail = (j.error && (j.error.message || j.error.msg)) || j.message || "";
      } catch { /* 忽略解析失败 */ }
      throw statusToError(resp.status, detail);
    }

    /* ── 非流式 ── */
    if (!settings.stream) {
      clearTimeout(timer);
      const j = await resp.json();
      const choice = j.choices && j.choices[0];
      const msg = (choice && choice.message) || {};
      if (msg.reasoning_content && onReasoning) onReasoning(msg.reasoning_content);
      if (msg.content && onDelta) onDelta(msg.content);
      return { content: msg.content || "", reasoning: msg.reasoning_content || "" };
    }

    /* ── 流式 SSE 解析 ── */
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let content = "", reasoning = "";
    let streamStarted = false;   // 已产出内容后不再自动重试

    const handlePayload = (payloadStr) => {
      if (payloadStr === "[DONE]") return true;
      let data;
      try { data = JSON.parse(payloadStr); } catch { return false; }
      if (data.error) throw statusToError(data.error.code || 500, data.error.message);
      const delta = data.choices && data.choices[0] && data.choices[0].delta;
      if (delta) {
        if (delta.reasoning_content) {
          streamStarted = true;
          reasoning += delta.reasoning_content;
          if (onReasoning) onReasoning(delta.reasoning_content, reasoning);
        }
        if (delta.content) {
          streamStarted = true;
          content += delta.content;
          if (onDelta) onDelta(delta.content, content);
        }
      }
      // 部分实现在流中返回搜索引用
      if (data.search_results && onSearchInfo) onSearchInfo(data.search_results);
      return false;
    };

    try {
      while (true) {
        resetTimer();
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const events = buf.split(/\n\n/);
        buf = events.pop();               // 末尾可能是不完整事件，留待下轮
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            if (handlePayload(payload)) { buf = ""; return { content, reasoning }; }
          }
        }
      }
    } catch (e) {
      if (e instanceof ApiError) { e.streamStarted = streamStarted; throw e; }
      if (e.name === "TimeoutError") {
        const err = new ApiError("timeout", `接收数据超时（${settings.timeoutSec}s 无响应）`, { retryable: !streamStarted });
        err.streamStarted = streamStarted;
        throw err;
      }
      if (e.name === "AbortError") {
        // 用户停止：把已生成内容带回
        const err = new ApiError("aborted", "已停止生成");
        err.partial = { content, reasoning };
        throw err;
      }
      const err = new ApiError("network", "数据流中断，请检查网络", { retryable: !streamStarted });
      err.streamStarted = streamStarted;
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
      try { reader.releaseLock(); } catch { /* noop */ }
    }

    return { content, reasoning };
  }

  /* ---------- 对外主入口：带自动重试 ---------- */
  /**
   * @param {object} p
   * @param {string} p.model        模型 id
   * @param {Array}  p.messages     OpenAI 格式消息
   * @param {string} p.mode         none | think | search
   * @param {object} p.settings     全局设置（key/url/timeout/retry/stream）
   * @param {AbortSignal} p.signal  取消信号
   * @param {Function} p.onDelta        (chunk, full) 正文增量
   * @param {Function} p.onReasoning    (chunk, full) 思考增量
   * @param {Function} p.onRetry        (attempt, err) 重试通知
   */
  async function chat(p) {
    const maxRetries = p.settings.maxRetries || 0;
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        if (p.onRetry) p.onRetry(attempt, lastErr);
        await sleep(delay);
      }
      try {
        return await requestOnce(p);
      } catch (e) {
        lastErr = e;
        // 不可重试 / 用户主动中止 / 已有部分输出 → 立即抛出
        if (e.name !== "ApiError") throw e;
        if (e.code === "aborted" || e.code === "no_key" || e.code === "auth" ||
            e.code === "quota" || e.code === "model") throw e;
        if (e.streamStarted || e.partial) throw e;
        if (!e.retryable || attempt === maxRetries) throw e;
      }
    }
    throw lastErr;
  }

  /* ---------- API Key 有效性探测（设置面板用） ---------- */
  async function verifyKey(settings) {
    try {
      const resp = await fetch(settings.baseUrl.replace(/\/+$/, "") + "/models", {
        headers: { "Authorization": "Bearer " + settings.apiKey }
      });
      if (resp.status === 401) throw new ApiError("auth", "API Key 无效");
      if (!resp.ok) throw statusToError(resp.status);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("network", "无法连接到 API 地址");
    }
  }

  return { chat, verifyKey, ApiError };
})();
