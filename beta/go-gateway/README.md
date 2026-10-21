# ScrollBridge Go Gateway beta 0.1.0

这是独立的 Go 网关实验版本，分支 `beta/go-gateway`。现有 Electron/Node 程序、Windows 加密配置、Cloudflare 隧道与生产端口没有被替换。当前 beta 使用 JSON 配置和命令行，尚未接入桌面设置页。

## 启动

在本目录使用 PowerShell 7：

go.mod 要求修复后的 Go 1.26.10 或更新版本；启用默认 GOTOOLCHAIN=auto 时会下载经 Go 校验机制验证的对应工具链，不修改系统默认 Go。构建后应运行固定版本的扫描：`go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...`。

```powershell
go build -trimpath -ldflags=-s -o ../../release/ScrollBridge-Go-Beta-0.1.0-win-x64.exe .
Copy-Item config.example.json config.beta.json
../../release/ScrollBridge-Go-Beta-0.1.0-win-x64.exe -keygen
```

`-keygen` 有意显示一次新密钥和 SHA-256，请自行保存密钥，仅将摘要填写到 `keys[].sha256`，然后设置 `enabled: true`。示例中的零摘要和禁用状态不能访问服务。填写真实 `actual` 模型 ID；如果修改原始 ID，也修改 `exposureIds` 中对应名称。费率都是示例值，不是厂商报价。

在当前终端设置 `SCROLLBRIDGE_UPSTREAM_KEY` 环境变量，值为本地代理的供给密钥。不要写到命令历史、源码或 Git。环境变量只是进程传递手段，不等同于加密保险库；供给密钥长期保存仍应由现有桌面端的 Windows 安全存储负责。

```powershell
../../release/ScrollBridge-Go-Beta-0.1.0-win-x64.exe -config config.beta.json -check
../../release/ScrollBridge-Go-Beta-0.1.0-win-x64.exe -config config.beta.json -state .beta-state
```

默认监听 `127.0.0.1:18453`，与正式版 18443 分开。`/healthz`、`/v1/models` 也要求消费密钥。若另建测试隧道，服务 URL 使用 `http://127.0.0.1:18453`；外部 HTTPS 继续由 Cloudflare 处理。程序不预填域名，也不会自动修改现有隧道。

## 策略与配置更新

消费密钥只保存 SHA-256，编译成摘要索引；供给密钥使用环境变量引用。原始 ID 与每个别名都有独立的 exposure ID，`keys[].allowed` 引用这些 ID。`mode: all` 只绕过单 key 的选择列表，不能绕过模型的全局 `enabled: false`。别名更名时保留 exposure ID，授权才会保留。未填写 `exposureIds` 时以名称作为授权 ID，更名会使旧授权失效。

配置文件每 500 ms 校验一次。每次编辑必须增加 `version`；建议先生成新文件，`-check` 验证，再以文件替换方式发布。相同版本内容变化、版本倒退、解析失败均不应用。超过 5 秒未获得有效配置时拒绝请求并取消现有调用；恢复有效配置后自动恢复。短暂写入错误期间沿用最后一次有效快照，因此 5 秒内并非强一致。

新版本先完整校验、编译，再原子替换。为保证撤权，当前 beta **取消全部正在执行的旧版本请求**，包括单纯修改价格时；这是保守实现，并非无损发布。监听地址及环境变量中的密钥值变更需要重启。

## 流式、资源和上游池

- 全局及单 key 并发上限，超限立即 429，不建立无界等待队列。
- TCP 连接另有限额（启动时并发上限的 4 倍，至少 128）；读取请求最多 60 秒，避免空闲连接和未授权慢速上传绕过资源限制。
- 请求体最多 32 MiB，JSON 深度最多 64 层，重复字段拒绝，避免模型字段解析分歧。
- SSE 按事件读取、同步写出和 Flush，客户端慢时背压传回上游；单事件、累计输出及写超时均有限制。支持 CRLF、LF、多行 data、OpenAI / Responses / Anthropic / Gemini 的 usage 与结束标记。
- 客户端断开、配置撤权、总超时、写超时、输出超限会取消上游。已送进 TCP 缓冲区的字节无法追回。
- `memoryBytes` 是共享缓冲工作量预算，按正文 6 倍、SSE 事件上限 8 倍预留；不是操作系统 RSS 硬上限。解析对象、连接、TLS、Go 运行时仍会占内存。可额外设置 `GOMEMLIMIT`，它也是软限制；服务器部署应另用作业对象或容器限制。
- 多个供给入口按最少活动请求分配，同负载时轮换。429、5xx、传输错误进入 1–64 秒指数冷却，识别 Retry-After（上限 300 秒）；半开仅允许一个探测请求。冷却状态为进程本地，重启后重置。
- 不自动重试生成 POST，避免请求已执行但响应丢失时重复扣费。故障会返回给客户端；下一次新请求可选其他健康入口。这里要求所有入口有同一实际模型目录，尚无基于成本、上下文或模型能力的动态路由。
- 转发时清除消费凭证、Cookie、转发头、逐跳头，按协议填写供给凭证；重定向不跟随。上游远程地址要求 HTTPS，本机回环允许 HTTP。

## 用量额度与费用

两者分开：`outputTokens` 是可选的**累计输出 token 额度**；`billing` 是费用计算和审计，不是预付费余额系统。

### 可调整价格

`billing.enabled` 开启计价；`rates` 三项分别是每百万 token 的输入、输出、缓存命中输入费用，使用十进制字符串。模型可通过 `models[].rates` 覆盖默认费率。

