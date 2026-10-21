# 卷桥 ScrollBridge

将正在本机运行的 CLIProxyAPI / EasyCLIProxyAPI 模型服务通过固定域名提供给外部客户端。Windows x64 桌面应用，白色与羊皮纸色界面，支持深色和跟随系统。域名默认留空。

## 启动

双击 `release/ScrollBridge-0.2.1-win-x64.exe`，无需安装 Node.js、管理员权限或开放入站端口。保持原代理工具运行。

连接运行时，点击锁定的配置项会提示「请先停止连接再修改配置」。停止连接后即可编辑。

1. 在「连接」选择「从代理工具导入」，选择原代理的 `cpa-core/config.yaml`。兼容当前 v8 和旧版配置，仅导入监听地址和首个客户端密钥，不读取 OAuth 凭据、不修改原文件。
2. 检测本地服务。默认地址 `http://127.0.0.1:8317`，网关 `127.0.0.1:18443`。
3. 填写你自己的域名并保存，例如 `api.example.com`。
4. 在「设置 → 域名与隧道」选择下述绑定方式，完成后「启动连接」。
5. 在「接入」检测 HTTPS，复制访问密钥和调用示例，在外部客户端使用。

## 密钥与模型权限

侧栏「密钥」位于「接入」和「模型」之间。支持新建、命名、复制、启停、重置、删除密钥，为不同客户端配置可用模型。密钥仅脱敏显示，重置和删除需要确认。关闭或重置一个密钥不影响其他密钥。

密钥页采用经过审核的 B/C 分栏设计：左侧搜索和选择密钥，右侧编辑名称、启用状态和模型权限，修改后点击「保存」。重置、删除位于每个密钥的更多菜单，复制提供独立图标入口。切换密钥或关闭编辑区前，未保存的修改会提醒；后台刷新不会覆盖草稿。浅深色参考及 imagegen 提示词保存在 `design/ui-review-20261021/`。

有效权限是「密钥已启用、实际模型全局开放、当前密钥允许该对外 ID」的交集。全局关闭不能被单个密钥覆盖。新密钥默认选择「全部模型」，自动包含新增模型和别名；取消部分勾选后切换到「指定模型」，之后新增项目需手动授权。全局关闭项会显示原因，原有授权保留，恢复全局开放后重新生效。

在「模型」点击「从代理获取」登记实际模型。新发现模型默认全局开放；未登记或当前不可用的模型不接受调用。代理暂时不提供的模型仍保留全局与别名设置。

每个实际模型可编辑一个或多个对外 ID。无别名时使用原始 ID；有别名时默认隐藏并拒绝原始 ID，开启「保留原始 ID」后可同时调用原名和别名。每个对外 ID 可分别授权。别名全局唯一，支持字母、数字、点、下划线和短横线。修改别名文字保留已有授权；删除后新建的条目不继承旧授权。

变更保存后立即用于新 HTTP 请求，已转发的请求允许完成；受密钥、权限或映射变化影响的 WebSocket 会断开并要求重新鉴权。连接参数继续遵循原有运行时锁定规则。模型列表和单模型查询只返回当前密钥可用的对外 ID。

网关将 JSON、Google 路径、图像 multipart 和 WebSocket 中的对外 ID 转为实际模型，并将响应中的协议模型字段还原为请求 ID。仅修改协议字段，保留正文和图片；SSE 增量处理，不等待完整生成。请求上限为 32 MiB，支持 gzip、deflate、br 请求编码。

「记录」显示密钥名称、请求模型和实际模型，不保存完整密钥、提示词或图片。WebSocket 的状态 200 表示网关接受并转发，实际生成结果由上游决定。

配置文件仅支持新版 `version: 2`，不在启动时自动迁移。已有配置可在关闭旧程序后执行一次 `electron scripts/convert-settings.cjs 配置目录`；它会备份旧文件、保留原访问密钥及连接参数，再写入新版配置。添加 `--check` 只检查能否转换，不写配置；添加 `--refresh-models` 会同时读取本地代理的当前模型目录，不发送生成请求。

## 图像接口

在「设置 → 接口」开启「图像接口」，开放 OpenAI 兼容的 `POST /v1/images/generations` 和 `POST /v1/images/edits`。默认关闭，自动保存，连接运行时也可切换，对后续请求立即生效。编辑支持 JSON 与 multipart/form-data，上传文件原字节透传，不写入磁盘。

