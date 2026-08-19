package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestDeriveRequestIDsStableAcrossTurns(t *testing.T) {
	turn1 := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "hello world"},
		},
	}
	turn2 := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "hello world"},
			map[string]any{"role": "assistant", "content": "hi"},
			map[string]any{"role": "user", "content": "second turn"},
		},
	}
	first := deriveRequestIDs(http.Header{}, turn1)
	second := deriveRequestIDs(http.Header{}, turn2)
	if first.Session != second.Session {
		t.Fatalf("same conversation must keep one session: %q vs %q", first.Session, second.Session)
	}
	if first.Request == second.Request {
		t.Fatal("each client request must get a fresh request id")
	}

	other := deriveRequestIDs(http.Header{}, map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "different opener"}},
	})
	if other.Session == first.Session {
		t.Fatal("different conversations must not share a session")
	}
}

func TestDeriveRequestIDsHonorsExplicitSession(t *testing.T) {
	headers := http.Header{}
	headers.Set("X-Session-Id", "session-a")
	bodyA := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "same opener"}}}
	bodyB := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "same opener"}}}

	withHeader := deriveRequestIDs(headers, bodyA)
	otherHeader := http.Header{}
	otherHeader.Set("X-Session-Id", "session-b")
	withOther := deriveRequestIDs(otherHeader, bodyB)
	if withHeader.Session == withOther.Session {
		t.Fatal("explicit session ids must separate identical openers")
	}
	if !strings.HasPrefix(withHeader.Session, "ses_") {
		t.Fatalf("session id must use the opencode format: %q", withHeader.Session)
	}
	if !strings.HasPrefix(withHeader.Request, "req_") || !strings.HasPrefix(withHeader.Project, "prj_") {
		t.Fatalf("unexpected id formats: %q %q", withHeader.Request, withHeader.Project)
	}
}

func TestDeriveRequestIDsResponsesInput(t *testing.T) {
	viaInput := deriveRequestIDs(http.Header{}, map[string]any{"input": "codex prompt"})
	again := deriveRequestIDs(http.Header{}, map[string]any{"input": "codex prompt"})
	if viaInput.Session != again.Session {
		t.Fatal("responses input string must yield a stable session")
	}

	viaPrevious := deriveRequestIDs(http.Header{}, map[string]any{"previous_response_id": "resp_123"})
	againPrevious := deriveRequestIDs(http.Header{}, map[string]any{"previous_response_id": "resp_123"})
	if viaPrevious.Session != againPrevious.Session {
		t.Fatal("previous_response_id must yield a stable session")
	}
}

func TestApplyAnthropicAuth(t *testing.T) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer public")
	applyAnthropicAuth(headers)
	if headers.Get("Authorization") != "" {
		t.Fatal("anthropic requests must not carry Authorization")
	}
	if got := headers.Get("X-Api-Key"); got != "public" {
		t.Fatalf("anthropic requests must use x-api-key: %q", got)
	}
	if got := headers.Get("Anthropic-Version"); got != "2023-06-01" {
		t.Fatalf("missing default anthropic-version: %q", got)
	}

	custom := http.Header{}
	custom.Set("Authorization", "Bearer public")
	custom.Set("Anthropic-Version", "2024-01-01")
	applyAnthropicAuth(custom)
	if got := custom.Get("Anthropic-Version"); got != "2024-01-01" {
		t.Fatalf("client anthropic-version must be preserved: %q", got)
	}
}

func TestSessionAffinityPrefersStableSlot(t *testing.T) {
	gw := newGateway(config{})
	for _, address := range []string{"proxy-1", "proxy-2", "proxy-3", "proxy-4", "proxy-5"} {
		gw.slots = append(gw.slots, slot{addr: address})
	}

	first, ok := gw.nextSlot(false, map[string]struct{}{}, "ses_alpha", 0)
	if !ok {
		t.Fatal("expected a slot for the session")
	}
	for range 10 {
		again, ok := gw.nextSlot(false, map[string]struct{}{}, "ses_alpha", 0)
		if !ok || again.addr != first.addr {
			t.Fatalf("session must stick to %s, got %s", first.addr, again.addr)
		}
	}

	tried := map[string]struct{}{first.addr: {}}
	fallback, ok := gw.nextSlot(false, tried, "ses_alpha", 1)
	if !ok || fallback.addr == first.addr {
		t.Fatalf("failed slot must be skipped, got %s", fallback.addr)
	}

	distinct := make(map[string]struct{})
	for _, session := range []string{"ses_a", "ses_b", "ses_c", "ses_d", "ses_e", "ses_f", "ses_g", "ses_h"} {
		selected, ok := gw.nextSlot(false, map[string]struct{}{}, session, 0)
		if !ok {
			t.Fatal("expected a slot")
		}
		distinct[selected.addr] = struct{}{}
	}
	if len(distinct) < 2 {
		t.Fatal("different sessions should spread across slots")
	}
}
