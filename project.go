package main

import "net/http"

type modelMode int

const (
	modelPassthrough modelMode = iota
	modelKilo
	modelOpenCode
)

type projectSpec struct {
	name                  string
	displayName           string
	upstream              string
	probePath             string
	modelPath             string
	probeHeaders          http.Header
	forwardHeaders        []string
	prefixes              []string
	postPaths             map[string]struct{}
	gatewayAuth           bool
	upstreamAuthorization string
	defaultClientHeader   string
	directFallback        bool
	modelMode             modelMode
	ownedBy               string
	extraModels           []string
	specialModels         map[string]string
}

func currentProject() projectSpec {
	return projectSpec{
		name:        "opencode-free-gate",
		displayName: "OpenCode",
		upstream:    "https://opencode.ai/zen",
		probePath:   "/v1/models",
		modelPath:   "/v1/models",
		probeHeaders: http.Header{
			"Accept":        []string{"application/json"},
			"Authorization": []string{"Bearer public"},
		},
		forwardHeaders: []string{
			"content-type",
			"accept",
			"anthropic-version",
			"anthropic-beta",
			"x-opencode-project",
			"x-opencode-session",
			"x-opencode-request",
			"x-opencode-client",
		},
		prefixes: []string{"openai", "anthropic", "codex"},
		postPaths: map[string]struct{}{
			"/v1/chat/completions": {},
			"/v1/messages":         {},
			"/v1/responses":        {},
		},
		upstreamAuthorization: "Bearer public",
		defaultClientHeader:   "cli",
		directFallback:        true,
		modelMode:             modelOpenCode,
		ownedBy:               "opencode",
		extraModels:           []string{"big-pickle"},
	}
}
