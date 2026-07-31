package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	project          projectSpec
	port             int
	proxyAPI         string
	proxyMode        string
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
	probeTimeout     time.Duration
	refreshInterval  time.Duration
	streamIdle       time.Duration
}

func loadConfig(project projectSpec) config {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("PROXY_MODE")))
	if mode != "custom" {
		mode = "auto"
	}

	slotCount := envInt("SLOT_COUNT", 3)
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
		slotCount:        slotCount,
		slotRetries:      nonNegative(envInt("SLOT_RETRIES", slotCount)),
		customRetries:    nonNegative(envInt("CUSTOM_RETRIES", 0)),
		zenRetries:       nonNegative(envInt("ZENPROXY_RETRIES", 1)),
		customProxies:    os.Getenv("CUSTOM_PROXIES"),
		zenRelay:         envString("ZENPROXY_RELAY", "https://zenproxy.top/api/relay"),
		zenKey:           os.Getenv("ZENPROXY_KEY"),
		forceRelay:       os.Getenv("FORCE_RELAY") == "1",
		gatewayKey:       os.Getenv("GATEWAY_KEY"),
		firstByteTimeout: envMilliseconds("PROXY_FIRST_BYTE_TIMEOUT", 3000),
		hardTimeout:      envMilliseconds("HARD_TIMEOUT", 10000),
		probeTimeout:     envMilliseconds("PROXY_PROBE_TIMEOUT", 8000),
		refreshInterval:  envMilliseconds("PROXY_REFRESH_MS", 300000),
		streamIdle:       300 * time.Second,
	}
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