仍使用卷桥访问密钥，必须显式填写 `model`，并在「模型」页允许该模型外部访问。请求上限 32 MiB；日志记录模型 ID，不记录提示词、图片或正文。实际可用模型和生成能力取决于本地代理及上游供应商。

401 表示未通过卷桥访问密钥验证；图像开关关闭时返回 404 并提示开启设置；模型被禁用时返回 403。开关开启后，上游返回的状态码与生成结果原样转发。

### RikkaHub 与 Gemini 图像生成兼容

在「设置 → 接口」同时开启「图像接口」和「Gemini 图像生成兼容」。兼容开关默认关闭、自动保存，运行中可修改。RikkaHub 保持 OpenAI 协议，Base URL 为 `https://你的域名/v1`，模型选择本地代理实际提供的 Gemini 图像模型 ID，例如 `gemini-3.1-flash-image`。外部访问权限仍由「模型」页控制。

识别 `gemini-...image...` 模型的生成与编辑请求，将其转为本地代理 `/v1beta/models/{model}:generateContent`，把最终图片转成 OpenAI `data[].b64_json`（附实际 output_format）返回。GPT、Grok 等模型保持原始透传。参考图支持 PNG、JPEG、WebP multipart 上传或 JSON base64 data URL；不下载远程 URL，不保存图片或提示词，不返回中间思考图片。转换调用不重试。

每次支持 1–4 张，按数量依次向上游请求；任一张失败时返回错误，已生成图片可能已消耗额度。尺寸为 auto、1K、2K、4K 或常用像素宽高；宽高映射为 Gemini 比例与清晰度档位，不保证精确像素。响应只提供 b64_json，单次响应最多 64 MiB。遮罩、透明背景、质量等级和格式转换等不兼容选项会明确报错；省略这些参数即可。上游模型能力、额度及图片审核仍适用。

实现依据：RikkaHub `5203601f79e61d63a56efb3d277d4e79e25bcc39` 的 OpenAIProvider 与媒体适配器；[Google 图像生成文档](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)。

## 连通性检测

外部请求卡片可选择检测密钥和模型，点击「获取模型」更新列表。模型选项遵循所选密钥的权限；检测使用该密钥发起请求，不提供绕过权限的测试入口。默认自动选择模型，也可指定模型并保存选择。检测只发送文本流式请求；选择的模型若未在公网列表开放，会提示原因，不会换成其他模型。

界面采用分行的状态与名称/值布局，检测内容使用 14px 字体，辅助文字使用 13px。

「连接」页提供两个独立检测卡片，并显示检测时间和每步结果。

- **代理工具 → 检测进程**：读取 CLIProxyAPI 核心进程 PID、确认服务端口由核心进程监听，再访问模型列表。会区分未启动、端口被其他进程占用、本地密钥错误与模型 API 故障。EasyCLIProxyAPI 图形进程是否运行也会在内部检测结果中记录，核心服务才是请求可用的判断依据。
- **外部请求 → 检测外部请求**：严格通过保存域名的 HTTPS 地址访问网关，验证证书、鉴权、模型列表，再发送一次 `Reply OK.` 短模型请求。只有收到有效 SSE 内容与完成标记、且没有流内错误时才标为正常；单纯 HTTP 200 不算通过。检测会使用原代理的一个文本模型额度，选择优先 Flash、其次可用文本模型，最多 64 个输出 Token。

外部检测由本机访问公网域名，是公网路径回环测试，可发现 DNS、TLS、鉴权和模型响应问题。它不等于另一个地理位置的独立网络探针；上线后仍可使用手机蜂窝网络复核。程序不自动重复发送模型请求。修改连接配置后旧检测结果清空。

## 绑定域名

域名须托管于 Cloudflare DNS。注册商可以保留原样，仅在注册商处按 Cloudflare 指示修改 NS；导入并核对现有 DNS 记录后再变更。应用不会自动迁移 DNS 或替换域名服务器。

### 已有隧道

在 Cloudflare 控制台 Networking → Tunnels 创建 remotely managed 命名隧道，取得连接令牌（只复制 `eyJ...`，不是整条安装命令）。

在隧道中新增 Published application 路由：

| 字段 | 填写 |
| --- | --- |
| Hostname | 你在卷桥中保存的域名 |
| Service | `http://127.0.0.1:18443`，或修改后的网关端口 |

