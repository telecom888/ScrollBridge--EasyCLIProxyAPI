# 语音接口

在“设置 → 接口”第三项启用“语音接口”，客户端调用 `POST /v1/audio/speech`。默认关闭，沿用客户端密钥、模型别名、全局和单 key 模型权限、请求数量与并发限制。模型别名先解析为真实模型，之后根据真实模型 ID 的品牌或语音关键词选择协议，不维护固定型号名单。

请求包含 `model`、`input`、`voice`，可指定 `response_format`、`speed`、`instructions`、`stream_format`。`input` 最多 4096 个字符，各提供商可能另有更严格限制。默认输出 mp3；不支持该格式的协议会返回明确错误，请显式选择 wav 或 pcm。自定义 voice 对象仅由标准接口透传。原始语音输出请求也受开关控制，音频输入本身不受影响。

| 协议 | 本地代理路径 | 输出方式与限制 |
| --- | --- | --- |
| 标准语音 | `/v1/audio/speech` | 音频流透传；支持提供方的 speech SSE |
| 对话音频 | `/v1/chat/completions` | 解码消息音频；流式 pcm16，非流式 mp3/wav |
| 内容音频 | `/v1beta/models/{model}:generateContent` | 24 kHz 单声道 PCM 或 WAV；区分旧语音配置与新版样式元数据 |
| 十六进制音频 | `/v1/t2a_v2` | 非流式内联音频，mp3/wav/flac/pcm |
| 资源语音 | `/api/v3/tts/unidirectional/sse` | 解码 SSE 音频，真实模型 ID 作为资源 ID；wav 从 PCM 封装 |
| 多模态音频 | `/api/v1/services/aigc/multimodal-generation/generation` 或 `/api/v1/services/audio/tts/SpeechSynthesizer` | SSE 内联音频；格式支持随接口族变化 |

无法从 ID 判定时，可传扩展字段 `speech_protocol` 指定 `standard`、`chat-audio`、`content-audio`、`content-audio-legacy`、`hex-audio`、`resource-audio`、`multimodal-audio`。此字段不传递给上游。

这些路径必须由用户的本地代理支持。卷桥不直连云厂商、不增加厂商密钥配置、不跟随响应中的任意音频 URL。上游不提供原生路径时返回 501；只有 URL 没有音频数据的响应会明确失败。Go 主线执行转换；历史 Node 网关仅支持标准语音接口透传。

二进制音频和兼容的 PCM 流逐块转发并遵守背压、取消和输出大小限制；需要 WAV 长度头的转换先有限缓冲，再封装。业务错误、无音频、截断 SSE 不会伪装成成功。语音请求不适用文本输出 token 配额；计费设置仍保持隐藏，未改动。

测试使用本地模拟代理覆盖各协议、模型权限、别名、开关、音频解码、增量转发与截断错误。尚未使用真实厂商账户验证六种云服务。
