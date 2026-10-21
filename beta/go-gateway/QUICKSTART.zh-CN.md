# 卷桥 Go beta 快速开始

> 历史说明：此页对应 0.1.0 独立核心。最新桌面 beta 直接运行 `release/ScrollBridge-0.3.0-beta-win-x64.exe`，无需手动生成 JSON 配置；详见 DESKTOP-0.3.0.md。

这是独立的命令行网关，尚未接入桌面 UI。不会读取或覆盖正式版配置，也不自动启动隧道。

1. 解压压缩包，将 `config.example.json` 复制为 `config.beta.json`。
2. 在此目录打开 PowerShell 7，执行 `./ScrollBridge-Go-Beta-0.1.0-win-x64.exe -keygen`，保存显示的密钥，将 SHA256 摘要填到配置并启用该 key。
3. 在配置中填写实际模型 ID，同时更新 `exposureIds` 对应的名称；为本地代理密钥设置当前进程环境变量 `SCROLLBRIDGE_UPSTREAM_KEY`。不要把密钥提交到 Git。
4. 执行 `./ScrollBridge-Go-Beta-0.1.0-win-x64.exe -config config.beta.json -check`，确认配置有效。
5. 执行 `./ScrollBridge-Go-Beta-0.1.0-win-x64.exe -config config.beta.json -state .beta-state`。

服务地址：`http://127.0.0.1:18453`。使用新生成的消费密钥请求 `/v1/models`，示例可调用模型为 `chat`。退出使用 Ctrl+C。

费率在 `billing.rates` 中设置，输入、输出、缓存输入分别按每百万 token 计价。`readUsagePrice` 决定是否改读上游 usage 的费用字段；字段缺失显示未提供。修改配置必须增加 `version`，会取消正在执行的旧配置请求。默认关闭计价；示例价格不是报价。

可选 Redis、额度、接口支持范围及已知限制详见 README.md；测试对比详见 REPORT.md。此 beta 缺少现有版的 WebSocket、multipart 图像编辑、Gemini 图像转换和隧道托管，暂不作为正式版替代品。
