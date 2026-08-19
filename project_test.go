package main

import (
	"net/http"
	"testing"
)

func TestOpenCodeRoutesAndHeaders(t *testing.T) {
	project := currentProject()
	for _, raw := range []string{
		"/openai/v1/chat/completions",
		"/anthropic/v1/messages",
		"/codex/v1/responses",
	} {
		if _, ok := normalizePath(project, raw); !ok {
			t.Fatalf("expected route %s to be accepted", raw)
		}
	}
	if _, ok := normalizePath(project, "/v1/chat/completions"); ok {
		t.Fatal("raw /v1 route must not bypass the OpenCode prefixes")
	}

	application := &app{gateway: newGateway(config{project: project})}
	headers := application.collectHeaders(http.Header{
		"Authorization":     []string{"Bearer client-secret"},
		"X-Opencode-Client": []string{"desktop"},
	})
	if got := headers.Get("Authorization"); got != "Bearer public" {
		t.Fatalf("unexpected upstream authorization: %q", got)
	}
	if got := headers.Get("X-Opencode-Client"); got != "cli" {
		t.Fatalf("client header must be normalized to cli: %q", got)
	}
	if got := headers.Get("User-Agent"); got != opencodeUserAgent() {
		t.Fatalf("upstream requests must use the opencode user agent: %q", got)
	}
	if !project.directFallback {
		t.Fatal("OpenCode must try one direct request after proxy retries are exhausted")
	}
}
