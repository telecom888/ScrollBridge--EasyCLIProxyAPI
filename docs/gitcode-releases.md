# GitCode 下载来源

源码、开发与构建均在 GitHub。GitCode 仅保存三个发行包、SHA256SUMS 和原始签名更新清单；发布脚本不执行 git push，发行标签指向 GitCode 自己的默认分支，不导入 GitHub 源码提交。

新配置默认选择 GitCode。已有配置保留用户选择，可在设置中切换 GitCode、GitHub、GitHub 镜像。三个发行包沿用相同 Ed25519 清单签名、文件大小和 SHA-256 校验；GitCode API 不提供附件大小时，使用已验证签名的清单数值。下载地址根据固定仓库、版本和文件名构造，不信任远端元数据中的任意下载 URL。

## 发布

在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 `GITCODE_TOKEN`，值为具有目标 GitCode 仓库 Release 管理权限的个人访问令牌。令牌仅供 GitHub Actions 使用，不进入桌面程序、安装包或更新清单。

`Windows release` 成功后，`Publish packages to GitCode` 下载已发布的 GitHub 附件并发布到 GitCode。可通过后者的 Run workflow 输入已有版本标签（例如 `v0.3.19`）补发历史版本。

先建立预发布版本，逐个上传五个附件，再匿名下载并校验全部字节，最后标为最新版。任一步失败均不提升为最新版。可重试预发布版本；已正式发布的版本拒绝覆盖。尚未提供令牌时发布任务会明确失败，GitHub 发布不受影响。

首次接入须验证真实附件上传及公开下载，并通过三个发行类型的更新检测；不能仅凭模拟测试宣称线上渠道已可用或速度优于 GitHub。GitCode 的上传服务使用 `file.gitcode.com`，公开下载经 `file-cdn.gitcode.com` 分发。

参考：[创建 Release](https://docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-releases/)、[附件上传](https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-tag-upload-url/)、[公开下载](https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-attach-files-file-name-download/)。
