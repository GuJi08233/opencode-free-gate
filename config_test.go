package main

import (
	"testing"
	"time"
)

func TestRetryDefaults(t *testing.T) {
	for _, key := range []string{"SLOT_COUNT", "SLOT_RETRIES", "CUSTOM_RETRIES", "ZENPROXY_RETRIES", "NON_STREAM_TIMEOUT"} {
		t.Setenv(key, "")
	}
	cfg := loadConfig(currentProject())
	if cfg.slotCount != 5 || cfg.slotRetries != 5 || cfg.zenRetries != 5 || cfg.customRetries != 10 {
		t.Fatalf("unexpected retry defaults: slots=%d slotRetries=%d zenRetries=%d customRetries=%d",
			cfg.slotCount, cfg.slotRetries, cfg.zenRetries, cfg.customRetries)
	}
	if cfg.nonStreamTimeout != 5*time.Minute {
		t.Fatalf("expected 5 minute non-stream timeout, got %s", cfg.nonStreamTimeout)
	}
}

func TestProxyOrderDefaultsFollowMode(t *testing.T) {
	auto := config{proxyMode: "auto"}
	if got := auto.orderedLayers(); !equalLayers(got, []string{layerPublic, layerZen, layerCustom}) {
		t.Fatalf("unexpected auto order: %v", got)
	}
	custom := config{proxyMode: "custom"}
	if got := custom.orderedLayers(); !equalLayers(got, []string{layerCustom, layerZen}) {
		t.Fatalf("unexpected custom order: %v", got)
	}
	if auto.usesPublicPool() != true || custom.usesPublicPool() != false {
		t.Fatal("public pool usage should follow the resolved order")
	}
}

func TestProxyOrderParsing(t *testing.T) {
	cases := []struct {
		raw  string
		want []string
	}{
		{"custom,zen,public", []string{layerCustom, layerZen, layerPublic}},
		{" Custom , ZenProxy , S ", []string{layerCustom, layerZen, layerPublic}},
		{"custom,custom,zen", []string{layerCustom, layerZen}},
		{"custom,bogus", []string{layerCustom}},
		{"bogus", nil},
		{"", nil},
	}
	for _, current := range cases {
		if got := parseProxyOrder(current.raw); !equalLayers(got, current.want) {
			t.Fatalf("parseProxyOrder(%q) = %v, want %v", current.raw, got, current.want)
		}
	}
}

func TestProxyOrderOverridesMode(t *testing.T) {
	cfg := config{proxyMode: "auto", proxyOrder: []string{layerCustom, layerZen, layerPublic}}
	if got := cfg.orderedLayers(); !equalLayers(got, []string{layerCustom, layerZen, layerPublic}) {
		t.Fatalf("PROXY_ORDER should override mode default, got %v", got)
	}
	noPublic := config{proxyMode: "auto", proxyOrder: []string{layerCustom, layerZen}}
	if noPublic.usesPublicPool() {
		t.Fatal("order without public layer must not load the public pool")
	}
}

func equalLayers(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
