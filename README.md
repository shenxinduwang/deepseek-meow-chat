# DeepSeek 喵聊天 🐱

一个基于 DeepSeek API 的纯前端 Web 聊天应用：无构建步骤、无后端依赖，开箱即用。

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 三种模型 | `deepseek-v4-flash`（快速）/ `deepseek-v4-pro`（强大）/ `deepseek-v4-flash-vision-exp`（视觉实验），顶栏下拉一键切换 |
| 三种响应模式 | ⚡**直答**（直接输出）/ 💭**思考**（展示模型思考过程 reasoning 流）/ 🌐**联网**（联网搜索实时信息），按钮高亮标识当前模式 |
| 图像上传 | 仅 Vision 模型启用；支持 JPG / PNG / WebP / GIF，多选最多 4 张；含预览、进度条、取消；客户端 Canvas 自动压缩；支持拖拽与剪贴板粘贴 |
| 聊天界面 | 用户/AI 消息气泡区分、Markdown 渲染（代码块带复制按钮）、思考过程折叠面板、图片灯箱放大 |
| 输入体验 | 多行自动伸缩、Enter 发送 / Shift+Enter 换行、中文输入法合成状态防误发 |
| 错误处理 | 认证失败 / 余额不足 / 模型不可用 / 限流 / 服务器错误 / 网络异常 / 超时，全部有友好提示；网络类错误自动指数退避重试；错误消息带"重新发送"按钮 |
| 超时与取消 | 可配置空闲超时（流式期间逐 chunk 重置）；生成中发送按钮变红色"停止"，可随时中断并保留已生成部分 |
| 数据持久化 | 聊天记录、模型/模式选择、设置全部存 localStorage；图片内联存储，配额不足自动剥离最旧图片降级保存 |
| 响应式 | 桌面 / 平板 / 手机自适应，触控目标 ≥ 44px，适配刘海屏 safe-area |
| 安全 | API Key 仅存本机 localStorage，不写入代码；输出渲染前全量 HTML 转义防 XSS；链接仅允许 http(s) 白名单；输入剔除控制字符并限长 |

## 📁 目录结构

```
localWebPage/
├── index.html        # 页面结构
├── css/
│   └── style.css     # 样式（响应式 + 动画）
├── js/
│   ├── config.js     # 模型 / 模式 / 默认参数（改配置只动这里）
│   ├── storage.js    # localStorage 持久化（含配额降级）
│   ├── markdown.js   # 安全 Markdown 渲染器
│   ├── api.js        # API 客户端（SSE 流式 / 超时 / 重试 / 错误分类）
│   └── app.js        # UI 主逻辑
└── README.md
```

## 🚀 部署与运行

**方式一：直接双击打开**
直接用浏览器打开 `index.html` 即可（file:// 协议下功能完整可用）。

**方式二：本地静态服务器（推荐）**
```bash
# 任选其一
python -m http.server 8080
npx serve .
```
访问 `http://localhost:8080`。

**方式三：部署到任意静态托管**
整个目录上传到 GitHub Pages / Vercel / Netlify / Nginx 静态目录即可，无需任何构建或环境变量。

## 🔑 首次使用

1. 打开页面，会自动弹出 **⚙️ 设置**；
2. 填入 DeepSeek **API Key**（[platform.deepseek.com](https://platform.deepseek.com) 获取，`sk-` 开头）；
3. 保存后即可开始聊天。Key 只保存在你自己浏览器的 localStorage 中，不会上传到任何第三方服务器。

## ⚙️ 可调参数

所有模型清单、模式附加参数、超时/重试默认值集中在 `js/config.js`：

```js
modeParams: {
  think:  { enable_thinking: true },   // 思考模式附加请求参数
  search: { enable_search: true }      // 联网模式附加请求参数
}
```
若 DeepSeek 官方参数名有变化（例如 `thinking: {type: "enabled"}`），仅需修改此文件。

## 🧪 已覆盖的测试场景

- 三模型切换（含切出视觉模型时自动清空待发图片）
- 三模式切换与消息标记（💭 思考 / 🌐 联网）
- 图片上传：格式校验、大小限制、进度条、取消、拖拽、粘贴
- 错误场景：无 Key、401、402、404、429、5xx、断网、超时 → 均有对应提示与重试按钮
- 生成中停止 → 保留已输出内容
- 刷新页面 → 聊天记录 / 模型 / 模式恢复
- 移动端窄屏布局
