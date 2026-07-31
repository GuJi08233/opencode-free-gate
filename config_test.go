package main

import "testing"

func TestRetryDefaults(t *testing.T) {
	for _, key := range []string{"SLOT_COUNT", "SLOT_RETRIES", "CUSTOM_RETRIES", "ZENPROXY_RETRIES"} {
		t.Setenv(key, "")
	}
	cfg := loadConfig(currentProject())
	if cfg.slotCount != 5 || cfg.slotRetries != 5 || cfg.zenRetries != 5 || cfg.customRetries != 10 {
		t.Fatalf("unexpected retry defaults: slots=%d slotRetries=%d zenRetries=%d customRetries=%d",
			cfg.slotCount, cfg.slotRetries, cfg.zenRetries, cfg.customRetries)
	}
}
