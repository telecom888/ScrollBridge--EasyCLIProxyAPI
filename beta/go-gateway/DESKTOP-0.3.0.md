# 桌面双版本 0.3.0

交付文件：

- `release/ScrollBridge-0.3.0-win-x64.exe`：保留现有 Node 网关。
- `release/ScrollBridge-0.3.0-beta-win-x64.exe`：Electron 桌面托管 Go 网关。
- `release/SHA256SUMS-0.3.0.txt`：两份可执行文件的校验值。

界面共用布局，不显示实现技术栈；beta 版只在版本号增加 beta。“管理客户端的访问权限”已移除。所有标签页通过同一个标题容器执行 200 ms、6 px 上移淡入，保持相同位置和节奏，并保留减少动态效果的系统偏好支持。

## Go 桌面接入

Electron 仍负责窗口、托盘、Windows safeStorage、配置、密钥/模型管理、连通性检测、Cloudflare 域名和隧道。模型请求走独立 Go 子进程，不经过 Node HTTP 代理。桌面和 Go 通过 stdin/stdout 消息通信，管理命令没有绑定到公网或本机 HTTP 管理接口。

外观或检测选择等设置不触发无意义的网关重载。单纯更新费率保留正在执行的请求及其原费率，之后的新 HTTP/WS 请求使用新价格；权限变化才取消旧请求。

消费密钥只转换成摘要发送；供给密钥放入子进程环境，隧道令牌仍仅交给 cloudflared。策略及费率热更新等待 Go 确认后才完成操作。Go 配置更新失败时停止连接，避免桌面显示已撤权而网关继续使用旧策略。Go 意外退出会停止隧道并显示连接异常。正常停止及退出会关闭子进程；父进程关闭管道也会触发核心退出。

两版读取同一份 Windows 账户加密的 v2 配置，并使用单实例锁。可选的费用字段有默认值，加载原配置不会生成新密钥或清空域名。切换版本前先停止连接并退出当前应用。构建和验证使用隔离配置，没有替用户切换运行中的程序。

## 协议迁移

- Responses WebSocket：双向传输、模型别名、嵌套冲突检查、继承模型绑定、响应 ID 映射和运行中撤权关闭；逐帧限额、写超时、背压及取消。可选输出额度按每次 response 预留并核算。
- 图像编辑：JSON 与 multipart 解析，保留上传二进制，拒绝重复字段和文件形式的模型选择器，上传最多 32 MiB。
- Gemini 图像生成兼容：从实际模型 ID 判断，转换 OpenAI 图像生成/编辑为 Google 请求，返回 b64_json；支持参考图、尺寸、1–4 张串行生成；拒绝远程参考 URL、mask 等不支持的参数；保留上游错误状态并传播取消。
- gzip、deflate、Brotli：限制解压后的体积；无需改写的压缩 JSON 可原样转发，别名 JSON 与 SSE 解压后改写协议字段，清除失效实体头。
- 模型目录：读取上游元数据，再按全局和单 key 权限过滤、展开别名；支持两种列表与单模型详情。桌面“从代理获取”保留原有流程。
- 鉴权、健康检查、请求模型/实际模型记录、密钥轮换和保存恢复均接入同一桌面流程。

费用设置在 beta 版的“设置 / 费用”中。输入、输出、缓存命中输入分别设置每百万 token 价格；用量可读取 usage。保留读取 usage 费用的开关及字段路径，未提供时不记为零。请求记录显示费用和币种，不完整调用会注明未完成；费用审计在用户配置目录的 `gateway-go/billing.jsonl`。普通版保留现有能力，不显示尚无对应实现的费用面板。

桌面默认单次调用最长 30 分钟，共享缓冲预算 1 GiB；该值是预留预算，不是 RSS 硬上限。独立 CLI 的默认值及 Redis、供给池仍见 README.md。桌面没有新增 Redis 或供给集群管理页面。

## 验证与复现

- JavaScript 测试套件 60 项通过（含原 Node 网关与新增桥接/费用校验），语法检查通过。
- `SCROLLBRIDGE_TEST_ENGINE=go` 下运行同一份 `tests/multi-key.test.cjs`，共 11 项契约覆盖三协议、目录、单模型、压缩、multipart、Gemini 转换、撤权、轮换、WebSocket 和上传中撤权。
- Go 单元及故障测试、`go vet`、Windows amd64 `go test -race`。新增测试覆盖实际 WebSocket 生命周期、usage/额度结算、热撤权及 gzip Gemini 图像编辑。
- `scripts/desktop-gateway-smoke.cjs`：两个实际桌面引擎，使用隔离的本地模拟上游与隧道替身，检查标题动画、价格开关、请求费用、密钥加密、真实 Go 子进程、意外退出和重启恢复。不连接真实 Cloudflare，不消耗模型额度。
- `scripts/multi-key-smoke.cjs`、`scripts/motion-smoke.cjs`、`scripts/settings-lock-smoke.cjs`：分栏密钥页、草稿、深浅色、最小窗口、锁定提醒和减少动态效果。
- `scripts/packaged-flavors-smoke.cjs`：检查两份解包产物的版本和资源；beta 直接使用包内 Go exe 完成真实模型列表请求。
- `scripts/portable-smoke.cjs`：两份便携 exe 自解压、窗口资源及 Windows 加密初始化。

测试产物在 `.test-output/`，不进入 Git 或发布包。这里记录功能与生命周期验证，没有用原 0.1.0 性能数据冒充本次桌面版的容量结论。真实供应商兼容、长时间运行以及 RikkaHub 实机加载问题仍需要各自验证，后者按用户要求继续暂停。

构建：`node scripts/build-desktop.cjs both`；只生成 Go 核心供开发测试：`node scripts/build-desktop.cjs core`。构建器使用独立完整配置，避免 extraResources 数组合并后重复拷贝同一可执行文件。新 Go 依赖的许可证包含在 `licenses/go-gateway.txt` 并随桌面包分发。
