# 卷桥 ScrollBridge

将本机 CLIProxyAPI / EasyCLIProxyAPI 模型服务，通过固定域名和 HTTPS 提供给外部客户端。桌面端支持 Windows x64，使用 Go 网关和 Electron 界面，支持浅色、深色及跟随系统。

[下载发行版](https://github.com/telecom888/ScrollBridge--EasyCLIProxyAPI/releases/latest) · [文档目录](docs/README.md) · [版本记录](docs/releases/README.md)

## 开始使用

提供三种发行包，无需另装 Node.js 或 Go：

| 形式 | 启动方式 |
| --- | --- |
| ZIP 文件夹版 | 解压后运行 `卷桥.exe`，保留文件夹中的运行文件 |
| 安装版 | 运行 `ScrollBridge-Setup-版本-win-x64.exe`，安装到当前账户可写的目录 |
| 单 exe 便携版 | 运行 `ScrollBridge-版本-win-x64.exe`，每次启动会解压临时运行文件 |

1. 保持原代理工具运行，在「连接」填写本地服务地址或从其 `cpa-core/config.yaml` 导入。
2. 点击「检测进程」，确认核心进程、端口和模型接口正常。默认本地服务为 `http://127.0.0.1:8317`，卷桥网关为 `127.0.0.1:18443`。
3. 填写自己的域名和隧道令牌。首次域名默认留空，绑定方式见下文。
4. 点击「启动连接」，随后在「连接」检测外部请求；可选择检测密钥和文本模型。
5. 在「密钥」创建客户端凭据，在「接入」复制调用地址和示例。

配置保存在主程序同目录的 `scrollbridge.json`。手动换包或移动目录时保留该文件，目录必须可写。程序不会把业务配置回退到其他目录；缓存、单实例锁、管理 API 发现文件和 Go 运行账本仍位于当前用户的应用数据目录。

连接运行时，修改本地服务、端口、域名、隧道令牌及传输协议需先停止连接。关闭窗口会缩到托盘；从托盘退出会停止隧道和网关。开机启动只打开应用，不自动建立公网连接。

## 绑定域名

域名需要接入 Cloudflare DNS，注册商可保持不变。卷桥使用命名 Tunnel，不要求路由器开放入站端口。

**已有隧道**：在 Cloudflare 创建远程管理隧道，添加公开应用路由。主机名填写自己的 API 域名，Service 填写 `http://127.0.0.1:18443`（或修改后的网关端口）。将连接令牌填入卷桥；只粘贴令牌本身，不要粘贴安装命令，也不要把路由直接指向本地代理端口。

**自动绑定**：在「设置 → 域名与隧道」提供 Cloudflare API 令牌、账户 ID 和区域 ID。所需权限为目标账户的 Cloudflare Tunnel 编辑，以及目标区域的 DNS 编辑、区域读取。应用创建隧道和 CNAME，不覆盖已有同名 DNS 记录。API 令牌仅用于当前操作，不保存；隧道连接令牌随本地配置保存。

修改网关端口后，也需修改 Cloudflare 路由的 Service。停止连接不会删除云端域名和隧道。网络切换后的自动恢复规则见 [隧道恢复](docs/tunnel-recovery.md)。

## 接入与权限

| 协议 | 客户端地址或端点 | 鉴权 |
| --- | --- | --- |
| OpenAI 兼容 | `https://你的域名/v1`，支持 Chat Completions、Responses、Completions、Embeddings、模型列表 | `Authorization: Bearer 卷桥访问密钥` |
| Anthropic | `https://你的域名`，支持 `/v1/messages`、`/v1/messages/count_tokens` | `x-api-key`，并传 `anthropic-version` |
| Google | `https://你的域名`，支持模型目录、generateContent、streamGenerateContent、countTokens、Interactions | `x-goog-api-key`，也接受 `?key=` |

支持 SSE 和 OpenAI Responses WebSocket。实际模型和供应商能力由本地代理提供；卷桥不管理供应商 OAuth 登录。客户端地址避免重复追加 `/v1`。

- 每个密钥可独立启停、设置可用模型、并发限制和周期请求数限制。全局关闭的模型，单个密钥不能重新开放。
- 一个实际模型可配置多个对外模型 ID，并选择是否保留原始 ID。别名和原始 ID 的授权按对外条目管理。
- 可启动时、检测进程时或按间隔刷新模型目录。已下架模型保留别名并全局关闭，重新出现不会自动开放，也可手动删除。
- 「设置 → 接口」可分别启用图像接口、Gemini 图像生成兼容和语音接口；仍须由本地代理提供相应能力，且模型已获授权。
- 图像端点为 `/v1/images/generations`、`/v1/images/edits`；兼容开关用于将 Gemini 图像请求转换为 Google 格式。语音适配见 [语音接口](docs/speech-interface.md)。

## 记录与检测

请求记录仅保留本次运行，可按单个、多个或全部密钥筛选。保留数量可设为 100–10,000 条，默认 200 条，支持分页和 CSV/JSON 导出；隧道消息保留最近 100 条。

「显示请求IP」和「显示请求体」仅控制显示，关闭后仍采集新请求的 IP 和有限正文预览。正文每条最多 16 KiB，总计最多 8 MiB，按需查看，不包含在普通导出中。清空记录或退出程序后删除。黑名单命中返回 403，不转发到模型服务。信任规则、隐私和预览限制见 [请求记录](docs/request-logs.md)。

本地检测检查核心进程、端口归属和模型列表。外部检测通过公网域名验证 HTTPS、鉴权、模型目录及一次短流式请求，可能消耗模型额度；它是本机访问公网域名的回环测试，不能代替其他设备和网络的验证。

## 配置与通信边界

请求链路为：外部客户端 → HTTPS → Cloudflare → 加密隧道 → 本机网关 → 本机代理。Cloudflare 终止客户端 TLS，可见应用流量；本机网关及本地上游限制为回环地址。域名、电脑和本地代理都需保持可用。

客户端密钥、本地代理密钥和隧道令牌通过固定内置密钥的 AES-256-GCM 保存在配置中。它提供可移植的非明文保存，不能防止拿到程序和配置的本机使用者解密。损坏配置不会被自动替换或生成新密钥。隧道令牌通过子进程环境传递，不放入命令行。

默认不设固定的全局请求并发上限。仍保留请求大小、共享缓冲预算、超时、背压和客户端取消处理；普通网关请求体上限为 32 MiB，总超时为 30 分钟。模型调用入口不开放管理面板、OAuth 或任意地址转发。

本机管理 API 与桌面共用状态和操作锁，只监听回环地址，使用独立管理令牌，适合自动化或大模型代理操作。调用方式见 [管理 API](docs/management-api.md)。

## 更新与开发

「设置」的更新区域支持 GitHub 和默认的 GitHub 镜像，提供版本对比、更新日志及下载更新。下载包验证大小、SHA-256 和 Ed25519 签名清单后才允许安装。配置保留及发布流程见 [更新与发布](docs/updates.md)。

开发环境为 Windows x64、Node.js 24 和 `beta/go-gateway/go.mod` 指定的 Go 工具链：

```powershell
npm ci
npm run vendor
node scripts/build-desktop.cjs core
npm start
```

`npm run dist` 执行语法、Node 和 Go 测试，构建三种发布包及签名更新清单。测试分层、按变更选择检查及打包验证见 [测试指南](docs/testing.md)。版本说明维护在 `docs/releases/<版本>.md`，GitHub Actions 可在线编译并直接上传 Release。

Go 为维护主线；历史 Node 网关保留用于对照回归，`npm run dist:node` 可单独构建。独立 Go 核心部署见 [核心说明](beta/go-gateway/README.md)。临时配置、截图及测试报告位于忽略的 `.test-output/`，发行包不包含个人配置。

## 许可与来源

项目使用 [GNU GPLv3](LICENSE)，未捆绑 CLIProxyAPI 或 EasyCLIProxyAPI 可执行文件。依赖与图标许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。发布包未配置 Windows 可执行文件代码签名；它与更新清单的 Ed25519 签名是两件事。

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、[EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)
- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/)
- [Lobe Icons](https://github.com/lobehub/lobe-icons)
