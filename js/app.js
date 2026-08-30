/* ═══════════════════════════════════════════════════════
 * app.js · 主逻辑：UI 交互 / 图片处理 / 消息收发
 * ═══════════════════════════════════════════════════════ */
"use strict";

(() => {

  /* ══════════ DOM 引用 ══════════ */
  const $ = id => document.getElementById(id);
  const el = {
    chatArea: $("chatArea"), messages: $("messages"), welcome: $("welcome"),
    modelSelect: $("modelSelect"), modeSwitch: $("modeSwitch"),
    settingsBtn: $("settingsBtn"), clearBtn: $("clearBtn"),
    settingsModal: $("settingsModal"), settingsClose: $("settingsClose"),
    settingsCancel: $("settingsCancel"), settingsSave: $("settingsSave"),
    apiKeyInput: $("apiKeyInput"), baseUrlInput: $("baseUrlInput"),
    timeoutInput: $("timeoutInput"), retryInput: $("retryInput"),
    streamToggle: $("streamToggle"), toggleKeyBtn: $("toggleKeyBtn"),
    msgInput: $("msgInput"), sendBtn: $("sendBtn"),
    uploadBtn: $("uploadBtn"), fileInput: $("fileInput"),
    imagePreview: $("imagePreview"), modelHint: $("modelHint"),
    connStatus: $("connStatus"), toastWrap: $("toastWrap")
  };

  /* ══════════ 全局状态 ══════════ */
  let settings = Storage.getSettings();
  let state = Storage.getState();
  let messages = Storage.getMessages();      // 持久化的消息数组
  let busy = false;                          // 是否正在生成
  let currentCtrl = null;                    // 当前请求 AbortController
  let pendingImages = [];                    // 待发送图片 [{id, dataUrl, name}]
  const renderers = new Map();               // msgId -> {refresh()}
  let loadedImages = null;                   // CatRender.loadAll() 返回结果 {left,right,errors}
  const catBinds = [];                       // 所有绑定实例，便于图片加载完成后统一 setImages

  /** 构建用户 / AI 的头像 DOM（canvas，已绑定 CatRender）*/
  function buildAvatarNode(role) {
    const wrap = document.createElement("div");
    wrap.className = "msg-avatar";
    const canvas = document.createElement("canvas");
    canvas.className = "cat-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", role === "user" ? "用户头像" : "AI 喵娘头像");
    wrap.appendChild(canvas);
    const bind = CatRender.bind(canvas, {
      variant: role === "user" ? "left" : "right",
      images: loadedImages
    });
    catBinds.push(bind);
    return wrap;
  }

  /* ══════════ 工具 ══════════ */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nowTime = () => new Date().toTimeString().slice(0, 5);
  const getModel = id => APP_CONFIG.models.find(m => m.id === id) || APP_CONFIG.models[0];

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /* 基本安全过滤：剔除控制字符，限制长度 */
  function sanitizeInput(text) {
    return String(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .slice(0, 8000);
  }

  /* ══════════ Toast ══════════ */
  function toast(text, type = "info", ms = 3200) {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    const icons = { success: "✓", error: "✕", warn: "⚠", info: "🐱" };
    t.innerHTML = `<span>${icons[type] || "🐱"}</span><span></span>`;
    t.lastElementChild.textContent = text;
    el.toastWrap.appendChild(t);
    setTimeout(() => { t.classList.add("leaving"); setTimeout(() => t.remove(), 260); }, ms);
  }

  /* ══════════ 状态持久化 ══════════ */
  function persistMessages() {
    const r = Storage.saveMessages(messages);
    if (!r.ok) toast("本地存储空间不足，最早的记录未能保存", "warn");
    else if (r.stripped) toast(`存储空间不足，已释放 ${r.stripped} 张历史图片以保存新记录`, "warn");
  }

  /* ══════════ 模型 / 模式 ══════════ */
  function initModelSelect() {
    el.modelSelect.innerHTML = APP_CONFIG.models.map(m =>
      `<option value="${m.id}">${m.name} · ${m.desc}</option>`).join("");
    el.modelSelect.value = getModel(state.model).id;
  }

  function currentModel() { return getModel(el.modelSelect.value); }
  function currentMode() {
    const active = el.modeSwitch.querySelector(".mode-btn.active");
    return active ? active.dataset.mode : "none";
  }

  function applyModeUI() {
    el.modeSwitch.querySelectorAll(".mode-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === state.mode));
    updateHint();
  }

  function updateHint() {
    const m = currentModel();
    const mode = APP_CONFIG.modes[currentMode()];
    el.modelHint.textContent = `${m.id} · ${mode.label}模式`;
    // 视觉模型才能传图
    el.uploadBtn.disabled = !m.vision || busy;
    el.uploadBtn.title = m.vision
      ? `上传图片（最多 ${m.maxImages} 张）`
      : "当前模型不支持图像输入，请切换到 Vision 模型";
  }

  el.modelSelect.addEventListener("change", () => {
    const m = currentModel();
    state.model = m.id;
    Storage.saveState(state);
    if (!m.vision && pendingImages.length) {
      pendingImages = [];
      renderImagePreview();
      toast("已切换到非视觉模型，待发送图片已清空", "warn");
    }
    updateHint();
    toast(`已切换模型：${m.name}`, "info", 2200);
  });

  el.modeSwitch.addEventListener("click", e => {
    const btn = e.target.closest(".mode-btn");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    Storage.saveState(state);
    applyModeUI();
  });

  /* ══════════ 欢迎屏快捷提问 ══════════ */
  el.welcome.addEventListener("click", e => {
    const chip = e.target.closest(".tip-chip");
    if (!chip) return;
    el.msgInput.value = chip.dataset.tip;
    autoResize();
    el.msgInput.focus();
  });

  /* ══════════ 输入框：自动伸缩 + 快捷键 ══════════ */
  function autoResize() {
    const ta = el.msgInput;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 168) + "px";
  }
  el.msgInput.addEventListener("input", autoResize);

  el.msgInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });

  /* ══════════ 图片上传 ══════════ */
  el.uploadBtn.addEventListener("click", () => {
    if (el.uploadBtn.disabled) {
      toast("请先切换到 Vision 视觉模型再上传图片", "warn");
      return;
    }
    el.fileInput.click();
  });

  el.fileInput.addEventListener("change", async () => {
    const files = [...el.fileInput.files];
    el.fileInput.value = "";
    const model = currentModel();
    for (const file of files) {
      if (pendingImages.length >= model.maxImages) {
        toast(`最多上传 ${model.maxImages} 张图片`, "warn"); break;
      }
      await addImage(file);
    }
  });

  /* 拖拽 & 粘贴图片 */
  document.addEventListener("dragover", e => {
    if (currentModel().vision) e.preventDefault();
  });
  document.addEventListener("drop", e => {
    if (!currentModel().vision) return;
    e.preventDefault();
    [...e.dataTransfer.files].filter(f => f.type.startsWith("image/"))
      .slice(0, currentModel().maxImages - pendingImages.length)
      .forEach(f => addImage(f));
  });
  el.msgInput.addEventListener("paste", e => {
    if (!currentModel().vision) return;
    const items = [...(e.clipboardData?.items || [])]
      .filter(i => i.type.startsWith("image/"));
    if (!items.length) return;
    e.preventDefault();
    items.slice(0, currentModel().maxImages - pendingImages.length)
      .forEach(i => addImage(i.getAsFile()));
  });

  /** 压缩图片并加入待发送列表（含进度条与取消） */
  async function addImage(file) {
    const conf = APP_CONFIG.image;
    if (!conf.accept.includes(file.type)) {
      toast(`不支持的图片格式：${file.type || "未知"}（支持 JPG / PNG / WebP / GIF）`, "error");
      return;
    }
    if (file.size > conf.maxRawMB * 1024 * 1024) {
      toast(`图片太大啦（超过 ${conf.maxRawMB}MB），请压缩后再试`, "error");
      return;
    }

    const item = { id: uid(), dataUrl: "", name: file.name, cancelled: false };
    pendingImages.push(item);
    renderImagePreview();

    const card = el.imagePreview.querySelector(`[data-img-id="${item.id}"]`);
    const bar = card.querySelector(".img-progress i");
    // 平滑推进度（本地编码很快，进度主要为视觉反馈）
    let prog = 0;
    const tick = setInterval(() => {
      if (item.cancelled) { clearInterval(tick); return; }
      prog = Math.min(prog + 12, 88);
      bar.style.width = prog + "%";
    }, 60);

    try {
      const dataUrl = await compressImage(file, p => { bar.style.width = (88 + p * 12) + "%"; });
      if (item.cancelled) return;   // 用户已在上传中取消
      item.dataUrl = dataUrl;
      const imgEl = card.querySelector("img");
      if (imgEl) { imgEl.src = dataUrl; imgEl.style.opacity = ""; }
      card.classList.remove("loading");
      card.classList.add("done");
      setTimeout(() => bar.style.width = "100%", 50);
    } catch (err) {
      removeImage(item.id);
      toast("图片处理失败：" + err.message, "error");
    } finally {
      clearInterval(tick);
    }
  }

  /** Canvas 压缩：最长边 maxDim，JPEG quality；透明 PNG 保留 PNG */
  function compressImage(file, onProgress) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片无法解码")); };
      img.onload = () => {
        try {
          const { maxDim, quality } = APP_CONFIG.image;
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          const isTransparentPng = file.type === "image/png";
          if (!isTransparentPng) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); }
          ctx.drawImage(img, 0, 0, w, h);
          onProgress?.(0.5);
          const mime = isTransparentPng ? "image/png" : "image/jpeg";
          const dataUrl = canvas.toDataURL(mime, quality);
          onProgress?.(1);
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.src = url;
    });
  }

  function removeImage(id) {
    const item = pendingImages.find(i => i.id === id);
    if (item) item.cancelled = true;
    pendingImages = pendingImages.filter(i => i.id !== id);
    renderImagePreview();
  }

  function renderImagePreview() {
    el.imagePreview.hidden = pendingImages.length === 0;
    el.imagePreview.innerHTML = pendingImages.map(p => `
      <div class="img-card loading" data-img-id="${p.id}">
        <img src="${p.dataUrl || ""}" alt="${Markdown.escapeHtml(p.name)}" ${p.dataUrl ? "" : 'style="opacity:.35"'}>
        <button class="img-cancel" data-img-id="${p.id}" title="移除图片">✕</button>
        <div class="img-progress"><i></i></div>
      </div>`).join("");
  }

  el.imagePreview.addEventListener("click", e => {
    const btn = e.target.closest(".img-cancel");
    if (btn) removeImage(btn.dataset.imgId);
  });

  /* ══════════ 消息渲染 ══════════ */
  function msgModelTag(m) {
    return m.model ? `<span class="meta-tag model">${Markdown.escapeHtml(getModel(m.model).name)}</span>` : "";
  }
  function msgModeTag(m) {
    if (m.mode === "think") return `<span class="meta-tag mode-think">💭 ${APP_CONFIG.modes.think.tag}</span>`;
    if (m.mode === "search") return `<span class="meta-tag mode-search">🌐 ${APP_CONFIG.modes.search.tag}</span>`;
    return "";
  }

  /** 创建 DOM 消息节点（含流式刷新器） */
  function buildMessageNode(m) {
    const div = document.createElement("div");
    div.className = `msg ${m.role === "user" ? "user" : "ai"}${m.error ? " error" : ""}${m.pending ? " pending" : ""}`;
    div.dataset.id = m.id;

    /* 头像 canvas（用户=左图/我、AI=右图/喵娘），若构建失败则降级为文字 */
    let avatarNode;
    try { avatarNode = buildAvatarNode(m.role); }
    catch { avatarNode = document.createElement("div"); avatarNode.className = "msg-avatar"; avatarNode.textContent = m.role === "user" ? "我" : "喵"; }

    div.appendChild(avatarNode);

    /* msg-body 容器 */
    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = `
        <div class="msg-meta">
          ${msgModelTag(m)}${msgModeTag(m)}
          <span class="meta-tag time">${m.time || ""}</span>
        </div>
        <div class="bubble"></div>
        <div class="msg-images"></div>
        <div class="actions"></div>`;
    div.appendChild(body);

    const bubble = body.querySelector(".bubble");
    const imagesBox = body.querySelector(".msg-images");
    const actions = body.querySelector(".actions");

    const renderer = {
      refresh() {
        /* 状态类名随消息生命周期同步（pending → done / error） */
        div.className = `msg ${m.role === "user" ? "user" : "ai"}${m.error ? " error" : ""}${m.pending ? " pending" : ""}`;
        /* 错误消息 */
        if (m.error) {
          bubble.innerHTML = `<strong>😿 ${Markdown.escapeHtml(m.error.title || "出错了")}</strong><br>${Markdown.escapeHtml(m.error.message || "")}`;
          renderActions();
          return;
        }
        /* 思考过程 */
        let thinkBox = bubble.querySelector(".think-box");
        if (m.reasoning) {
          if (!thinkBox) {
            thinkBox = document.createElement("div");
            thinkBox.className = "think-box";
            thinkBox.innerHTML = `
              <button class="think-head">
                <span>💭 思考过程</span><span class="dot" ${m.done ? 'style="animation:none"' : ""}></span>
                <svg class="arrow" width="12" height="12" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div class="think-body"></div>`;
            thinkBox.querySelector(".think-head").addEventListener("click", () => {
              thinkBox.classList.toggle("open");
            });
            bubble.appendChild(thinkBox);
          }
          const body = thinkBox.querySelector(".think-body");
          body.textContent = m.reasoning;
          if (m.pending && !thinkBox.classList.contains("open")) thinkBox.classList.add("open");
          if (m.done) {
            const dot = thinkBox.querySelector(".dot");
            if (dot) dot.style.animation = "none";
          }
        }

        /* 正文 */
        let contentEl = bubble.querySelector(".content");
        if (!contentEl) {
          contentEl = document.createElement("div");
          contentEl.className = "content";
          bubble.appendChild(contentEl);
        }
        if (m.role === "user") {
          contentEl.textContent = m.content || "";
        } else if (m.content) {
          contentEl.innerHTML = Markdown.render(m.content);
        } else if (m.pending) {
          contentEl.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>`;
        }

        /* 流式光标 */
        if (m.pending && m.content) {
          if (!contentEl.querySelector(".typing-cursor")) {
            const cur = document.createElement("span");
            cur.className = "typing-cursor";
            contentEl.appendChild(cur);
          }
        } else {
          contentEl.querySelector(".typing-cursor")?.remove();
          if (m.pending && m.reasoning && !m.content) {
            // 仍在思考阶段
          }
        }

        /* 用户附图 */
        if (m.role === "user" && m.images && m.images.length) {
          imagesBox.innerHTML = m.images.map(src => `<img src="${src}" alt="用户图片">`).join("");
        } else if (m.imagesStripped) {
          imagesBox.innerHTML = `<span class="meta-tag">🖼 图片未保存（存储空间不足）</span>`;
        }

        renderActions();
      },
      node: div
    };

    function renderActions() {
      actions.innerHTML = "";
      /* 错误消息 → 重试按钮 */
      if (m.error && m.retryPayload) {
        const btn = document.createElement("button");
        btn.className = "retry-btn";
        btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 2.6-6.3M3 4v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> 重新发送`;
        btn.addEventListener("click", () => retryMessage(m));
        actions.appendChild(btn);
      }
      /* 完成的 AI 消息 → 复制按钮 */
      if (m.role === "assistant" && m.done && m.content) {
        const btn = document.createElement("button");
        btn.className = "retry-btn";
        btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> 复制`;
        btn.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(m.content); toast("已复制到剪贴板", "success", 1800); }
          catch { toast("复制失败", "error"); }
        });
        actions.appendChild(btn);
      }
    }

    renderer.refresh();
    renderers.set(m.id, renderer);
    return div;
  }

  /* 图片灯箱 */
  el.messages.addEventListener("click", e => {
    const img = e.target.closest(".msg-images img");
    if (!img) return;
    const lb = document.createElement("div");
    lb.className = "lightbox";
    lb.appendChild(img.cloneNode());
    lb.addEventListener("click", () => lb.remove());
    document.body.appendChild(lb);
  });

  /* 代码复制 */
  el.messages.addEventListener("click", e => {
    const btn = e.target.closest(".code-copy");
    if (!btn) return;
    navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code))
      .then(() => { btn.textContent = "已复制 ✓"; setTimeout(() => btn.textContent = "复制", 1500); })
      .catch(() => toast("复制失败", "error"));
  });

  function appendMessage(m) {
    messages.push(m);
    const node = buildMessageNode(m);
    // 欢迎屏：第一条消息出现时隐藏
    if (el.welcome && messages.filter(x => !x.error || true).length > 0) el.welcome.style.display = "none";
    el.messages.appendChild(node);
    scrollToBottom(true);
    return m;
  }

  function scrollToBottom(force = false) {
    const nearBottom = el.chatArea.scrollHeight - el.chatArea.scrollTop - el.chatArea.clientHeight < 160;
    if (force || nearBottom) el.chatArea.scrollTop = el.chatArea.scrollHeight;
  }

  /** 从持久化数据恢复整屏消息 */
  function restoreMessages() {
    if (!messages.length) return;
    el.welcome.style.display = "none";
    messages.forEach(m => el.messages.appendChild(buildMessageNode(m)));
    requestAnimationFrame(() => el.chatArea.scrollTo(0, el.chatArea.scrollHeight));
  }

  /* ══════════ 构建 API 消息序列 ══════════ */
  function buildApiMessages() {
    const limit = settings.historyLimit;
    const recent = messages
      .filter(m => !m.error && (m.content || (m.images && m.images.length)) && !m.aborted)
      .slice(-limit)
      .map(m => {
        if (m.role === "user" && m.images && m.images.length && currentModel().vision) {
          const content = [];
          if (m.content) content.push({ type: "text", text: m.content });
          m.images.forEach(url => content.push({ type: "image_url", image_url: { url } }));
          return { role: "user", content };
        }
        return { role: m.role, content: m.content };
      });
    return recent;
  }

  /* ══════════ 发送 ══════════ */
  async function handleSend() {
    if (busy) return;
    const raw = sanitizeInput(el.msgInput.value.trim());
    const images = pendingImages.filter(i => i.dataUrl).map(i => i.dataUrl);

    if (!raw && !images.length) return;
    if (images.length && !currentModel().vision) {
      toast("当前模型不支持图片，请切换到 Vision 模型", "warn");
      return;
    }
    if (!settings.apiKey) {
      toast("请先在设置中填写 API Key", "warn");
      openSettings();
      return;
    }

    const userMsg = appendMessage({
      id: uid(), role: "user", content: raw,
      images, time: nowTime(), ts: Date.now()
    });

    el.msgInput.value = "";
    autoResize();
    pendingImages = [];
    renderImagePreview();

    await generate(userMsg);
  }

  /** 请求生成（含流式 UI 更新） */
  async function generate(userMsg) {
    const model = currentModel();
    const mode = currentMode();

    const aiMsg = appendMessage({
      id: uid(), role: "assistant", content: "", reasoning: "",
      model: model.id, mode, time: nowTime(), ts: Date.now(),
      pending: true
    });
    const renderer = renderers.get(aiMsg.id);

    setBusy(true, "思考中…");
    currentCtrl = new AbortController();

    let rafPending = false;
    const scheduleRefresh = () => {     // 合并帧级重绘，流式不卡顿
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; renderer.refresh(); scrollToBottom(); });
    };

    try {
      const result = await DeepSeekAPI.chat({
        model: model.id,
        messages: buildApiMessages(),
        mode,
        settings,
        signal: currentCtrl.signal,
        onDelta: (chunk) => { aiMsg.content += chunk; setBusy(true, "正在回复…"); scheduleRefresh(); },
        onReasoning: (chunk) => { aiMsg.reasoning += chunk; setBusy(true, "深度思考中…"); scheduleRefresh(); },
        onRetry: (attempt, err) => toast(`第 ${attempt} 次重试：${err.message}`, "warn", 2400)
      });

      aiMsg.content = result.content || aiMsg.content;
      aiMsg.reasoning = result.reasoning || aiMsg.reasoning;
      aiMsg.done = true;
      aiMsg.pending = false;
      if (!aiMsg.content) aiMsg.content = "（模型未返回内容，可尝试重试或更换模式）";
      renderer.refresh();
      persistMessages();
      setBusy(false, "就绪");

    } catch (e) {
      aiMsg.pending = false;
      setBusy(false, e.retryable ? "出错" : "就绪");

      if (e.code === "aborted") {
        /* 用户主动停止：保留已生成部分 */
        if (e.partial && (e.partial.content || e.partial.reasoning)) {
          aiMsg.content = e.partial.content;
          aiMsg.reasoning = e.partial.reasoning;
          aiMsg.done = true;
          aiMsg.aborted = true;
          renderer.refresh();
          persistMessages();
        } else {
          aiMsg.error = { title: "已停止", message: "你手动停止了本次生成" };
          aiMsg.done = true;
          renderer.refresh();
          persistMessages();
        }
        return;
      }

      aiMsg.error = { title: friendlyTitle(e.code), message: e.message };
      aiMsg.done = true;
      /* 附上重试所需上下文：以该 AI 消息前的一条用户消息为准 */
      aiMsg.retryPayload = { userIdx: messages.findIndex(m => m.id === (userMsg && userMsg.id)) };
      renderer.refresh();
      persistMessages();
      setBusy(false, "出错");
      el.connStatus.classList.add("error");
      setTimeout(() => el.connStatus.classList.remove("error"), 2500);
    } finally {
      currentCtrl = null;
      scheduleRefresh();
    }
  }

  function friendlyTitle(code) {
    return {
      no_key: "缺少 API Key",
      auth: "认证失败",
      quota: "余额不足",
      model: "模型不可用",
      rate_limit: "请求太频繁",
      server: "服务器错误",
      network: "网络异常",
      timeout: "请求超时",
      parse: "响应解析失败"
    }[code] || "请求失败";
  }

  /** 失败重试：移除错误气泡，以原用户消息重新生成 */
  function retryMessage(errMsg) {
    if (busy) { toast("请等待当前回复完成", "warn"); return; }
    const idx = messages.findIndex(m => m.id === errMsg.id);
    if (idx < 1) return;
    // 向前找最近的用户消息
    let userIdx = idx - 1;
    while (userIdx >= 0 && messages[userIdx].role !== "user") userIdx--;
    if (userIdx < 0) return;

    const userMsg = messages[userIdx];
    // 删除错误消息节点
    messages.splice(idx, 1);
    renderers.delete(errMsg.id);
    errMsg.retryPayload._node?.remove();
    const node = el.messages.querySelector(`[data-id="${errMsg.id}"]`);
    if (node) node.remove();
    persistMessages();
    generate(userMsg);
  }

  function setBusy(b, statusText) {
    busy = b;
    el.sendBtn.classList.toggle("stopping", b);
    el.sendBtn.title = b ? "停止生成" : "发送";
    el.sendBtn.setAttribute("aria-label", b ? "停止生成" : "发送消息");
    el.connStatus.textContent = statusText || (b ? "生成中" : "就绪");
    el.connStatus.classList.toggle("busy", b);
    updateHint();
  }

  /* 点击发送/停止按钮 */
  el.sendBtn.addEventListener("click", () => {
    if (busy) { currentCtrl?.abort(); return; }
    handleSend();
  });

  /* ══════════ 清空记录 ══════════ */
  el.clearBtn.addEventListener("click", () => {
    if (!messages.length) { toast("聊天记录已经是空的啦", "info", 1800); return; }
    if (!confirm("确定要清空全部聊天记录吗？此操作不可恢复喵！")) return;
    messages = [];
    renderers.clear();
    Storage.clearMessages();
    el.messages.querySelectorAll(".msg").forEach(n => n.remove());
    el.welcome.style.display = "";
    toast("聊天记录已清空", "success");
  });

  /* ══════════ 设置面板 ══════════ */
  function openSettings() {
    el.apiKeyInput.value = settings.apiKey;
    el.baseUrlInput.value = settings.baseUrl;
    el.timeoutInput.value = settings.timeoutSec;
    el.retryInput.value = settings.maxRetries;
    el.streamToggle.checked = settings.stream;
    el.settingsModal.hidden = false;
    setTimeout(() => el.apiKeyInput.focus(), 60);
  }
  function closeSettings() { el.settingsModal.hidden = true; }

  el.settingsBtn.addEventListener("click", openSettings);
  el.settingsClose.addEventListener("click", closeSettings);
  el.settingsCancel.addEventListener("click", closeSettings);
  el.settingsModal.addEventListener("click", e => { if (e.target === el.settingsModal) closeSettings(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !el.settingsModal.hidden) closeSettings(); });

  el.toggleKeyBtn.addEventListener("click", () => {
    el.apiKeyInput.type = el.apiKeyInput.type === "password" ? "text" : "password";
  });

  el.settingsSave.addEventListener("click", async () => {
    const key = el.apiKeyInput.value.trim();
    const base = el.baseUrlInput.value.trim().replace(/\/+$/, "");

    if (key && !/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) {
      toast("API Key 格式看起来不对（通常以 sk- 开头），请检查", "warn");
      return;
    }
    if (!/^https?:\/\/.+/.test(base)) {
      toast("API 地址需以 http(s):// 开头", "warn");
      return;
    }

    settings.apiKey = key;
    settings.baseUrl = base || APP_CONFIG.defaults.baseUrl;
    settings.timeoutSec = clamp(+el.timeoutInput.value || 60, 10, 300);
    settings.maxRetries = clamp(+el.retryInput.value || 0, 0, 5);
    settings.stream = el.streamToggle.checked;
    Storage.saveSettings(settings);

    closeSettings();
    toast("设置已保存 ✓", "success");

    /* 后台校验 Key（不阻塞） */
    if (key) {
      try {
        await DeepSeekAPI.verifyKey(settings);
        toast("API Key 验证通过", "success");
      } catch (e) {
        toast("Key 校验未通过：" + e.message, "warn", 4200);
      }
    }
  });

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ══════════ 启动 ══════════ */
  /** 加载头像图片并绑定所有固定 canvas 节点（顶栏 / 欢迎屏）+ 更新 favicon */
  async function initCanvasAvatar() {
    /* 先创建占位 canvas 绑定（即使尚未加载也能先画渐变占位） */
    const brandEl = document.getElementById("brandCanvas");
    const welcomeEl = document.getElementById("welcomeCanvas");
    if (brandEl) catBinds.push(CatRender.bind(brandEl, { variant: "right", size: 44, interactive: true }));
    if (welcomeEl) catBinds.push(CatRender.bind(welcomeEl, { variant: "right", size: 110, interactive: true }));

    try {
      loadedImages = await CatRender.loadAll();
      console.debug("[initCanvasAvatar] loadedImages=", {
        hasLeft: !!loadedImages.left,
        hasRight: !!loadedImages.right,
        leftSize: loadedImages.left ? loadedImages.left.naturalWidth + "x" + loadedImages.left.naturalHeight : null,
        rightSize: loadedImages.right ? loadedImages.right.naturalWidth + "x" + loadedImages.right.naturalHeight : null,
        errors: loadedImages.errors
      });
      /* 如果加载失败，用渐进式 toast 提示（不影响其它功能） */
      const errs = [];
      if (!loadedImages.left) errs.push("左侧头像");
      if (!loadedImages.right) errs.push("右侧头像");
      if (errs.length) {
        toast(`图片加载失败：${errs.join("、")}，改用占位图显示`, "warn", 4500);
      }
      /* 通知所有已绑定 canvas 刷新（含消息头像） */
      catBinds.forEach(b => b.setImages(loadedImages));
    } catch (e) {
      console.error("[initCanvasAvatar] catch:", e);
      toast("图片初始化异常：" + e.message, "error");
    }

    /* 用 Canvas 动态生成 favicon（图片没加载则用占位也可） */
    try {
      const favUrl = await CatRender.toDataURLVariant("right", 32);
      /* 按 id 精准移除旧 favicon，再插入新 link */
      const old = document.getElementById("faviconLink");
      if (old) old.remove();
      const link = document.createElement("link");
      link.id = "faviconLink";
      link.rel = "icon";
      link.type = "image/png";
      link.href = favUrl;
      document.head.appendChild(link);
    } catch (e) {
      console.warn("[favicon] 生成失败", e);
    }
  }

  function init() {
    initModelSelect();
    state.mode = ["none", "think", "search"].includes(state.mode) ? state.mode : "none";
    applyModeUI();
    restoreMessages();
    autoResize();
    /* 异步加载头像资源，不阻塞交互 */
    initCanvasAvatar();
    if (!settings.apiKey) {
      setTimeout(() => { toast("首次使用请先配置 API Key（右上角 ⚙️）", "info", 5000); openSettings(); }, 500);
    }
    console.log("%c🐱 DeepSeek 喵聊天已启动（Canvas 渲染模式）", "color:#8b5cf6;font-weight:bold");
  }

  init();
})();
