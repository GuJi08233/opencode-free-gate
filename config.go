package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	layerPublic = "public"
	layerZen    = "zen"
	layerCustom = "custom"
)

type config struct {
	project          projectSpec
	port             int
	proxyAPI         string
	proxyMode        string
	proxyOrder       []string
	slotCount        int
	slotRetries      int
	customRetries    int
	zenRetries       int
	customProxies    string
	zenRelay         string
	zenKey           string
	forceRelay       bool
	gatewayKey       string
	firstByteTimeout time.Duration
	hardTimeout      time.Duration
	nonStreamTimeout time.Duration
	probeTimeout     time.Duration
	refreshInterval  time.Duration
	streamIdle       time.Duration
}

func loadConfig(project projectSpec) config {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("PROXY_MODE")))
	if mode != "custom" {
		mode = "auto"
	}

	slotCount := envInt("SLOT_COUNT", 5)
	if slotCount < 3 {
		slotCount = 3
	}
	if slotCount > 5 {
		slotCount = 5
	}

	return config{
		project:          project,
		port:             envInt("PORT", 13339),
		proxyAPI:         "https://proxy.amux.ai/api/proxies",
		proxyMode:        mode,
		proxyOrder:       parseProxyOrder(os.Getenv("PROXY_ORDER")),
		slotCount:        slotCount,
		slotRetries:      nonNegative(envInt("SLOT_RETRIES", slotCount)),
		customRetries:    nonNegative(envInt("CUSTOM_RETRIES", 10)),
		zenRetries:       nonNegative(envInt("ZENPROXY_RETRIES", 5)),
		customProxies:    os.Getenv("CUSTOM_PROXIES"),
		zenRelay:         envString("ZENPROXY_RELAY", "https://zenproxy.top/api/relay"),
		zenKey:           os.Getenv("ZENPROXY_KEY"),
		forceRelay:       os.Getenv("FORCE_RELAY") == "1",
		gatewayKey:       os.Getenv("GATEWAY_KEY"),
		firstByteTimeout: envMilliseconds("PROXY_FIRST_BYTE_TIMEOUT", 3000),
		hardTimeout:      envMilliseconds("HARD_TIMEOUT", 10000),
		nonStreamTimeout: envMilliseconds("NON_STREAM_TIMEOUT", 300000),
		probeTimeout:     envMilliseconds("PROXY_PROBE_TIMEOUT", 8000),
		refreshInterval:  envMilliseconds("PROXY_REFRESH_MS", 300000),
		streamIdle:       300 * time.Second,
	}
}

// orderedLayers 返回代理层的调度顺序。显式配置 PROXY_ORDER 时优先，
// 否则按 PROXY_MODE 使用原有的固定顺序；直连始终作为最后兜底，不参与排序。
func (c config) orderedLayers() []string {
	if len(c.proxyOrder) > 0 {
		return c.proxyOrder
	}
	if c.proxyMode == "custom" {
		return []string{layerCustom, layerZen}
	}
	return []string{layerPublic, layerZen, layerCustom}
}

func (c config) usesPublicPool() bool {
	for _, layer := range c.orderedLayers() {
		if layer == layerPublic {
			return true
		}
	}
	return false
}

func parseProxyOrder(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	seen := make(map[string]struct{}, 3)
	order := make([]string, 0, 3)
	for _, token := range strings.Split(raw, ",") {
		name := strings.ToLower(strings.TrimSpace(token))
		switch name {
		case "public", "s", "slot", "slots":
			name = layerPublic
		case "zen", "zenproxy", "relay":
			name = layerZen
		case "custom":
			name = layerCustom
		case "":
			continue
		default:
			log.Printf("[配置] PROXY_ORDER 含未知层 %q，已忽略（可用：public、zen、custom）", token)
			continue
		}
		if _, duplicate := seen[name]; duplicate {
			continue
		}
		seen[name] = struct{}{}
		order = append(order, name)
	}
	if len(order) == 0 {
		log.Printf("[配置] PROXY_ORDER=%q 无有效层，回退到 PROXY_MODE 默认顺序", raw)
		return nil
	}
	return order
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		log.Printf("[配置] %s=%q 无效，使用默认值 %d", key, value, fallback)
		return fallback
	}
	return n
}

func envMilliseconds(key string, fallback int) time.Duration {
	n := envInt(key, fallback)
	if n <= 0 {
		n = fallback
	}
	return time.Duration(n) * time.Millisecond
}

func nonNegative(value int) int {
	if value < 0 {
		return 0
	}
	return value
}