将隧道令牌粘贴到卷桥并保存。控制台会为路由建立 DNS 记录。不要把路由直接指向代理的 8317 端口。

### 自动绑定

在卷桥中填写 Cloudflare API 令牌、账户 ID、区域 ID，再点击「创建隧道并绑定域名」。该操作会在 Cloudflare 创建远程管理隧道、设置 ingress、创建代理 CNAME，并加密保存隧道连接令牌。

API 令牌最小权限：目标账户 **Cloudflare Tunnel: Edit**，目标区域 **DNS: Edit**、**Zone: Read**。账户 ID、区域 ID 可从域名概览取得。API 令牌仅用于当前操作，不保存到设置或日志；无需提供 Global API Key。遇到同名 DNS 记录时停止，不覆盖已有记录；创建过程中失败会尽力撤销本次资源，若清理失败会提示手动处理。

网关端口以后改变时，必须同时在 Cloudflare 路由中更新 Service。停止连接只停止本地进程，不删除已建立的域名和隧道。

## 接入协议

| 协议 | Base URL / 端点 | 外部鉴权 |
| --- | --- | --- |
| OpenAI | `https://你的域名/v1`；Chat Completions、Responses、Completions、Embeddings、模型列表 | `Authorization: Bearer 卷桥访问密钥` |
| Anthropic | `https://你的域名`；`/v1/messages`、`/v1/messages/count_tokens` | `x-api-key: 卷桥访问密钥`，并传 `anthropic-version` |
| Google | `https://你的域名`；`/v1beta/models`、generateContent、streamGenerateContent、countTokens、Interactions | `x-goog-api-key: 卷桥访问密钥`，也接受 `?key=` |

支持 SSE，OpenAI Responses 的 `/v1/responses` 支持 WebSocket。实际模型与供应商能力由原代理提供；卷桥负责密钥权限、ID 映射及可选的 Gemini 图像兼容，不管理供应商 OAuth 登录。使用 SDK 时避免重复追加 `/v1`。

## 连接与数据

- 请求链路：外部客户端 → HTTPS → Cloudflare 边缘 → 加密 Tunnel → 本机回环 HTTP 网关 → 本机代理。Cloudflare 终止客户端 TLS，可见应用流量；不是客户端到本机的端到端 TLS。本机两段 HTTP 均限定回环地址，不经过局域网。
- 命名 Tunnel 提供固定域名与 SSE。Quick Tunnel 官方不支持 SSE，因此应用不提供该模式。
- 外部访问密钥独立随机生成；通过 Bearer、Anthropic 和 Google 方式验证后，替换成本地代理客户端密钥。模型接口白名单之外的管理面板、OAuth、任意地址转发均被拒绝。
- 网关仅监听 `127.0.0.1`；本地上游也限制回环地址。HTTPS 上游保留证书校验，不提供跳过校验选项。
- 外部密钥、本地密钥、隧道令牌由 Electron safeStorage 使用 Windows DPAPI 加密，保存在 `%APPDATA%/ScrollBridge/settings.json`。配置绑定当前 Windows 用户。隧道令牌通过子进程环境传递，不在命令行或明文文件中保存。
- 日志只在内存保留最近 200 条请求、100 条隧道消息，不记录正文和查询参数。退出即清空。复制密钥后系统剪贴板中会保留该值。
- 单请求上限 32 MiB，最多 64 个并发上游请求，闲置上游超时 10 分钟，HTTP 请求最长 30 分钟。流使用管道背压，客户端断开会取消上游。
- 连接运行时关闭主窗口会缩到托盘；从托盘「退出」停止隧道和网关。应用不会启动或退出原代理工具。开机启动只打开卷桥，不自动向公网发布。
- 本机和原代理必须保持运行、联网且不休眠。命名隧道连接成功不代表 DNS 和证书已生效，需再做「检测 HTTPS」。外网最终验证应在手机蜂窝网络或其他网络使用实际客户端发起请求。
- 云端服务与 Cloudflare 的请求大小、超时及网络可达性仍适用。受限网络可在设置将传输改成 HTTP/2；电脑需能出站访问 Cloudflare Tunnel 的 7844 端口。

## 开发与打包

需要 Node.js 24、npm、Windows x64；Python Pillow 仅用于重新生成应用图标。

```powershell
npm ci
npm run vendor
npm run check
npm test
npm start
npm run dist
```

