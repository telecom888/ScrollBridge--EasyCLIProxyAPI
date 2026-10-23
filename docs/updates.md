# 更新与发布

## 程序内更新

「设置」的更新区域位于「外观」下方。点击「检测更新」后显示当前版本、可用版本和更新日志；发现完整的新稳定版本时提供下载按钮。来源可选 GitHub 和默认的 GitHub 镜像（gh-proxy），不使用 GitCode，无需自建更新服务器或向使用者分发 GitHub 令牌。

更新只请求本仓库的公开资源，不向镜像发送账户凭据。网络请求沿用系统代理设置，不修改路由或虚拟网卡。匿名 GitHub API 受限时，程序会尝试公开的最新更新清单。

| 当前形式 | 对应下载包 | 安装方式 |
| --- | --- | --- |
| ZIP 文件夹版 | `ScrollBridge-版本-win-x64.zip` | 替换登记的程序文件，保留配置及其他用户文件 |
| 安装版 | `ScrollBridge-Setup-版本-win-x64.exe` | 以当前用户静默安装到原目录 |
| 单 exe | `ScrollBridge-版本-win-x64.exe` | 替换原 exe，保留用户修改后的文件名 |

下载完成并校验后，程序停止连接、更新并重启；此前运行的连接会尝试恢复。更新会中断请求，建议在空闲时操作。未保存的编辑会阻止安装，保存后可继续，无需重新下载已验证的包。

## 签名与配置保留

`scrollbridge-update.json` 包含版本、更新日志、三个包的大小及 SHA-256，并使用 Ed25519 签名。桌面内置 `lib/update-public-key.pem` 验证签名；安装前再次检查下载文件。独立的 `SHA256SUMS` 文本不再生成或上传，GitHub 发布页仍显示附件摘要。

签名清单与 Windows 可执行文件代码签名相互独立。镜像只分发文件，不能为已安装程序签发新的有效清单。

业务配置仍为主程序同目录的 `scrollbridge.json`。更新助手备份并恢复原配置字节，不重新生成访问密钥；ZIP 包不能携带根目录业务配置，路径穿越、重复路径和符号链接会被拒绝。

任务及临时回退文件位于当前用户 ScrollBridge 数据目录的 `updates/任务ID/`。新程序完成配置加载、窗口初始化并确认版本后才算更新成功；失败时尝试恢复旧程序和配置。无法自动恢复时，可查看任务目录的 `result.json`，并从 `backup/` 和 `configuration.saved` 恢复。成功后删除下载包和备份，保留任务结果。

## GitHub Actions 发布

仓库为 `telecom888/ScrollBridge--EasyCLIProxyAPI`，工作流为 [release.yml](../.github/workflows/release.yml)。

1. 更新 `package.json` 和 `package-lock.json` 的版本号。
2. 添加 `docs/releases/<版本>.md`，提交源码和说明。
3. 推送与版本一致的 `v主.次.补丁` 标签，也可对已有版本标签手动触发工作流。
4. Actions 在 Windows 上测试、构建、验证桌面行为，并直接创建 Release、上传附件，不需要先下载到本机再上传。

发布包含四个文件：三种发行包和 `scrollbridge-update.json`。不要只上传 exe；缺少完整清单或对应包时，客户端不会安装。草稿和预发布版本不作为稳定更新。资产尚在上传时，更新检测可能暂时提示不完整。

仓库 Secret `SCROLLBRIDGE_UPDATE_SIGNING_KEY` 保存更新签名私钥。私钥不得提交 Git，且不能每次构建都重新生成；已有客户端需要用内置公钥验证后续版本。缺失或不匹配时构建会失败。

需要本地构建时运行 `npm ci`、`npm run vendor`、`npm run dist`。签名私钥可通过同名环境变量提供，或读取 `%LOCALAPPDATA%\ScrollBridge-Release\update-signing-private.pem`。本地构建不自动发布；通常优先采用 Actions。

## 验证

发布流程执行快速测试、Go 测试和三种包构建，再验证 Windows 文件替换及回退、开机启动、重启窗口可见、请求记录和隧道网络恢复。按变更补充的检查见 [测试指南](testing.md)。

发布完成后可检查附件大小、摘要、签名和程序内更新检测。独立测试环境的成功不能代替真实发布资源的完整性验证。
