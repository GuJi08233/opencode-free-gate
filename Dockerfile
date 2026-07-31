# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src

COPY go.mod ./
COPY *.go ./

RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/gate .

FROM alpine:3.22 AS runtime

LABEL org.opencontainers.image.title="opencode-free-gate" \
      org.opencontainers.image.description="opencode.ai/zen 免费模型的 Go 反代网关" \
      org.opencontainers.image.source="https://github.com/GuJi08233/opencode-free-gate" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache ca-certificates tzdata wget tini \
    && addgroup -S app \
    && adduser -S app -G app

WORKDIR /app
COPY --from=build --chown=app:app /out/gate /app/gate

USER app

ENV PORT=13339

EXPOSE 13339

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/gate"]
