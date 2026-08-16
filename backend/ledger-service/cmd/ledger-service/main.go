// Command ledger-service consumes domain events from the shared event topic
// and posts them to the Unified Ledger's double-entry journal, per the
// tenant-configurable posting_rules table (docs/SDD.md §3, §4.1).
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/metrock/ledger-service/internal/db"
	"github.com/metrock/ledger-service/internal/kafka"
	"github.com/metrock/ledger-service/internal/ledger"
	"github.com/metrock/ledger-service/internal/observability"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databaseURL := envOrDefault("DATABASE_URL", "postgresql://metrock:metrock_dev_password@localhost:5432/metrock_erp")
	brokers := strings.Split(envOrDefault("KAFKA_BROKERS", "localhost:9092"), ",")
	topic := envOrDefault("KAFKA_TOPIC", "erp.events")
	groupID := envOrDefault("KAFKA_CONSUMER_GROUP", "ledger-service")
	observabilityAddr := ":" + envOrDefault("OBSERVABILITY_PORT", "9101")

	// Side HTTP listener for /health and /metrics — this service has no
	// other HTTP surface (it's a pure Kafka consumer), so this exists
	// purely for the same operational visibility the 8 Node services got
	// in the same pass (docs/RUNBOOK.md's "Observability" section), not
	// to serve any of ledger-service's actual work.
	go observability.Serve(ctx, observabilityAddr)

	pool, err := db.NewPool(ctx, databaseURL)
	if err != nil {
		slog.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	engine := ledger.NewPostingEngine(pool)
	consumer := kafka.NewConsumer(brokers, topic, groupID, engine)
	defer consumer.Close()

	slog.Info("ledger-service starting", "topic", topic, "group", groupID, "brokers", brokers)
	if err := consumer.Run(ctx); err != nil {
		slog.Error("consumer stopped with error", "error", err)
		os.Exit(1)
	}
	slog.Info("ledger-service stopped cleanly")
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
