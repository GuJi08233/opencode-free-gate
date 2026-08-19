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
			"Accept":            []string{"application/json"},
			"Authorization":     []string{"Bearer public"},
			"User-Agent":        []string{opencodeUserAgent()},
			"X-Opencode-Client": []string{"cli"},
		},
		// x-opencode-* 头不再透传：客户端提供的会话/项目标识只作为
		// deriveRequestIDs 的输入，最终由网关生成统一格式的标识发往上游。
		forwardHeaders: []string{
			"content-type",
			"accept",
			"anthropic-version",
			"anthropic-beta",
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
