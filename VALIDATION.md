# 验证记录

日期：2026-10-20，Windows x64。

- `npm run check`：通过。
- `npm test`：25 项通过，0 失败。覆盖配置限制、三种鉴权、管理路由隔离、SSE 不缓冲、压缩内容透传、502、体积限制、请求取消、WebSocket、v8/旧版配置导入、加密存储、隧道令牌隔离与进程清理、Cloudflare DNS 冲突及失败回滚，以及本地进程/端口检查和公网模型请求检测。
- `npm audit --omit=dev`：生产依赖 0 已知漏洞。开发依赖不随 EXE 发布。
- Electron 桌面与打包程序自动检查：通过。覆盖四页导航、深浅色、绑定表单、调用示例、剪贴板、Windows DPAPI、密钥不进入状态快照、真实代理配置导入，以及进程与端口检测卡片。渲染器异常数 0。
- 真实现有代理：模型列表成功，检测到 8 个模型。
- 真实核心进程与端口检查：CLIProxyAPI 核心进程运行，8317 端口由核心进程监听，图形管理进程也在运行。
- 真实代理的三次最小模型流式请求：OpenAI Chat Completions、Anthropic Messages、Google streamGenerateContent 均 HTTP 200，均返回 `text/event-stream` 与 SSE 数据。分别使用 Bearer、x-api-key、x-goog-api-key 验证卷桥访问密钥。
- cloudflared 2026.10.1：官方二进制 SHA-256 已校验，值见 `vendor/manifest.json`。
- 品牌 SVG：GitHub 固定修订版下载，文件摘要见 `ui/brands/sources.json`；无脚本、外部资源或事件处理器。
- UI 参考图和实际浅色/深色截图均已目视检查。
- 免安装 EXE 自解压启动检查：通过。实际启动生成的 `ScrollBridge-0.1.0-win-x64.exe`，确认已进入打包应用、Portable 环境成立、UI 加载完成且 Windows 加密可用，随后正常退出。详细界面自动化针对同一构建的 `win-unpacked/卷桥.exe` 完成。

## 验证范围

没有用户的 Cloudflare API 或隧道凭据，因此自动绑定使用模拟 API 验证。未创建任何公网隧道或 DNS 记录，也未完成跨网络 HTTPS 实测。域名初始值保持空白。

最终上线步骤：在应用内填入域名及隧道配置，启动连接，在「接入」检测 HTTPS，再从手机蜂窝网络或另一外网客户端调用模型。此步骤还会验证用户账户权限、DNS/证书生效、Cloudflare 网络可达性和云端限制。
