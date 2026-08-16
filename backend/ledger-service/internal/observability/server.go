package observability

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Serve runs the health/metrics HTTP server until ctx is cancelled — a
// side listener alongside the main Kafka consumer loop (cmd/ledger-
// service/main.go runs this in its own goroutine), not a request-response
// server for this service's actual work, which stays Kafka-only. Errors
// are logged, not fatal — a stuck /metrics scrape endpoint shouldn't take
// down event processing, the thing this service actually exists to do.
func Serve(ctx context.Context, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())

	server := &http.Server{Addr: addr, Handler: mux}

	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()

	slog.Info("observability server starting", "addr", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("observability server stopped with error", "error", err)
	}
}