- `readUsagePrice: false`：读取上游 usage 中的 token 数，按手动费率计算费用，不采信上游费用值。
- `readUsagePrice: true`：读取 `usageCostPointer` 指定的费用字段，例如 `/usage/cost`。价格字段没有统一协议，此处是可配置的 JSON Pointer。字段缺失显示 `price_not_provided`，不当作零，不自动回落到手动价格。单位必须与 `currency` 一致，不做汇率转换。
- OpenAI / Responses 的 cached tokens 是输入总数的子集；Anthropic 的 input、cache_read、cache_creation 按其分项组合，创建缓存按普通输入价格；Gemini 使用 prompt、cachedContent、candidates 数量。缓存未报告时不推断命中。
- 缓存命中输入只计缓存价格，不再次计普通输入价格。若 usage 缺失或不合法，费用标记为不可计算；不以本地粗略分词冒充精确用量。
- 金额使用有理数计算，输出保留 9 位小数。流未完成时保留 `complete: false`，金额只是已报告部分，不能作为最终账单。

费用记录写入 `state/billing.jsonl`，包含配置版本、key ID、模型、费率/来源和请求结果，不包含提示词或密钥。每条落盘并 fsync，磁盘失败后拒绝后续请求；已经发送的响应无法回滚。多节点各有自己的审计目录，需要外部归集；未实现发票、货币余额、汇率、跨节点报表与账单争议处理。

### 累计输出额度

`outputTokens: 0` 关闭。启用时需设置 `maxOutputTokens`。调用前将单次输出上限预留，并写入对应协议的 max-token 字段；这依赖供给方遵守该上限。正常结束且有可信的最终 usage 时归还未使用部分；中断、usage 缺失、重启遗留调用均保留全部预留，宁可保守扣多。图片、embedding 等非文本接口在额度模式下拒绝调用。

本地账本是加锁、追加写、fsync 的 `quota.jsonl`，重启回放。破损日志拒绝启动，不擅自重置。目录不能由两个进程共用。额度是 lifetime 总量，没有按日重置；改 key 的名称或费率不会清空用量。保留 key ID 才能保留用量历史。尚无自动压缩与历史轮转，磁盘耗尽将停止服务。

**无法仅凭流末尾的 usage 实现逐 token 精确扣款与欠费瞬间截断。** beta 使用额度预留、上游输出上限、累计字节硬限制及已报告超额检测，不宣称解决供应商不报告用量或无视上限的问题。

## Redis 模式

设置一个环境变量（例如 `SCROLLBRIDGE_REDIS_URL`）保存 Redis URL。远程应使用 rediss/TLS、ACL 与独立实例或命名空间。当前 beta 使用固定键前缀，不能承载多个互不信任的部署。

```powershell
../../release/ScrollBridge-Go-Beta-0.1.0-win-x64.exe -config config.beta.json -redis-env SCROLLBRIDGE_REDIS_URL -publish
../../release/ScrollBridge-Go-Beta-0.1.0-win-x64.exe -redis-env SCROLLBRIDGE_REDIS_URL -state .beta-node-1
```

Redis 保存版本化配置；Lua 检查版本单调递增并原子发布，Pub/Sub 只做唤醒，500 ms 轮询补偿丢失消息。鉴权、模型映射仍读本地不可变快照，不在每次普通请求上访问 Redis。开启额度时，预留与归还通过 Redis Lua 跨节点原子操作；客户端禁用自动重试，避免不确定执行结果造成重复退款。

Redis 并不天然保证账本永不丢失。必须由部署方配置持久化、备份、禁用淘汰并保留 quota 键；故障转移丢写仍可能造成额度回退。此 beta 未实现共识账本、Redis Cluster/Sentinel 或故障转移的严格财务一致性。测试采用 miniredis，不代表真实 Redis 故障演练完成。

## 观测、测试与范围

`-admin 127.0.0.1:18454` 可开启独立的 `/metrics`，要求环境变量 `SCROLLBRIDGE_ADMIN_KEY` 至少 32 字符；公共服务没有管理路由。指标含活动数、缓冲预算、拒绝数、配置状态、堆和 goroutine。不要把管理端口接到隧道。请求日志为 stderr JSON，可由宿主收集。

```powershell
go test ./... -count=1
go vet ./...
$env:CC = (Get-Command x86_64-w64-mingw32-gcc).Source
go test -race ./... -count=1
node ../../scripts/benchmark-go-beta.cjs
```

支持核心 JSON HTTP：OpenAI chat/completions、completions、Responses、messages、embedding、Google 原生 generateContent/streamGenerateContent/countTokens，及授权后的模型目录。`images: true` 只开启 JSON `/v1/images/generations` 直通，本地代理必须支持对应模型。

**暂缺现有版的 Responses WebSocket、multipart 图像编辑、Gemini 图像协议转换、压缩请求/响应、单模型详情查询、模型目录自动拉取、桌面 UI/开机启动/隧道托管。** 不支持的接口明确拒绝。不能直接用此 beta 完整替换正式版，也没有声称达到企业生产认证。

设计参考：[Go HTTP streaming](https://pkg.go.dev/net/http)、[Redis Pub/Sub 的 at-most-once 语义](https://redis.io/docs/latest/develop/use-cases/pub-sub/)、[官方 go-redis](https://github.com/redis/go-redis)。依赖版本与校验和固定在 go.mod/go.sum，许可证见 THIRD_PARTY_NOTICES.md。
