# opencode-free-gate

[![Docker Image](https://img.shields.io/badge/ghcr.io-opencode--free--gate-blue?logo=docker)](https://github.com/GuJi08233/opencode-free-gate/pkgs/container/opencode-free-gate)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/GuJi08233/opencode-free-gate/docker-publish.yml?logo=github)](https://github.com/GuJi08233/opencode-free-gate/actions)

[opencode.ai/zen](https://opencode.ai) 免费模型的**自动代理反代网关**。

从公共代理池自动获取 S 级代理，请求失败自动切换，解除免费模型的额度/频率限制。  
同时兼容 **OpenAI** 和 **Anthropic** 两种 API 格式，任何客户端只需改 `base_url` 即可接入。

---

## 快速开始

### 方式一：Docker（推荐）

```bash
docker run -d --name opencode-gate \
  -p 13339:13339 \
  -e ZENPROXY_KEY=你的API_Key \
  --restart unless-stopped \
  ghcr.io/guji08233/opencode-free-gate:latest
```

镜像地址：`ghcr.io/guji08233/opencode-free-gate`（多架构支持 `linux/amd64` 和 `linux/arm64`）

### 方式二：从源码运行```bash
# 安装 Bun（如未安装）
curl -fsSL https://bun.sh/install | bash

# 克隆
git clone https://github.com/GuJi08233/opencode-free-gate.git
cd opencode-free-gate
bun install
bun run gate.ts

# 指定端口
PORT=8080 bun run gate.ts

# 启用 ZenProxy 备用通道（池子全挂时自动回退）
ZENPROXY_KEY=你的API_Key bun run gate.ts

# 调试：强制所有请求走 ZenProxy relay（跳过代理池）
FORCE_RELAY=1 ZENPROXY_KEY=你的API_Key bun run gate.ts
```

服务默认在 `http://localhost:13339` 启动。

### docker-compose

```yaml
# docker-compose.yml
services:
  opencode-gate:
    image: ghcr.io/guji08233/opencode-free-gate:latest
    container_name: opencode-gate
    restart: unless-stopped
    ports:
      - "13339:13339"
    environment:
      - PORT=13339
      - ZENPROXY_KEY=你的API_Key
      # 可选：强制走 ZenProxy relay（跳过代理池）
      # - FORCE_RELAY=0
      # 可选：自定义 relay 端点
      # - ZENPROXY_RELAY=https://zenproxy.top/api/relay
      # 可选：池配置
      # - POOL_SIZE=10
      # - MAX_CONCURRENT_PER_PROXY=3
      # - PROXY_FAILURE_THRESHOLD=3
      # - PROBE_CONCURRENCY=5
      # - BLACKLIST_TTL=600000
      # - SOFT_OVERFLOW_MAX=6
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:13339/openai/v1/models"]
      interval: 30s
      timeout: 10s
      retries: 3
```

```bash
docker compose up -d
```

在 [CC-switch](https://github.com/farion1231/cc-switch) 里配置给 Claude code 使用

 <img width="2339" height="1656" alt="shot-2026-06-02_16 20 43" src="https://github.com/user-attachments/assets/ac8464fa-52bf-4ecc-9419-2f8baa762c12" />




---

## 客户端配置

### OpenAI 格式

| 客户端 | 设置 |
|---|---|
| Python OpenAI SDK | `client = OpenAI(base_url="http://localhost:13339/openai/v1", api_key="你的KEY")` |
| curl | `curl http://localhost:13339/openai/v1/chat/completions -H 'Authorization: Bearer 你的KEY' -d '...'` |
| 任何 OpenAI 兼容客户端 | `base_url = http://localhost:13339/openai/v1` |

### Anthropic 格式

| 客户端 | 设置 |
|---|---|
| Python Anthropic SDK | `client = Anthropic(base_url="http://localhost:13339/anthropic", api_key="你的KEY")` |
| curl | `curl http://localhost:13339/anthropic/v1/messages -H 'Authorization: Bearer 你的KEY' -d '...'` |
| 任何 Anthropic 兼容客户端 | `base_url = http://localhost:13339/anthropic` |

### 查看可用模型

```bash
curl http://localhost:13339/openai/v1/models \
  -H 'Authorization: Bearer public'
```

---

## 部署到海外 VPS

中国大陆访问 `proxy.amux.ai` 不稳定，建议部署到海外（香港/日本/美国）VPS。

```bash
# 1. 在 VPS 上拉镜像
docker pull ghcr.io/guji08233/opencode-free-gate:latest

# 2. 后台运行
docker run -d --name opencode-gate \
  -p 13339:13339 \
  -e ZENPROXY_KEY=你的API_Key \
  --restart unless-stopped \
  ghcr.io/guji08233/opencode-free-gate:latest

# 3. 验证
curl http://your-vps-ip:13339/openai/v1/models

# 4. 更新镜像
docker pull ghcr.io/guji08233/opencode-free-gate:latest && \
docker restart opencode-gate
```

⚠️ **强烈建议配置 `ZENPROXY_KEY`** —— 备用通道在 Cloudflare 后面、且国内直连，比免费代理池快 10 倍。

---

## 架构

```
客户端 ──→ gate.ts (:13339) ──→ 代理池 ──→ opencode.ai/zen
                │
                ├── /openai/v1/*     → 转发到 /v1/* (OpenAI 格式)
                ├── /anthropic/v1/*  → 转发到 /v1/* (Anthropic 格式)
                ├── 多出口轮询       → POOL_SIZE=10 个 IP 并发轮询
                ├── 失败自愈         → 出错自动退役并探活补位
                └── ZenProxy fallback → 池耗尽时回退到 /api/relay
```

### 核心流程

1. **启动时**从 `proxy.amux.ai/api/proxies` 拉取 S 级免费代理（候选池），按延迟排序
2. **活跃池**：从中选 `POOL_SIZE=10` 个，并发探活（`GET /v1/models`）后入池
3. **轮询分发**：每个请求从活跃池轮询选一个未满代理，单代理最大并发 `MAX_CONCURRENT_PER_PROXY=3`
4. **失败处理**：
   - 代理连不上 / 5xx / 超时 → `penalize()` 累计连续失败
   - 连续 `PROXY_FAILURE_THRESHOLD=3` 次 → 标记为 `replacing`，在飞请求结束后彻底移除
   - 同时 `scheduleRefill()` 异步从候选池探活补位，始终保持 10 个活跃
   - 客户端重试（≤ `MAX_RETRIES=3` 轮）走不同代理
5. **每 5 分钟**自动刷新候选池，同时再次补位活跃池
6. **流式支持**：自动识别 `Accept: text/event-stream` 或 body 中的 `stream: true`，流结束/错误/取消时释放 busy 槽位（SSE 期间不独占代理），错误时记一笔失败
7. **并行探活**：新代理分批并行探测（`PROBE_CONCURRENCY=5`），加速池子填充

### 两层池设计

- **候选池（candidates）**：完整 S 级代理列表，每 5 分钟刷新一次，按延迟排序
- **活跃池（active）**：当前正在使用的 10 个出口 IP
- **黑名单（blacklist）**：已失败地址，带 TTL 过期（默认 10 分钟），过期后自动恢复可用
- **预热（probe）**：新代理先通过真实请求 `GET /v1/models` 验证可用才入池，支持并行探测

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `13339` | 监听端口 |
| `ZENPROXY_KEY` | 空 | 启用 ZenProxy 备用通道（[申请 Key](https://zenproxy.top)） |
| `ZENPROXY_RELAY` | `https://zenproxy.top/api/relay` | 自定义 relay 端点 |
| `FORCE_RELAY` | `0` | 设为 `1` 跳过代理池强制走 ZenProxy（调试用） |
| `POOL_SIZE` | `10` | 活跃池目标出口 IP 数（同时维持的并发出口数） |
| `MAX_CONCURRENT_PER_PROXY` | `3` | 单代理最大并发请求数（10×3=30 总在飞上限） |
| `PROXY_FAILURE_THRESHOLD` | `3` | 连续失败多少次后将该代理退役 |
| `PROXY_PROBE_TIMEOUT` | `8000` | 新代理探活超时（ms） |
| `PROXY_PROBE_PATH` | `/v1/models` | 探活路径（用于验证代理可用） |
| `PROXY_REFRESH_MS` | `300000` | 候选池刷新间隔（ms，默认 5 分钟） |
| `BLACKLIST_TTL` | `600000` | 黑名单过期时间（ms，默认 10 分钟，过期后代理自动恢复可用） |
| `SOFT_OVERFLOW_MAX` | `6` | 单代理软溢出上限（全部饱和时允许的最大并发数） |
| `PROBE_CONCURRENCY` | `5` | 并行探活数（同时探测多少个候选代理） |

### 关于 ZenProxy 备用通道

主路径（免费代理池）失败时，自动回退到 ZenProxy 的 `/api/relay` 转发。回退触发条件：

1. 启动时 `proxy.amux.ai` 拉不到代理
2. 池子里的代理全部进入黑名单
3. 连续 3 轮重试都失败

⚠️ 备用通道的 Authorization 处理：
- `KEY=public`（默认）时，会**剥离**客户端的 Authorization 头，避免占位 token 被 opencode 拒绝
- `KEY=自定义值` 时，会**用环境变量的 KEY 覆盖**客户端的 Authorization，保留有效 Key

---

## 依赖

- [hpagent](https://github.com/delvedor/hpagent) — HTTP CONNECT 代理隧道
- [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) — SOCKS5 代理

Bun 会自动安装。

---

## Docker 镜像

- **基础镜像**：`oven/bun:1.3.14-alpine`（约 80MB）
- **多架构**：`linux/amd64`、`linux/arm64`
- **非 root 用户**：默认以 `app` 用户运行
- **健康检查**：每 30 秒探测一次 `/openai/v1/models`
- **进程管理**：`tini` 作为 PID 1，负责收割僵尸进程

### 镜像发布

通过 GitHub Actions 自动构建并发布到 GitHub Container Registry：

| 触发 | 标签 |
|---|---|
| 推送 `main` | `latest`、`<short-sha>`、`<日期>` |
| 推送 `v*` 标签 | `v0.2.0`、`v0`、`latest`、`<short-sha>` |
| PR | 仅构建不推送（验证用） |

工作流文件：`.github/workflows/docker-publish.yml`

### 本地构建

```bash
docker build -t opencode-free-gate .
docker run --rm -p 13339:13339 -e ZENPROXY_KEY=xxx opencode-free-gate
```

