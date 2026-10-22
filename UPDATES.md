# 桌面更新与发布

主线从 0.3.13 起提供「设置 → 外观」下方的「更新」。点击「检测更新」，有新版本时出现「下载并更新」。下载完成并校验通过后，程序停止连接、安装更新并重启；原来正在运行的连接会尝试恢复。更新期间请求会中断，建议空闲时操作。未保存的编辑会阻止安装，保存后点击「立即更新」即可，无需重新下载。

三种包使用同一 GitHub Releases 仓库：`telecom888/ScrollBridge--EasyCLIProxyAPI`。不需要自建服务器，使用者不需要 GitHub 令牌。程序使用 Electron 的系统代理网络栈；匿名 API 请求受限时，会改从 GitHub 最新 Release 下载清单检测。没有发布版本或网络失败时会显示状态，保留当前程序。

| 当前程序形式 | 下载文件 | 安装方式 |
| --- | --- | --- |
| ZIP 解压文件夹 | `ScrollBridge-版本-win-x64.zip` | 更新原文件夹中的程序文件，保留配置及其他用户文件 |
| 安装版 | `ScrollBridge-Setup-版本-win-x64.exe` | 以当前用户静默安装到原目录 |
| 单 EXE | `ScrollBridge-版本-win-x64.exe` | 替换原 EXE，保留用户修改过的文件名 |

配置仍是原 EXE 同目录的 `scrollbridge.json`。更新助手备份并恢复原配置字节，不重新生成密钥。下载和临时回退文件保存在当前用户的 ScrollBridge 数据目录 `updates/任务ID/`；成功后删除下载包与备份，留下任务与结果记录。新程序必须完成配置加载、窗口初始化并确认版本，助手才确认更新成功；安装或启动失败时尝试恢复旧程序和配置。无法自动恢复时可从该任务目录中的 `backup/` 与 `configuration.saved` 手动恢复，结果见 `result.json`。

ZIP 更新只处理打包时登记的程序文件；更新包不能携带根目录配置文件，路径穿越、重复路径和符号链接会被拒绝。安装前再次验证大小和 SHA-256。校验清单通过 GitHub HTTPS 获取，它能检查传输完整性；没有单独的离线发布签名，GitHub 仓库维护权限仍是发布信任边界。

## 发布新版本

本地 `origin` 已配置为 `https://github.com/telecom888/ScrollBridge--EasyCLIProxyAPI.git`。当前远程尚无可用 Release 时，界面显示「仓库尚未发布更新」。0.3.12 及更早版本没有此更新入口，第一次需手动换为 0.3.13 或更新版本。

仓库包含 `.github/workflows/release.yml`：在源码和工作流提交到远程后，推送与 `package.json` 对应的 `v主.次.补丁` 标签，GitHub Actions 会在 Windows 上运行检查、测试并构建三个包，创建 Release 并上传下列五个文件：

- `ScrollBridge-版本-win-x64.zip`
- `ScrollBridge-Setup-版本-win-x64.exe`
- `ScrollBridge-版本-win-x64.exe`
- `SHA256SUMS-版本.txt`
- `scrollbridge-update.json`

也可本地执行 `npm ci`、`npm run vendor`、`npm run dist`，再把 `release/` 中对应的五个文件一起上传至该版本的正式 Release。不要只上传 EXE；缺少清单或对应包时客户端不会安装。只检测正式稳定版本，不检测草稿和预发布版本。发布资产上传完整前，检测可能短暂提示「发布包或校验信息不完整」，稍后重试即可。

更新代码、远程配置和构建完成，不等于已推送源码或发布版本；发布是独立操作。

## 验证

- `npm run dist`：语法、86 项 Node 测试、Go 原生测试、12 项跨实现协议测试、三个包和校验清单。
- `node scripts/update-worker-smoke.cjs`：Windows 实际文件替换，覆盖 EXE、ZIP、恶意 ZIP、安装失败和启动失败回退，验证配置不变。
- `node scripts/update-desktop-smoke.cjs`：在隔离目录使用真实安装包，替换检测版本和 Release 传输为本机夹具，通过桌面按钮完成三种包的下载、校验、安装、重启与配置保留。不会访问个人凭据或真实模型服务；存在真实安装版时拒绝覆盖。

真实 GitHub 发布后的公网下载仍需用完整 Release 验证；本地夹具测试不会创建公开版本。
