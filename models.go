package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

const modelCacheTTL = 60 * time.Second

type cachedModels struct {
	rename   map[string]string
	redirect map[string]string
	loadedAt time.Time
}

func (g *gateway) modelMaps(ctx context.Context) (map[string]string, map[string]string) {
	g.modelMu.Lock()
	defer g.modelMu.Unlock()

	if g.modelCache != nil && time.Since(g.modelCache.loadedAt) < modelCacheTTL {
		return cloneStringMap(g.modelCache.rename), cloneStringMap(g.modelCache.redirect)
	}

	rename, err := g.fetchModelMaps(ctx)
	if err != nil {
		if g.modelCache != nil {
			log.Printf("[模型] 刷新失败，使用缓存: %v", err)
			g.modelCache.loadedAt = time.Now().Add(-(modelCacheTTL - 5*time.Second))
			return cloneStringMap(g.modelCache.rename), cloneStringMap(g.modelCache.redirect)
		}
		log.Printf("[模型] 刷新失败且无缓存: %v", err)
		rename = cloneStringMap(g.cfg.project.specialModels)
		redirect := buildRedirect(rename)
		// 短暂缓存失败结果，避免上游故障时并发请求在互斥锁后逐个等待 8 秒。
		g.modelCache = &cachedModels{
			rename:   cloneStringMap(rename),
			redirect: cloneStringMap(redirect),
			loadedAt: time.Now().Add(-(modelCacheTTL - 5*time.Second)),
		}
		return rename, redirect
	}

	redirect := buildRedirect(rename)
	g.modelCache = &cachedModels{rename: rename, redirect: redirect, loadedAt: time.Now()}
	log.Printf("[模型] 已刷新 %d 个免费模型", len(rename))
	return cloneStringMap(rename), cloneStringMap(redirect)
}

func (g *gateway) fetchModelMaps(parent context.Context) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()

	target := strings.TrimRight(g.cfg.project.upstream, "/") + g.cfg.project.modelPath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if auth := g.cfg.project.upstreamAuthorization; auth != "" {
		req.Header.Set("Authorization", auth)
	}

	client := &http.Client{Transport: controlTransport(8 * time.Second)}
	defer client.CloseIdleConnections()
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("model API returned %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	ids, err := extractModelIDs(body)
	if err != nil {
		return nil, err
	}

	rename := cloneStringMap(g.cfg.project.specialModels)
	for _, id := range ids {
		switch g.cfg.project.modelMode {
		case modelKilo:
			if !strings.HasSuffix(id, ":free") {
				continue
			}
			trimmed := strings.TrimSuffix(id, ":free")
			parts := strings.Split(trimmed, "/")
			rename[id] = parts[len(parts)-1]
		case modelOpenCode:
			if strings.HasSuffix(id, "-free") {
				rename[id] = strings.TrimSuffix(id, "-free")
			}
		}
	}
	return rename, nil
}

func extractModelIDs(body []byte) ([]string, error) {
	var root any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil {
		return nil, err
	}
	if object, ok := root.(map[string]any); ok {
		root = object["data"]
	}
	items, ok := root.([]any)
	if !ok {
		return nil, fmt.Errorf("unexpected model response")
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		switch value := item.(type) {
		case string:
			ids = append(ids, value)
		case map[string]any:
			if id, ok := value["id"].(string); ok && id != "" {
				ids = append(ids, id)
			}
		}
	}
	return ids, nil
}

func (g *gateway) modelsResponse(ctx context.Context) *gatewayResponse {
	rename, _ := g.modelMaps(ctx)
	unique := make(map[string]struct{}, len(rename)+len(g.cfg.project.extraModels))
	for _, display := range rename {
		unique[display] = struct{}{}
	}
	for _, model := range g.cfg.project.extraModels {
		unique[model] = struct{}{}
	}
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	created := time.Now().Unix()
	models := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		models = append(models, map[string]any{
			"id":       id,
			"object":   "model",
			"created":  created,
			"owned_by": g.cfg.project.ownedBy,
		})
	}
	body, _ := json.Marshal(map[string]any{"object": "list", "data": models})
	return &gatewayResponse{
		status: http.StatusOK,
		header: http.Header{"Content-Type": []string{"application/json; charset=utf-8"}},
		body:   body,
	}
}

func (g *gateway) rewriteModel(ctx context.Context, body []byte) []byte {
	_, redirect := g.modelMaps(ctx)
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	model, _ := payload["model"].(string)
	upstream, exists := redirect[model]
	if !exists {
		return body
	}
	payload["model"] = upstream
	rewritten, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	log.Printf("[模型重定向] %s -> %s", model, upstream)
	return rewritten
}

func cloneStringMap(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func buildRedirect(rename map[string]string) map[string]string {
	upstreamIDs := make([]string, 0, len(rename))
	for upstream := range rename {
		upstreamIDs = append(upstreamIDs, upstream)
	}
	sort.Strings(upstreamIDs)
	redirect := make(map[string]string, len(rename))
	for _, upstream := range upstreamIDs {
		redirect[rename[upstream]] = upstream
	}
	return redirect
}
