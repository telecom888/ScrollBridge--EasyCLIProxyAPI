# 卷桥本机管理 API

Go 主线桌面程序运行时自动提供。API 与 UI 共用配置、运行状态和操作锁；仅监听 `127.0.0.1`，不接入公网隧道。

## 大模型代理的操作约定

1. 先启动桌面程序。读取当前 Windows 用户的 `%APPDATA%\ScrollBridge\management.json`，获取 `baseUrl` 和 `token`。不打印或提交这个文件的内容。
2. 请求携带 `Authorization: Bearer <token>`，先读取 `GET /api/v1/schema`，查询操作目录和参数。
3. 普通查询不返回完整密钥。只有用户确实需要时才调用 `reveal`，不要把返回的密钥写入日志或 Git。
4. `connection/start` 返回 202 表示启动流程已接受，须轮询 `/status`，直到 `status` 为 `connected` 或 `error`。长期停在 `starting` 时读取隧道日志；停止连接后才能修改连接参数。
5. 遇到 `409 BUSY` 等待当前操作完成再重试。不要盲目重复创建、重置或删除密钥等操作。配置落盘后若网关更新失败，连接会停止，应重新读取配置和状态确认结果。
6. 公网检测会发送一次短文本模型请求，可能消耗上游额度。重置密钥、删除及权限修改应按用户实际指令执行。

每次启动使用新的端口和管理令牌，退出时清除发现文件。不要缓存上一次的管理入口。发现文件保存在当前用户的运行目录；业务配置仍保存在 exe 同目录的 `scrollbridge.json`。窗口缩入托盘后，只要程序仍在运行，API 就仍然可用。

## 调用示例

在项目目录使用辅助脚本，它会自动读取发现文件，避免在命令中填写管理令牌：

```powershell
node scripts/control.cjs GET /schema
node scripts/control.cjs GET /status
node scripts/control.cjs GET "/logs?kind=tunnel&limit=30"
node scripts/control.cjs POST /connection/stop
'{"config":{"protocol":"http2"}}' | node scripts/control.cjs PATCH /config --stdin
node scripts/control.cjs POST /connection/start
node scripts/control.cjs GET /status
node scripts/control.cjs POST /models/refresh
node scripts/control.cjs GET /models
```

脚本输出一行 JSON。HTTP 成功退出码为 0；API 或客户端错误为 1，用法错误为 2。检测已执行但不通过时，仍须检查 `data.ok`，不能只看退出码。测试环境可通过 `SCROLLBRIDGE_DISCOVERY` 指定隔离发现文件。

也可以直接通过 PowerShell、Python 等 HTTP 客户端调用：

```powershell
$bridge = Get-Content -LiteralPath "$env:APPDATA\ScrollBridge\management.json" -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($bridge.token)" }
Invoke-RestMethod -Uri "$($bridge.baseUrl)/api/v1/status" -Headers $headers
```

管理令牌与客户端模型调用密钥相互独立，不要将管理令牌传给公网模型服务。

## 接口目录

以下路径均以 `/api/v1` 开头。正文使用 `application/json`，上限 1 MiB；`schema` 接口列出参数提示及可写配置字段。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/schema` | 读取动态接口说明 |
| GET | `/status` | 连接状态、版本、网关状态及最近检测结果 |
| GET / PATCH | `/config` | 读取或保存配置，不返回完整密钥 |
| GET | `/logs?kind=requests&limit=100` | 请求记录；`kind=tunnel` 为隧道日志，limit 为 1–200 |
| DELETE | `/logs` | 清空本次运行的请求和隧道日志 |
| POST | `/connection/start`、`/connection/stop` | 启动或停止连接 |
| POST | `/diagnostics/local`、`/diagnostics/public` | 检测本地代理或公网完整请求 |
| GET | `/models` | 实际模型、规则、对外条目、全局关闭项及更新时间 |
| POST | `/models/refresh` | 刷新模型列表和下架状态 |
| PUT | `/models/access` | `{ "model": "实际模型ID", "enabled": true }` |
| PUT | `/models/aliases` | `{ "id": "规则ID", "aliases": [{ "name": "chat" }], "keepOriginal": false }` |
| DELETE | `/models/{id}` | 删除已下架模型规则及关联配置 |
| GET / POST | `/keys` | 列出或创建密钥，返回元数据和掩码 |
| PUT / DELETE | `/keys/{id}` | 编辑或删除密钥 |
| POST | `/keys/{id}/rotate` | 重置密钥，旧值立即失效，返回新掩码 |
| POST | `/keys/{id}/reveal` | 显式读取完整密钥 `{id,value}` |

创建密钥示例：

```json
{"name":"手机","enabled":true,"mode":"all","allowed":[],"concurrent":3,"requestLimit":100,"requestWindowSeconds":7200}
```

`concurrent:0` 关闭该密钥并发限制；`requestLimit:0` 关闭周期限额。`requestWindowSeconds` 为 60–31536000 秒，桌面按分钟或小时设置。省略限制字段时，创建默认为关闭，编辑保留已有值。周期从首个有效模型请求开始，计数在当前网关进程内保存；热更新保留计数，停止并重启连接后重新计数。模型请求通过鉴权、模型权限及正文校验后计数，上游失败仍计数；健康检测、模型列表及限流拒绝不计入；公网检测中的实际模型生成请求会计数。HTTP 请求及 WebSocket 每次生成共享该密钥的限额，WS 空闲连接不占生成并发名额。

日志查询省略 `keyId` 返回全部；单个密钥用 `/logs?keyId=内部ID`，多个密钥重复参数 `/logs?keyId=ID1&keyId=ID2`。先筛选再取 `limit` 条，按内部 ID 匹配，重命名或删除密钥不影响保留记录的筛选。没有通过鉴权的请求无法归属某个密钥，仅出现在全部查询中。

修改密钥需填写 `name`。`mode` 为 `selected` 时，`allowed` 填写 `/models` 中的 `entries[].id`，不是模型名称；全局权限始终优先。编辑别名时保留原条目的 `id`，可保留已有授权；省略 `id` 表示新建别名。

配置修改示例：

```json
{"config":{"refreshModelsOnStartup":true,"modelRefreshMinutes":30}}
```

`upstreamKey` 和 `tunnelToken` 可作为与 `config` 同级的字段写入，请通过标准输入传递，避免进入命令历史。留空保持原值；`clearUpstreamKey:true` 显式清除本地代理密钥。内部派生字段如 `knownModels`、`accessKeys` 不能通过配置接口覆盖，应使用模型或密钥接口。

## 返回结果

成功：

```json
{"ok":true,"data":{"status":"connected","gatewayRunning":true}}
```

失败：

```json
{"ok":false,"error":{"code":"BUSY","message":"请等待当前操作完成"}}
```

错误：`401 UNAUTHORIZED` 管理令牌无效；`403 FORBIDDEN_ORIGIN` 来源或 Host 不符合本机调用要求；`404 NOT_FOUND` 接口不存在；`409 BUSY` 操作冲突；`400 INVALID_ARGUMENT/INVALID_JSON/OPERATION_FAILED` 参数或业务操作失败。

日志只保留当前运行的最近 200 条请求及 100 条隧道日志。接口不提供任意文件读取、系统命令执行、剪贴板操作、文件选择弹窗或 Cloudflare 账户创建/绑定。当前版本须先启动桌面程序，不包含 exe 命令参数或独立后台服务。
