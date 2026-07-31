package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
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
