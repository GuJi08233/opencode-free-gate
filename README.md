# opencode-free-gate

使用 Go 实现的 OpenCode 免费模型反代网关。网关从公共代理池选取可用代理，并支持按请求轮换 HTTP、HTTPS、SOCKS5/SOCKS5H 代理。

## 关键特性

- 每次代理尝试使用独立的 `http.Transport`，不共享故障连接。
- 默认 3 秒内拿不到响应头就取消请求上下文，底层 TCP 连接会被关闭。
- 整个代理选择与重试链共享 10 秒总预算。
- 流式请求在成功取得响应头后可继续传输；客户端断开或流长时间无数据时自动清理连接。
- 普通业务 `400/404/422` 直接返回，不再无意义地轮换代理。
- 支持公共 S 级代理、自定义代理和 ZenProxy relay 多级回退。
- 保留原有 Docker 镜像名、端口、路由和环境变量。

## API 路由

| 客户端类型 | 路由 |
|---|---|
| OpenAI | `/openai/v1/models`、`/openai/v1/chat/completions` |
| Anthropic | `/anthropic/v1/messages` |
| Codex | `/codex/v1/responses` |
| 健康检查 | `/healthz` |

模型列表每 60 秒从 OpenCode 上游刷新一次，仅展示 `-free` 模型，并额外保留 `big-pickle`。请求中的展示名称会自动改回上游模型名称。

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
| `PROXY_FIRST_BYTE_TIMEOUT` | `3000` | 单次尝试取得响应头的最大时间，毫秒 |
| `HARD_TIMEOUT` | `10000` | 整个选择和重试链的总预算，毫秒 |
| `TZ` | 系统默认 | 容器时区；镜像已包含 `tzdata` |

当前生产使用的 `CUSTOM_PROXIES`、重试次数和 ZenProxy 配置均可原样沿用。

## 重试规则

- 网络错误、连接/握手/首字节超时：关闭当前连接并切换代理。
- `401`、`403`、`408`、`425`、`429`、`5xx`：立即切换下一次尝试，不等待退避。
- 默认顺序为公共代理 5 次、ZenProxy 5 次、自定义代理 10 次，最后直连 1 次。
- 代理层返回的 `429` 不会提前返回客户端；完成全部代理重试后，最终直连仍为 `429` 时才原样返回。
- 其他 `4xx`：视为业务请求错误，立即返回客户端。
- 总预算耗尽：返回 `504`，并取消仍在进行的底层请求。

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
