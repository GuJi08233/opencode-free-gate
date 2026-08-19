package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"time"
)

type requestIDs struct {
	Session string
	Request string
	Project string
}

// deriveRequestIDs 生成上游 OpenCode 协议所需的会话、请求与项目标识。
// 会话 ID 优先取客户端显式标识，否则用第一条用户消息生成稳定哈希，
// 保证同一段多轮对话在历史增长时仍映射到同一个会话。
func deriveRequestIDs(headers http.Header, body map[string]any) requestIDs {
	signal := firstString(
		headers.Get("x-opencode-session"),
		headers.Get("x-session-id"),
		headers.Get("conversation-id"),
		stringAt(body, "conversation_id"),
		stringAt(body, "metadata", "session_id"),
	)
	if signal == "" {
		signal = conversationSeed(body)
	}
	if signal == "" {
		signal = stringAt(body, "previous_response_id")
	}
	if signal == "" || signal == "{}" {
		signal = randomID("fallback", 16)
	}
	projectSignal := firstString(headers.Get("x-opencode-project"), stringAt(body, "metadata", "project_id"))
	if projectSignal == "" {
		projectSignal = "opencode-free-gate:default-project"
	}
	return requestIDs{
		Session: stableID("ses", signal),
		Request: randomID("req", 16),
		Project: stableID("prj", projectSignal),
	}
}

func conversationSeed(body map[string]any) string {
	if input, ok := body["input"].(string); ok && input != "" {
		return input
	}
	for _, field := range []string{"messages", "input"} {
		items, _ := body[field].([]any)
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok || stringAt(item, "role") != "user" {
				continue
			}
			encoded, _ := json.Marshal(item["content"])
			if len(encoded) > 0 && string(encoded) != "null" {
				return string(encoded)
			}
		}
	}
	return ""
}

func stableID(prefix, value string) string {
	sum := sha256.Sum256([]byte(prefix + "\x00" + value))
	return prefix + "_" + hex.EncodeToString(sum[:12])
}

func randomID(prefix string, size int) string {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return prefix + "_" + fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(buf)
}

func firstString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func stringAt(value map[string]any, path ...string) string {
	current := any(value)
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[key]
	}
	result, _ := current.(string)
	return result
}

func opencodeUserAgent() string {
	return fmt.Sprintf("opencode/1.18.18 (%s %s; %s)", runtime.GOOS, runtime.GOARCH, runtime.Version())
}
