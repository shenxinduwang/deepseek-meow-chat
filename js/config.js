/* ═══════════════════════════════════════════════════════
 * config.js · 模型 / 模式 / 默认配置
 * 若 API 参数与官方文档有出入，只需修改本文件即可。
 * ═══════════════════════════════════════════════════════ */
"use strict";

const APP_CONFIG = {

  /* ── 模型清单 ── */
  models: [
    {
      id: "deepseek-v4-flash",
      name: "Flash · 快速",
      desc: "极速响应，适合日常问答",
      vision: false,          // 是否支持图像输入
      maxImages: 0
    },
    {
      id: "deepseek-v4-pro",
      name: "Pro · 强大",
      desc: "深度推理，适合复杂任务",
      vision: false,
      maxImages: 0
    },
    {
      id: "deepseek-v4-flash-vision-exp",
      name: "Vision · 视觉（实验）",
      desc: "支持图片理解（JPG / PNG / WebP / GIF）",
      vision: true,
      maxImages: 4
    }
  ],

  /* ── 响应模式 ──
   * none    : 直接回答
   * think   : 带思考（展示 reasoning_content）
   * search  : 联网搜索
   */
  modes: {
    none:   { label: "直答", tag: "" },
    think:  { label: "思考", tag: "深度思考" },
    search: { label: "联网", tag: "联网搜索" }
  },

  /* ── API 请求体附加参数（按模式注入，可依据官方文档调整） ── */
  modeParams: {
    think:  { enable_thinking: true },
    search: { enable_search: true }
  },

  /* ── 默认设置（用户可在设置面板覆盖并持久化到 localStorage） ── */
  defaults: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    timeoutSec: 60,      // 单次请求无数据超时（秒）
    maxRetries: 2,       // 可重试错误的最大自动重试次数
    stream: true,        // 流式输出
    model: "deepseek-v4-flash",
    mode: "none",
    temperature: 0.7,
    maxTokens: 4096,
    historyLimit: 50     // 随请求携带的最大历史轮数
  },

  /* ── 图片上传限制 ── */
  image: {
    maxRawMB: 10,        // 原始文件大小上限
    maxDim: 1280,        // 压缩后最长边
    quality: 0.85,       // JPEG 压缩质量
    accept: ["image/jpeg", "image/png", "image/webp", "image/gif"]
  },

  /* ── 常量 ── */
  storageKeys: {
    messages: "dschat.messages",
    settings: "dschat.settings",
    state:    "dschat.state"
  }
};

/* 冻结配置，防止运行时被意外篡改 */
Object.freeze(APP_CONFIG);
Object.freeze(APP_CONFIG.models);
Object.freeze(APP_CONFIG.defaults);