`vendor` 下载 cloudflared 2026.10.1 并比对固定官方 SHA-256。`dist` 生成免安装 EXE。`node scripts/logos.cjs` 可从锁定的 GitHub 版本重新下载 SVG 和许可证。`node scripts/smoke.cjs` 验证 Electron UI 和本工作区代理导入；`node scripts/live-proxy.cjs` 对本工作区正在运行的代理发起三次最小流式请求。后两者的原代理路径针对本机，迁移机器时需修改。

测试截图、临时加密配置和报告在 `.test-output/`，不进入 Git 或安装包。源代码不包含个人域名和凭据。生产依赖为 `ws`、`yaml` 和 `busboy`。`node scripts/multi-key-smoke.cjs` 在隔离配置中验证密钥、权限、别名和重启恢复，使用模拟上游，不消耗模型额度。

当前为未签名的本地构建，未配置代码签名证书。分发前可为构建增加 Windows 签名。

## 参考与许可

UI 先用内置 ImageGen 生成参考，再实现原生代码界面。参考图、完整提示词与实际截图位于 `design/`。三家公司标识来自 GitHub Lobe Icons，保留 MIT 许可证；本项目独立于三家公司。

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，研究版本 `3f0cef010e4ad20279500e6b0f18060b6f3f37cc`，接口定义 `internal/api/server_routes.go`、配置兼容 `internal/config/config_v8.go`。
- [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)，研究版本 `aee871a369ad3494c213806da8f8ba8c840e79b8`。
- [Cloudflare Tunnel 配置](https://developers.cloudflare.com/tunnel/get-started/)、[Quick Tunnel 限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
- [Lobe Icons](https://github.com/lobehub/lobe-icons)，见 `THIRD_PARTY_NOTICES.md`。

项目使用 MIT 许可证。没有捆绑原 CLIProxyAPI 或 EasyCLIProxyAPI 可执行文件。

## Go 网关 beta

分支 `beta/go-gateway` 同时交付两个桌面版本：`ScrollBridge-0.3.2-win-x64.exe` 保留 Node 网关，`ScrollBridge-0.3.2-beta-win-x64.exe` 使用 Go 网关。两者复用桌面布局、Windows 加密配置及隧道管理，界面不标注技术栈，后者仅在版本号显示 beta。新增费用设置和记录位于 beta 版。

Go 已移植 WebSocket、multipart 图像编辑、Gemini 图像生成兼容、gzip/deflate/Brotli、单模型详情及过滤后的上游模型目录。两版共用原有配置目录和单实例锁，请退出一版再打开另一版。现有配置在加载时补齐可选字段，不清空密钥或域名。

0.3.1 固定使用 `%APPDATA%/ScrollBridge`，在申请单实例锁前设置路径；未获得锁的进程不读取或写入配置。首次安装立即持久化密钥，后续启动仅读取；配置更新前保留 `settings.json.bak` 加密备份。发现主配置缺失但有备份或临时文件时停止启动，避免把旧安装误认为首次安装而产生新密钥。格式错误会提示实际配置路径，原文件保留；旧版配置仍由转换工具处理。可运行 `node scripts/profile-upgrade-smoke.cjs` 验证两种桌面版本共用加密配置、重复启动后密钥不变。

0.3.2 在启动读取失败时写入配置目录下的 `startup-error.json`，记录时间、程序版本、可执行文件路径、实际配置路径及格式结构；不记录凭证、提示词或配置内容。弹窗显示程序版本及错误记录位置。`node scripts/startup-error-smoke.cjs` 验证旧格式报错路径、错误记录脱敏及源文件保留。这是对尚未复现的格式错误补充诊断，并不代表已确定其根因。

构建：`node scripts/build-desktop.cjs both`；单独构建可用 `npm run dist:node` / `npm run dist:go`。开发启动默认 Node；先执行 `node scripts/build-desktop.cjs core`，再设置 `SCROLLBRIDGE_GATEWAY_ENGINE=go` 可在开发环境测试 Go 桌面版。

本次移植及验证见 [桌面双版本说明](beta/go-gateway/DESKTOP-0.3.0.md)。独立网关和可选 Redis 操作见 [核心说明](beta/go-gateway/README.md)；[原始性能对比](beta/go-gateway/REPORT.md) 是 0.1.0 核心版本的历史测量，不能作为本次桌面版的新压测数据。
