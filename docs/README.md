# 文档目录

## 使用和运维

- [项目说明与快速开始](../README.md)：安装、连接、域名、权限和配置位置。
- [请求记录](request-logs.md)：IP、黑名单、正文预览、保留数量和导出。
- [语音接口](speech-interface.md)：请求参数、适配方式与本地代理要求。
- [隧道恢复](tunnel-recovery.md)：网络切换、重连时限和停止行为。
- [更新与发布](updates.md)：三种包的升级、签名及 GitHub Actions。

## 开发与自动化

- [本机管理 API](management-api.md)：接口发现、配置、连接、日志、密钥和模型操作。
- [测试指南](testing.md)：快速测试、Go 桥接、桌面与发布验证。
- [独立 Go 核心](../beta/go-gateway/README.md)：命令行配置、策略、可选 Redis、额度和审计。
- [第三方许可](../THIRD_PARTY_NOTICES.md)及 [Go 核心依赖许可](../beta/go-gateway/THIRD_PARTY_NOTICES.md)。

## 版本与历史资料

- [版本记录](releases/README.md)：每个版本的发布说明，也用于生成签名更新清单。
- [首次 Go 核心性能报告](../beta/go-gateway/REPORT.md)：固定历史版本的原始测量，不代表当前版本性能。
- [早期 UI 参考提示词](../design/ui-review-20261021/prompts.md)：设计参考资料，不是当前产品规范。

当前使用说明不再保留逐次审查结果和已废弃的迁移步骤；历史变更可通过 Git 记录查看。新增功能应更新对应专题，版本变更另写入发布说明。
