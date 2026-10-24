# 测试指南

## 按变更选择

| 变更 | 首先执行 | 按需补充 |
| --- | --- | --- |
| 文案、文档、静态界面 | `npm run check`，检查相对链接和资源引用 | 对应页面的桌面检查 |
| 配置、密钥、权限、管理 API | `npm test` | 相关桌面脚本；影响 Go 策略时运行 `npm run test:go` |
| Go 网关、协议、桥接 | `npm run test:go` | `go vet ./...`、相关桌面检查 |
| 更新、配置位置、启动、打包 | `npm run dist` | 下方发布及分发检查 |
| 隧道恢复 | `node --test tests/tunnel.test.cjs` | `node scripts/tunnel-recovery-smoke.cjs` |

`npm test` 默认含历史 Node 网关和共用协议契约，不能代替 Go 主线测试。`npm run test:go` 运行 Go 原生测试、编译桌面核心，再通过真实子进程执行共用协议契约。

`npm run dist` 已包含语法、Node 和 Go 检查，随后复用刚验证的 Go 二进制及许可证打包，不必提前再跑一遍相同完整流程。单独使用 `dist:go` 或构建脚本时仍会编译核心。

## 桌面与发布检查

以下命令在项目根目录运行，通常使用隔离配置和模拟上游：

| 脚本 | 范围 |
| --- | --- |
| `desktop-gateway-smoke.cjs go` | 桌面、真实 Go 子进程、日志增量刷新、生命周期 |
| `management-api-smoke.cjs` | 本机管理 API 与 UI/网关状态同步 |
| `request-records-smoke.cjs` | IP、正文显示、黑名单、保留数量、分页、导出和重启清空 |
| `overlays-smoke.cjs` | 弹窗进退场、快速重开、焦点恢复、内容高度及菜单展开 |
| `tunnel-recovery-smoke.cjs` | 真实隧道替身进程、连续网络切换、网关保留、停止取消重试 |
| `model-refresh-smoke.cjs` | 模型刷新、下架、恢复、删除及持久化 |
| `multi-key-smoke.cjs` | 密钥、权限、别名与重启恢复 |
| `settings-lock-smoke.cjs` | 运行时连接配置锁定及提示 |
| `update-worker-smoke.cjs` | Windows 文件替换、恶意 ZIP 拒绝、安装和启动失败回退 |
| `startup-smoke.cjs` | 隔离启动项注册、禁用和异常处理 |
| `update-window-smoke.cjs` | 更新重启后的窗口可见及确认 |
| `distribution-smoke.cjs` | 三种实际包的启动、配置位置、安装覆盖与卸载 |
| `update-desktop-smoke.cjs` | 从桌面按钮完成三种包的模拟更新流程 |
| `profile-upgrade-smoke.cjs` | 重复启动、单实例、配置与密钥保留 |
| `portable-location-smoke.cjs` | 便携 exe 复制、重命名和真实配置位置 |
| `portable-duplicate-smoke.cjs` | 同版便携程序重复启动时不破坏在用资源 |
| `startup-error-smoke.cjs` | 配置加载失败不覆盖原文件、错误报告不泄露凭据 |

执行方式为 `node scripts/脚本名`。默认优先验证 Go；历史 Node 或双版本检查只在相关变更时显式选择。`portable-smoke.cjs` 是位置检查的别名，不必与 `portable-location-smoke.cjs` 重复执行。

有的分发脚本需要先构建实际安装包，检测到已有真实安装时会拒绝覆盖。测试产物放在忽略的 `.test-output/`。在线发布工作流实际执行范围以 [release.yml](../.github/workflows/release.yml) 为准。

## 避免重复与误判

策略单元测试、HTTP/桥接契约和桌面检查分别覆盖策略计算、运行时执行、UI 与持久化，不能简单按名称合并。普通 SSE、别名改写、压缩、multipart 和各协议的结束处理也属于不同路径。

日常运行受影响的快速用例及一个相关桌面检查；测试通过后，没有新改动或未决问题时，不重复运行相同检查。发布流程一次完成必要门禁，不默认重跑高并发压测。

`smoke.cjs`、`live-proxy.cjs` 依赖本机真实代理，后者会发出实际模型请求，不进入默认测试。真实网络、供应商能力、性能和长时间稳定性需要单独定义测试范围；旧报告中的数量、覆盖率和漏洞扫描结果不代表当前版本。
