# opencode-free-gate

使用 Go 实现的 OpenCode 免费模型反代网关。网关从公共代理池选取可用代理，并支持按请求轮换 HTTP、HTTPS、SOCKS5/SOCKS5H 代理。

## 关键特性

- 每次代理尝试使用独立的 `http.Transport`，不共享故障连接。
- 流式请求默认 3 秒内拿不到响应头就取消当前尝试，整个代理链共享 10 秒总预算。
- 非流式请求不限制响应首字节，允许完整响应在默认 300 秒内结束。
- 流式请求在成功取得响应头后可继续传输；客户端断开或流长时间无数据时自动清理连接。
- 普通业务 `400/404/422` 直接返回，不再无意义地轮换代理。
- 支持公共 S 级代理、自定义代理和 ZenProxy relay 多级回退，回退顺序可通过 `PROXY_ORDER` 自定义。
- 上游请求携带完整 OpenCode 客户端头：真实 `User-Agent`、`x-opencode-client`、稳定会话哈希 `x-opencode-session`、每请求唯一 `x-opencode-request`（同一请求的代理重试保持不变）与 `x-opencode-project`。
- `/v1/messages` 与真实 OpenCode 客户端一致，使用 `x-api-key` 认证并自动补齐 `anthropic-version`。
- 同一会话优先固定同一代理出口（rendezvous 哈希亲和），减少匿名通道按出口 IP 限流带来的抖动；出口故障时自动回退到其他槽位。
- 保留原有 Docker 镜像名、端口、路由和环境变量。

## API 路由

| 客户端类型 | 路由 |
|---|---|
| OpenAI | `/openai/v1/models`、`/openai/v1/chat/completions` |
| Anthropic | `/anthropic/v1/messages` |
| Codex | `/codex/v1/responses` |
| 健康检查 | `/healthz` |

模型列表每 60 秒从 OpenCode 上游刷新一次，仅展示 `-free` 模型，并额外保留 `big-pickle`。请求中的展示名称会自动改回上游模型名称。

## 会话 ID

网关为每个上游请求生成 OpenCode 协议要求的标识头，客户端无需自行构造：

- 优先使用客户端提供的 `x-opencode-session`、`x-session-id`、`conversation-id`、请求体 `conversation_id` 或 `metadata.session_id` 派生会话 ID。
- 没有显式会话标识时，使用第一条用户消息（Responses 请求使用 `input` 或 `previous_response_id`）生成稳定会话哈希，同一段多轮对话始终映射到同一会话与同一代理出口。
- 两个独立会话的第一条消息完全相同时，建议客户端发送不同的 `x-session-id` 以严格分离。
- `x-opencode-request` 每个客户端请求重新生成，同一请求内的代理重试保持不变。

## Docker 部署

```bash
docker compose up -d
```

或直接运行镜像：

```bash
docker run -d \
  --name opencode-free-gate \
  --restart unless-stopped \
  -p 13339:13339 \
  -e PORT=13339 \
  -e PROXY_MODE=auto \
  ghcr.io/guji08233/opencode-free-gate:latest
```

从 Bun 版本升级时，无需修改现有生产环境变量或 Caddy 路由，只需发布并拉取新的同名镜像。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | `13339` | HTTP 监听端口 |
| `PROXY_MODE` | `auto` | `auto` 使用完整回退链；`custom` 从自定义代理开始 |
| `PROXY_ORDER` | 空 | 逗号分隔的回退顺序，取值 `public`、`zen`、`custom`（如 `custom,zen,public`）；设置后覆盖 `PROXY_MODE` 的默认顺序，省略的层会被跳过，直连始终作为最后兜底 |
| `SLOT_COUNT` | `5` | 公共代理槽位数，限制为 3–5；并发请求从不同槽位轮询开始 |
| `SLOT_RETRIES` | 槽位数 | 单请求最多尝试的公共代理数 |
| `CUSTOM_PROXIES` | 空 | 逗号分隔的代理 URL，支持 HTTP、HTTPS、SOCKS5/SOCKS5H |
| `CUSTOM_RETRIES` | `10` | 自定义代理重试数；`0` 表示按代理数量轮询一轮 |
| `ZENPROXY_RELAY` | `https://zenproxy.top/api/relay` | ZenProxy relay 地址 |
| `ZENPROXY_KEY` | 空 | ZenProxy API key；为空时跳过该层 |
| `ZENPROXY_RETRIES` | `5` | ZenProxy 尝试次数 |
| `FORCE_RELAY` | `0` | `1` 表示强制只走 ZenProxy |
| `PROXY_PROBE_TIMEOUT` | `8000` | 代理探活超时，毫秒 |
| `PROXY_REFRESH_MS` | `300000` | 公共候选池刷新间隔，毫秒 |
| `PROXY_FIRST_BYTE_TIMEOUT` | `3000` | 流式请求单次尝试取得响应头的最大时间，毫秒 |
| `HARD_TIMEOUT` | `10000` | 流式请求选择和重试链的总预算，毫秒 |
| `NON_STREAM_TIMEOUT` | `300000` | 非流式请求从进入网关到完整响应结束的最高时间，毫秒 |
| `TZ` | 系统默认 | 容器时区；镜像已包含 `tzdata` |

当前生产使用的 `CUSTOM_PROXIES`、重试次数和 ZenProxy 配置均可原样沿用。

## 重试规则

- 网络错误、连接/握手/首字节超时：关闭当前连接并切换代理。
- `401`、`403`、`408`、`425`、`429`、`5xx`：立即切换下一次尝试，不等待退避。
- 默认顺序为公共代理 5 次、ZenProxy 5 次、自定义代理 10 次，最后直连 1 次；`PROXY_ORDER` 可调整前三层的顺序或省略某些层，直连始终最后兜底。
- 代理层返回的 `429` 不会提前返回客户端；完成全部代理重试后，最终直连仍为 `429` 时才原样返回。
- 其他 `4xx`：视为业务请求错误，立即返回客户端。
- 流式总预算或非流式最高时间耗尽：返回 `504`，并取消仍在进行的底层请求。

## 本地开发

需要 Go 1.24 或更高版本：

```bash
go test ./...
PROXY_MODE=custom go run .
```

构建容器镜像：

```bash
docker build -t opencode-free-gate:local .
```

测试包含一个会接受 TCP 连接但永不返回数据的本地假代理，用于验证超时后连接确实被关闭。
