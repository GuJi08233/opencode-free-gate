package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOpenHTTPTimeoutClosesProxyConnection(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	accepted := make(chan struct{})
	closed := make(chan struct{})
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		close(accepted)
		_, _ = io.Copy(io.Discard, conn)
		_ = conn.Close()
		close(closed)
	}()

	proxyURL, _ := url.Parse("http://" + listener.Addr().String())
	started := time.Now()
	_, err = openHTTP(context.Background(), http.MethodGet, "https://example.invalid/v1/models", http.Header{}, nil, proxyURL, 100*time.Millisecond)
	if !errors.Is(err, errAttemptTimeout) {
		t.Fatalf("expected attempt timeout, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("timeout took too long: %s", elapsed)
	}

	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("proxy never accepted the connection")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("timed-out proxy connection was not closed")
	}
}

func TestDispatchHonorsTotalBudget(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	var active atomic.Int32
	var connections sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			active.Add(1)
			connections.Add(1)
			go func() {
				defer connections.Done()
				defer active.Add(-1)
				_, _ = io.Copy(io.Discard, conn)
				_ = conn.Close()
			}()
		}
	}()

	proxyURL, _ := url.Parse("http://" + listener.Addr().String())
	cfg := config{
		project: projectSpec{
			upstream:       "https://example.invalid",
			directFallback: false,
		},
		proxyMode:        "custom",
		customRetries:    10,
		firstByteTimeout: 100 * time.Millisecond,
		hardTimeout:      240 * time.Millisecond,
	}
	gw := newGateway(cfg)
	gw.custom = []slot{{addr: listener.Addr().String(), proxyURL: proxyURL}}

	started := time.Now()
	_, err = gw.dispatch(context.Background(), upstreamRequest{
		method:   http.MethodGet,
		path:     "/v1/models",
		headers:  http.Header{},
		deadline: time.Now().Add(cfg.hardTimeout),
	}, newRequestTrace())
	if !errors.Is(err, errRequestTimeout) {
		t.Fatalf("expected total timeout, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("total budget was not enforced: %s", elapsed)
	}

	_ = listener.Close()
	<-acceptDone
	connections.Wait()
	if count := active.Load(); count != 0 {
		t.Fatalf("found %d active proxy connections after cancellation", count)
	}
}

func TestBusinessBadRequestIsNotRetried(t *testing.T) {
	if retryableStatus(http.StatusBadRequest) {
		t.Fatal("400 must be returned to the client without proxy rotation")
	}
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusBadGateway} {
		if !retryableStatus(status) {
			t.Fatalf("status %d should be retryable", status)
		}
	}
}

func TestRateLimitRetriesEveryLayerBeforeDirect(t *testing.T) {
	var publicCalls atomic.Int32
	publicSlots := make([]slot, 0, 5)
	for range 5 {
		proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			publicCalls.Add(1)
			w.WriteHeader(http.StatusTooManyRequests)
		}))
		defer proxy.Close()
		proxyURL, err := url.Parse(proxy.URL)
		if err != nil {
			t.Fatal(err)
		}
		publicSlots = append(publicSlots, slot{addr: proxyURL.Host, proxyURL: proxyURL})
	}

	var zenCalls atomic.Int32
	zen := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		zenCalls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer zen.Close()

	var customCalls atomic.Int32
	custom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		customCalls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer custom.Close()
	customURL, err := url.Parse(custom.URL)
	if err != nil {
		t.Fatal(err)
	}

	var directCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		directCalls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer upstream.Close()

	cfg := config{
		project:          projectSpec{upstream: upstream.URL, directFallback: true},
		proxyMode:        "auto",
		slotCount:        5,
		slotRetries:      5,
		customRetries:    10,
		zenRetries:       5,
		zenRelay:         zen.URL,
		zenKey:           "test-key",
		firstByteTimeout: time.Second,
		hardTimeout:      10 * time.Second,
	}
	gw := newGateway(cfg)
	gw.slots = publicSlots
	gw.custom = []slot{{addr: customURL.Host, proxyURL: customURL}}
	trace := newRequestTrace()

	response, err := gw.dispatch(context.Background(), upstreamRequest{
		method:   http.MethodGet,
		path:     "/v1/models",
		headers:  http.Header{},
		deadline: time.Now().Add(cfg.hardTimeout),
	}, trace)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if response.status != http.StatusTooManyRequests {
		t.Fatalf("expected final direct 429, got %d", response.status)
	}
	if got := publicCalls.Load(); got != 5 {
		t.Fatalf("expected 5 public attempts, got %d", got)
	}
	if got := zenCalls.Load(); got != 5 {
		t.Fatalf("expected 5 ZenProxy attempts, got %d", got)
	}
	if got := customCalls.Load(); got != 10 {
		t.Fatalf("expected 10 custom attempts, got %d", got)
	}
	if got := directCalls.Load(); got != 1 {
		t.Fatalf("expected 1 direct attempt, got %d", got)
	}
	if trace.attempts != 21 {
		t.Fatalf("expected 21 total attempts, got %d", trace.attempts)
	}
}

func TestConcurrentPublicSlotSelectionRoundRobins(t *testing.T) {
	gw := newGateway(config{})
	addresses := []string{"proxy-1", "proxy-2", "proxy-3", "proxy-4", "proxy-5"}
	for _, address := range addresses {
		gw.slots = append(gw.slots, slot{addr: address})
	}

	const requests = 100
	start := make(chan struct{})
	counts := make(map[string]int, len(addresses))
	var countsMu sync.Mutex
	var workers sync.WaitGroup
	for range requests {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			selected, ok := gw.nextSlot(false, nil)
			if !ok {
				t.Error("expected a public proxy slot")
				return
			}
			countsMu.Lock()
			counts[selected.addr]++
			countsMu.Unlock()
		}()
	}
	close(start)
	workers.Wait()

	for _, address := range addresses {
		if got := counts[address]; got != requests/len(addresses) {
			t.Fatalf("expected %s to receive %d selections, got %d", address, requests/len(addresses), got)
		}
	}
}
