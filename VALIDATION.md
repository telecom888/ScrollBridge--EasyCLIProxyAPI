# 验证记录

日期：2026-10-20，Windows x64。

0.1.2 更新：新增模型页、模型开放开关、模型记录列。32 项单元测试通过；新增测试覆盖三种协议、压缩请求、Responses WebSocket、无模型拒绝、Google 模型前缀与大小写、外部列表过滤和运行时修改策略。`node scripts/models-smoke.cjs` 已验证真实 Electron 界面中的侧栏顺序、获取模型、搜索、开关保存、模型列及退出重启后的配置恢复。使用隔离配置和模拟本地模型列表，未修改用户重新配置的状态。

0.1.1 更新：保持原有运行时锁定行为，增加点击及键盘尝试修改时的提醒。`node scripts/settings-lock-smoke.cjs` 已验证八个配置控件的点击提示、设置页两个控件的键盘提示、运行时不写入配置，以及停止后的修改和保存。测试使用隔离配置，开机启动系统调用以测试替身执行，未修改本机启动项。

- `npm run check`：通过。
- `npm test`：32 项通过，0 失败。覆盖配置限制、三种鉴权、管理路由隔离、SSE 不缓冲、压缩内容透传、502、体积限制、请求取消、WebSocket、v8/旧版配置导入、加密存储、隧道令牌隔离与进程清理、Cloudflare DNS 冲突及失败回滚，以及连通性检测、模型访问限制和请求模型记录。
- `npm audit --omit=dev`：生产依赖 0 已知漏洞。开发依赖不随 EXE 发布。
- Electron 桌面与打包程序自动检查：通过。覆盖原有导航、深浅色、绑定表单、调用示例、剪贴板、Windows DPAPI、密钥不进入状态快照、真实代理配置导入、进程与端口检测卡片；0.1.2 另验证五页导航顺序、模型管理及模型设置恢复。原有测试中渲染器异常数 0。
- 真实现有代理：模型列表成功，检测到 8 个模型。
- 真实核心进程与端口检查：CLIProxyAPI 核心进程运行，8317 端口由核心进程监听，图形管理进程也在运行。
- 真实代理的三次最小模型流式请求：OpenAI Chat Completions、Anthropic Messages、Google streamGenerateContent 均 HTTP 200，均返回 `text/event-stream` 与 SSE 数据。分别使用 Bearer、x-api-key、x-goog-api-key 验证卷桥访问密钥。
- cloudflared 2026.10.1：官方二进制 SHA-256 已校验，值见 `vendor/manifest.json`。
- 品牌 SVG：GitHub 固定修订版下载，文件摘要见 `ui/brands/sources.json`；无脚本、外部资源或事件处理器。
- UI 参考图和实际浅色/深色截图均已目视检查。
- 免安装 EXE 自解压启动检查：通过。实际启动生成的 `ScrollBridge-0.1.2-win-x64.exe`，确认已进入打包应用、Portable 环境成立、UI 加载完成且 Windows 加密可用，随后正常退出。模型页自动化也针对打包后的 `win-unpacked/卷桥.exe` 完成。

## 验证范围

Cloudflare 自动创建隧道与 DNS 的 API 使用模拟请求验证。正式隧道和域名路由由用户在 Cloudflare 创建，先前配置完成后已通过用户域名进行三种协议的公网 HTTPS 与 SSE 测试。本次模型访问控制使用隔离网关验证，未改动用户后来重新配置的环境。

本机访问公网域名属于公网路径回环测试，不代表独立外网探针；可进一步用手机蜂窝网络复核。新装应用的域名初始值保持空白。
