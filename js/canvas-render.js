/* ═══════════════════════════════════════════════════════
 * canvas-render.js · HTML5 Canvas 图像渲染引擎
 *  - 加载 img/whale_maid_redraw_wink_left.jpg  (用户头像)
 *  - 加载 img/whale_maid_redraw_wink_right.jpg (AI/品牌/欢迎屏)
 *  - 圆形裁剪 + 外发光 + 平滑抗锯齿 + DPR 高清适配
 *  - 加载失败时渐变占位 + 错误标识
 *  - 节流式 rAF 重绘（避免连续 resize 产生冗余绘制）
 *  - 悬停浮起 + 点击涟漪反馈
 * ═══════════════════════════════════════════════════════ */
"use strict";

const CatRender = (() => {

  const ASSETS = {
    left:  "img/whale_maid_redraw_wink_left.jpg",   // 用户侧（左侧/我方）
    right: "img/whale_maid_redraw_wink_right.jpg"   // AI/品牌侧（右侧/喵娘）
  };

  /* ---------- 图像缓存：key -> HTMLImageElement (共享解码结果) ---------- */
  const imgCache = new Map();
  const imgPromises = new Map();

  function loadImage(key, src) {
    if (imgCache.has(key)) {
      console.debug("[CatRender.loadImage] cache hit", key);
      return Promise.resolve({ ok: true, img: imgCache.get(key) });
    }
    if (imgPromises.has(key)) {
      console.debug("[CatRender.loadImage] promise dedup", key);
      return imgPromises.get(key);
    }
    console.debug("[CatRender.loadImage] start", key, "->", src);
    const p = new Promise(resolve => {
      const img = new Image();
      /* 移除 decoding="async"：和 decode() 组合有时触发浏览器 bug */
      try {
        const url = new URL(src, location.href);
        if (url.origin !== location.origin) img.crossOrigin = "anonymous";
      } catch {}
      const timeoutMs = 15000;
      let done = false;
      const finish = (result) => { if (done) return; done = true; clearTimeout(timeout); imgPromises.delete(key); resolve(result); };
      const timeout = setTimeout(() => {
        console.warn("[CatRender.loadImage] TIMEOUT", key, src);
        finish({ ok: false, img: null, reason: `加载超时：${src}` });
      }, timeoutMs);
      img.onload = () => {
        console.debug("[CatRender.loadImage] onload", key, img.naturalWidth + "x" + img.naturalHeight);
        if (typeof img.decode === "function") {
          /* decode() 最多 2 秒，不卡主线程；超时直接用 img 对象 */
          const decT = setTimeout(() => finish({ ok: true, img: img, _decoded: false }), 2000);
          img.decode().then(
            () => { clearTimeout(decT); imgCache.set(key, img); finish({ ok: true, img, _decoded: true }); },
            () => { clearTimeout(decT); imgCache.set(key, img); finish({ ok: true, img, _decoded: false }); }
          );
        } else {
          imgCache.set(key, img);
          finish({ ok: true, img });
        }
      };
      img.onerror = (ev) => {
        console.warn("[CatRender.loadImage] onerror", key, src, ev);
        finish({ ok: false, img: null, reason: `加载失败：${src}` });
      };
      try {
        img.src = src + (src.includes("?") ? "&" : "?") + "_cv=" + Date.now();
        console.debug("[CatRender.loadImage] src assigned ->", img.src);
        /* 若图片已在浏览器缓存，onload 可能同步触发；确保此处仍可完成 */
        if (img.complete && img.naturalWidth > 0 && !done) {
          console.debug("[CatRender.loadImage] complete (cached)", key);
          imgCache.set(key, img);
          finish({ ok: true, img, _sync: true });
        }
      } catch (e) {
        console.warn("[CatRender.loadImage] assign src failed", key, e);
        finish({ ok: false, img: null, reason: "src 赋值失败：" + e.message });
      }
    });
    imgPromises.set(key, p);
    return p;
  }

  /* 并行加载两张图片，返回 {left, right} */
  function loadAll() {
    return Promise.all([
      loadImage("left",  ASSETS.left),
      loadImage("right", ASSETS.right)
    ]).then(([L, R]) => ({
      left:  L.img,
      right: R.img,
      errors: { left: !L.ok, right: !R.ok }
    }));
  }

  /* ---------- 圆形裁剪绘制（含外发光/抗锯齿/DPR高清） ---------- */

  /* 大比例缩小时逐级减半预采样，避免一次 drawImage 从数千像素直接压到几十像素产生的糊化 */
  const prescaleCache = new Map();

  function prescaledSource(srcImg, maxDim) {
    if (!srcImg) return srcImg;
    const natW = srcImg.naturalWidth || srcImg.width || 0;
    const natH = srcImg.naturalHeight || srcImg.height || 0;
    if (!natW || !natH || natW <= maxDim) return srcImg;

    const key = (srcImg.src || "") + "@" + maxDim;
    const hit = prescaleCache.get(key);
    if (hit) return hit;

    let w = natW, h = natH, out = srcImg;
    while (w > maxDim * 2) {
      const nw = Math.max(maxDim, Math.floor(w / 2));
      const nh = Math.max(1, Math.round(h * (nw / w)));
      const c = document.createElement("canvas");
      c.width = nw; c.height = nh;
      const cx = c.getContext("2d");
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "high";
      cx.drawImage(out, 0, 0, nw, nh);
      out = c; w = nw; h = nh;
    }
    prescaleCache.set(key, out);
    return out;
  }

  function drawRoundedImage(ctx, img, opts) {
    const { x, y, size, glowColor, glowBlur = 0, err = false } = opts;
    const dpr = window.devicePixelRatio || 1;
    const cx = x + size / 2, cy = y + size / 2;
    const r = size / 2;

    /* 外发光（阴影）*/
    if (glowBlur > 0) {
      ctx.save();
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = glowBlur * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    /* 圆形裁剪 */
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.5 * dpr, 0, Math.PI * 2);
    ctx.clip();

    if (img && !err) {
      /* 先做逐级预采样，再按 contain 比例居中绘制，保持原图比例不裁切 */
      const src = prescaledSource(img, Math.ceil(size * 2));
      const ratio = Math.min(size / src.width, size / src.height);
      const w = src.width * ratio;
      const h = src.height * ratio;
      const sx = cx - w / 2;
      const sy = cy - h / 2;
      /* 抗锯齿平滑 */
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, sx, sy, w, h);
    } else {
      /* 失败占位：渐变 + 图标 */
      const grd = ctx.createRadialGradient(cx, cy - r * .2, r * .1, cx, cy, r);
      grd.addColorStop(0, "#ddd6fe");
      grd.addColorStop(1, "#fbcfe8");
      ctx.fillStyle = grd;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = "#7c3aed";
      ctx.font = `bold ${Math.floor(size * 0.42)}px "PingFang SC", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(err ? "!" : "喵", cx, cy);
    }
    ctx.restore();

    /* 描边 */
    ctx.save();
    ctx.strokeStyle = opts.strokeColor || "#c4b5fd";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- 节流重绘（rAF 合并） ---------- */
  const pending = new Map();     // canvas -> {opts}
  let rafId = 0;

  function queuePaint(canvas, opts) {
    pending.set(canvas, opts);
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        pending.forEach((opt, c) => paint(c, opt));
        pending.clear();
      });
    }
  }

  /* 立即绘制（非节流，用于首帧） */
  function paint(canvas, opts) {
    const { img, variant = "right", err = false, hover = false, ripple = 0, glow = 8 } = opts;
    /* 布局尺寸优先于传入值：以真实显示 CSS 尺寸出图，避免位图与显示框不一致导致拉伸模糊 */
    const cssSize = Math.round(canvas.clientWidth)
      || (typeof opts.size === "function" ? opts.size() : opts.size)
      || Number(canvas.getAttribute("data-size"))
      || 44;
    const dpr = window.devicePixelRatio || 1;
    const size = cssSize * dpr;

    /* 画布尺寸未变则跳过，避免冗余分配（性能关键） */
    if (canvas.width === size && canvas.height === size && opts.__reuse) {
      // 尺寸未变，也仍需重绘（hover/ripple 会变化），不跳
    }
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);

    /* 悬停放大效果：通过 translate + 微缩视觉容器 */
    const pad = hover ? -1 : 0;
    const drawSize = size + pad * 2;

    drawRoundedImage(ctx, img, {
      x: pad, y: pad, size: drawSize,
      glowColor: variant === "left" ? "rgba(139,92,246,.55)" : "rgba(236,72,153,.55)",
      glowBlur: glow * dpr,
      strokeColor: variant === "left" ? "#c4b5fd" : "#f9a8d4",
      err
    });

    /* 点击涟漪 */
    if (ripple > 0 && ripple < 1) {
      ctx.save();
      const cx = size / 2, cy = size / 2;
      const rMax = size / 2;
      ctx.strokeStyle = variant === "left"
        ? `rgba(139,92,246,${0.4 * (1 - ripple)})`
        : `rgba(236,72,153,${0.4 * (1 - ripple)})`;
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, rMax * ripple, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------- 对外：绑定一个 canvas 到指定 variant ---------- */
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {"left"|"right"} opts.variant   左=用户头像；右=AI/品牌
   * @param {number}       [opts.size]      CSS 尺寸（像素，不传则读取 clientWidth）
   * @param {object}       [opts.images]    loadAll() 返回的图像对象
   * @param {boolean}      [opts.interactive=true]  是否加悬停/点击反馈
   */
  function bind(canvas, opts) {
    const variant = opts.variant || "right";
    canvas.setAttribute("data-variant", variant);
    /* 只有“撑满父容器”模式（无固定尺寸，如 msg-avatar 38x38）才写内联 100%；
       固定尺寸画布（顶栏/欢迎屏）必须交给样式表控制大小，
       否则内联 100% 会把画布拉伸到父容器宽度，44px 位图被放大后必然模糊 */
    if (!opts.size) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      /* 撑满模式下才需要块级；固定尺寸画布保持默认内联，
         让欢迎屏这类靠 text-align 居中的场景仍能居中 */
      canvas.style.display = "block";
    }

    let state = {
      variant,
      size: opts.size || 0,
      img: null,
      err: false,
      hover: false,
      ripple: 0
    };

    let rippleTimer = 0;
    const interactive = opts.interactive !== false;

    function render() {
      queuePaint(canvas, state);
    }

    function setImages(images) {
      if (!images) return;
      state.img = images[variant];
      state.err = (images.errors || {})[variant] === true;
      render();
    }

    function resize() {
      /* 以真实布局尺寸为准（样式表/媒体查询变化也能自动跟进） */
      const css = Math.round(canvas.clientWidth)
        || (typeof opts.size === "function" ? opts.size() : opts.size)
        || (opts.size ? 0 : (canvas.parentElement ? canvas.parentElement.clientWidth : 0));
      if (css && css !== state.size) {
        state.size = css;
        render();
      }
    }

    /* 初始化尺寸 */
    resize();

    /* 绑定资源加载回调（若已加载则立即绘制） */
    if (opts.images) setImages(opts.images);
    else state.__pending = true;

    /* 布局变化（挂载到 DOM、媒体查询切换尺寸、父容器伸缩）时按需重绘 */
    if (typeof ResizeObserver === "function") {
      try { new ResizeObserver(resize).observe(canvas); } catch {}
    }

    /* 响应式：全局 resize 监听（由 ResizeObserver 在模块外统一调度更优；这里监听 window 即可） */
    if (!bind._wired) {
      window.addEventListener("resize", () => {
        document.querySelectorAll("canvas[data-variant]").forEach(c => {
          const st = c.__catState; if (st) st.resize();
        });
      });
      bind._wired = true;
    }

    /* 交互效果 */
    if (interactive) {
      canvas.addEventListener("mouseenter", () => { state.hover = true; render(); });
      canvas.addEventListener("mouseleave", () => { state.hover = false; render(); });
      canvas.addEventListener("click", () => {
        if (rippleTimer) return;
        const start = performance.now();
        const dur = 420;
        const tick = (now) => {
          const t = Math.min(1, (now - start) / dur);
          state.ripple = t;
          render();
          if (t < 1) rippleTimer = requestAnimationFrame(tick);
          else { state.ripple = 0; rippleTimer = 0; render(); }
        };
        rippleTimer = requestAnimationFrame(tick);
      });
    }

    state.resize = resize;
    canvas.__catState = state;

    /* 暴露外部句柄 */
    return {
      setImages,
      resize,
      render,
      /** 主动标记错误（用于强制占位） */
      markError(e) { state.err = !!e; render(); },
      /** 导出 dataURL（用于 favicon / 用户上传等场景） */
      toDataURL(type = "image/png") { return canvas.toDataURL(type); },
      /** 拿到底层 state 便于调试 */
      _state: state
    };
  }

  /* 用独立带 crossOrigin 的 Image 加载，避免复用已 tainted 的缓存 img */
  async function _loadCORSImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timeout = setTimeout(() => resolve(null), 10000);
      img.onload = () => { clearTimeout(timeout); resolve(img); };
      img.onerror = () => { clearTimeout(timeout); resolve(null); };
      img.src = src + (src.includes("?") ? "&" : "?") + "_cv=" + Date.now();
    });
  }

  /* 生成一次性离屏 canvas（用于 favicon / 临时缩略图），返回 Promise<dataURL> */
  async function toDataURLVariant(variant, sizePx = 64) {
    const c = document.createElement("canvas");
    c.width = c.height = sizePx * (window.devicePixelRatio || 1);
    let img = null, err = true;
    /* 先尝试 CORS 版加载（canvas 能 toDataURL） */
    try {
      img = await _loadCORSImage(ASSETS[variant]);
      err = !img;
    } catch { img = null; err = true; }
    /* 若 CORS 失败，退化为不带 CORS 的加载（最终 dataURL 用 fallback SVG 占位） */
    if (err) {
      try {
        paint(c, { img: null, variant, err: false, size: sizePx, glow: 6 });
        return c.toDataURL("image/png");
      } catch {
        /* 最终安全回退：内联 PNG 小紫猫占位图（32x32） */
        return "data:image/svg+xml;utf8," + encodeURIComponent(
          `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
          `<circle cx='16' cy='16' r='15' fill='%23a855f7'/>` +
          `<circle cx='11' cy='14' r='2.2' fill='white'/><circle cx='21' cy='14' r='2.2' fill='white'/>` +
          `<circle cx='7' cy='20' r='2.5' fill='%23ec4899' opacity='.6'/><circle cx='25' cy='20' r='2.5' fill='%23ec4899' opacity='.6'/>` +
          `<path d='M11 21 Q16 25 21 21' stroke='white' stroke-width='2' fill='none' stroke-linecap='round'/>` +
          `</svg>`);
      }
    }
    try {
      paint(c, { img, variant, err: false, size: sizePx, glow: 6 });
      return c.toDataURL("image/png");
    } catch {
      return c.toDataURL("image/png");
    }
  }

  return { loadAll, bind, toDataURLVariant, ASSETS };
})();

/* 暴露到全局，以便外部调用 / 调试 */
window.CatRender = CatRender;
