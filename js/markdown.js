/* ═══════════════════════════════════════════════════════
 * markdown.js · 轻量安全的 Markdown 渲染器
 * 流程：先整体 HTML 转义 → 再做 Markdown 语法替换
 * 保证用户输入 / AI 输出中的任何 HTML 都不会被执行（防 XSS）
 * ═══════════════════════════════════════════════════════ */
"use strict";

const Markdown = (() => {

  /* ---------- 转义 ---------- */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* 链接白名单：仅允许 http(s) */
  function safeUrl(url) {
    const u = String(url).trim();
    return /^https?:\/\//i.test(u) ? u : "#";
  }

  /* ---------- 行内元素（在已转义文本上运行） ---------- */
  function inline(text) {
    let s = text;

    // 行内代码 `code`（先处理，内部不再解析其它语法）
    s = s.replace(/`([^`\n]+)`/g, (m, code) =>
      `<code>${code}</code>`);

    // 图片 ![alt](url) —— AI 输出中的外链图片，仅 https
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
      /^https?:\/\//i.test(url)
        ? `<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer" style="max-width:100%;border-radius:10px;margin:6px 0">`
        : m);

    // 链接 [text](url)
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, txt, url) =>
      `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`);

    // 粗体+斜体 ***x***、粗体 **x**、斜体 *x* / _x_、删除线 ~~x~~
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?，。；：！？)]|$)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?，。；：！？)]|$)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    return s;
  }

  /* ---------- 块级渲染 ---------- */
  function render(src) {
    if (!src) return "";
    const text = String(src).replace(/\r\n?/g, "\n");

    // 提取代码块，防止内部内容被二次处理
    const codeBlocks = [];
    let s = text.replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
      codeBlocks.push({ lang: lang || "text", code });
      return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });

    s = escapeHtml(s);

    const lines = s.split("\n");
    const out = [];
    let listType = null;      // 'ul' | 'ol'
    let inQuote = false;
    let tableBuf = [];

    const closeList  = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    const closeQuote = () => { if (inQuote)  { out.push("</blockquote>"); inQuote = false; } };

    const flushTable = () => {
      if (!tableBuf.length) return;
      const rows = tableBuf;
      tableBuf = [];
      const isSep = r => /^\|?[\s:|-]+\|?$/.test(r) && /-/.test(r);
      let html = "<table>";
      let bodyStarted = false;
      for (const r of rows) {
        if (isSep(r)) continue;
        const cells = r.replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
        const tag = bodyStarted ? "td" : "th";
        html += `<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
        bodyStarted = true;
      }
      html += "</table>";
      out.push(html);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 表格行
      if (/^\s*\|.*\|\s*$/.test(line)) { tableBuf.push(line); closeList(); closeQuote(); continue; }
      flushTable();

      // 空行
      if (!line.trim()) { closeList(); closeQuote(); continue; }

      // 代码块占位符（独立成行）
      const codeMatch = line.trim().match(/^\u0000CODE(\d+)\u0000$/);
      if (codeMatch) {
        closeList(); closeQuote();
        const { lang, code } = codeBlocks[+codeMatch[1]];
        out.push(
          `<md-code-block>` +
          `<div class="code-head"><span>${escapeHtml(lang)}</span>` +
          `<button class="code-copy" data-code="${encodeURIComponent(code)}">复制</button></div>` +
          `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>` +
          `</md-code-block>`);
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); closeQuote(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }

      // 分割线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeList(); closeQuote(); out.push("<hr>"); continue; }

      // 引用
      const q = line.match(/^\s*&gt;\s?(.*)$/);
      if (q) {
        closeList();
        if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
        out.push(`<p>${inline(q[1])}</p>`);
        continue;
      }
      closeQuote();

      // 无序列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        out.push(`<li>${inline(ul[1])}</li>`);
        continue;
      }

      // 有序列表
      const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/);
      if (ol) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }
      closeList();

      // 普通段落
      out.push(`<p>${inline(line)}</p>`);
    }

    flushTable(); closeList(); closeQuote();
    return out.join("\n");
  }

  return { render, escapeHtml };
})();
