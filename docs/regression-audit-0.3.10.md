# 回归测试检查（2026-10-22）

结论：快速用例没有发现可直接整项删除的等价重复。主要冗余和过时假设集中在手动桌面脚本，不能靠删掉安全边界测试来缩短执行时间。

## 当前范围

| 入口 | 范围 | 说明 |
| --- | --- | --- |
| `npm test` | 76 项 | 43 项配置、策略、工具等检查，21 项 Node 网关检查，12 项共用协议契约（默认运行在 Node 网关） |
| `npm run test:go` | 41 项 Go 原生测试和 12 项共用协议契约 | 会重新编译桌面 Go 核心，契约通过子进程桥接调用该核心 |
| `scripts/*smoke.cjs` | 18 个文件入口 | 独立手动桌面/打包检查，不包含在上述 76 项中；其中 portable-smoke 现为别名 |

计数为顶层用例或文件数，不是漏洞数，也不是每一个断言的数量。旧的 VALIDATION.md 是历史验证记录，不能当作当前发布的测试清单。

## 本次清理

| 问题 | 处理 |
| --- | --- |
| portable-smoke 与 portable-location 重复启动、检查标记 | 合并到 portable-location；保留 portable-smoke 作为命令别名，不需要执行两次。统一检查真实 portable 标记、配置位置和重命名后凭据不变 |
| portable-location 和 startup-error 仍硬编码格式版本 2 | 改为读取 SETTINGS_VERSION，避免版本 3 配置误报 |
| desktop-gateway 仍操作隐藏的费用表单，并断言 Go 名称带 beta | 移除失效的费用 UI 步骤；验证当前版本号。后端费用计算、usage 开关测试保留 |
| portable-duplicate 查找不存在的 -beta 文件，主线漏查 Go 核心文件 | 默认检查当前 Go 便携版及其核心资源；--both 才检查 -node 版 |
| desktop-gateway、management-api 默认每次启动两种网关 | 默认只测 Go；可传 node 或 --both。保留有需要时的历史版验证能力 |
| profile-upgrade 默认在两个版本间反复启动四次 | 默认对当前 Go 版启动两次；--both 保留跨版本切换检查 |

本次未改变业务代码、配置文件或发布 exe，也没有删除快速测试用例。

## 看似相近但应保留

| 组合 | 为什么不是等价重复 |
| --- | --- |
| model-refresh 单元测试、multi-key HTTP 契约、model-refresh 桌面检查 | 分别验证策略计算、运行中撤权真正生效、UI 与持久化状态同步 |
| 普通 SSE、别名压缩 SSE、Go 原生 SSE | 直通、解压/改写、不同实现的取消与结束处理是不同路径 |
| 原模型 multipart、别名 multipart、Gemini 图像编辑 | 分别验证原始字节透传、仅替换模型字段、协议与图像数据转换 |
| store、portable-secrets、portable-location | 分别验证文件/密码学行为、全新 Electron profile 读取、真实自解压 exe 的目录选择 |
| 原生 Go 测试与 12 项桥接契约 | 前者无法覆盖 JavaScript 配置转换、IPC 子进程控制和桌面回调 |
| management-api 单元检查与桌面检查 | 前者用调用替身验证 HTTP 安全边界；后者验证请求确实改变桌面状态和网关策略 |
| 隐藏的费用 UI 与后端费用测试 | 暂停 UI 设计不等于移除后台功能；不能据此删除计费正确性与隐私检查 |

## 后续执行建议

- 日常修改：语法检查、受影响的快速用例，以及相关的一个桌面脚本。
- Go 网关、权限或桥接修改：运行 test:go；不要只运行 npm test 就宣布 Go 主线通过。
- 发布：快速测试、Go 测试，按变更选择桌面检查，再跑真实便携版检查。
- 不把真实本机代理脚本 smoke.cjs、live-proxy.cjs 放进默认测试；它们依赖本机环境，后者会发实际模型请求。
- Node 专属的 21 项测试暂保留，测试 Node 旧版或共享转发辅助逻辑时再重点执行。其存在不要求每次启动 Node 桌面版。
- dist 路径已移除第二次核心编译：test:go 编译核心并完成桥接契约测试，随后通过 --skip-core-build 直接打包该核心和同次生成的许可证。单独执行 dist:go、dist:both 或 build-desktop go 仍会自动编译；缺少核心或许可证时复用模式直接报错，不静默打包不完整资源。

## 本次验证

修正后的 startup-error、desktop-gateway（Go）、management-api（Go）、profile-upgrade（Go）、portable-smoke 别名/portable-location、portable-duplicate（Go）分别验证。全部使用隔离配置；桌面网关和管理 API 使用模拟上游。真实便携版检查使用已生成的 0.3.10 exe 副本，不修改 release 中的业务配置。

Go 的 41 项数量通过 go test -list 清点，本次没有因为修改测试脚本而重跑原生 Go 全套或高并发压力测试。

### 后续：发布流程去除重复编译

实际执行优化后的 npm run dist：76 项快速测试、Go 原生测试（缓存命中）和 12 项 Go 桥接契约通过。日志只有一次正式核心构建，之后进入复用分支；打包目录中的核心 SHA-256 与 vendor 中刚测试的核心一致。便携 exe 已生成，最后复制到 release 时因同名 0.3.10 程序正在运行而返回 EBUSY，未关闭现有程序。构建结果保留在 `.test-output/desktop-go-1792647154999/`；不能把此次命令描述为退出码成功。
