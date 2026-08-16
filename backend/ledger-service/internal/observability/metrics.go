// Package observability gives ledger-service the same baseline the 8
// Node services got in the same pass (docs/RUNBOOK.md's "Observability"
// section): an unauthenticated /health, a Prometheus /metrics, and a
// handful of metrics meaningful to what this specific service does —
// event throughput/failure rate/processing latency, since ledger-service
// is a pure Kafka consumer with no HTTP request traffic of its own to
// measure the way the Node services' generic request counter does.
package observability

import "github.com/prometheus/client_golang/prometheus"

var (
	EventsConsumedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ledger_events_consumed_total",
		Help: "Total events read from the Kafka topic, before success/failure is known.",
	})
	EventsFailedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ledger_events_failed_total",
		Help: "Events that could not be posted and were routed to integration_queue for review (SDD §4.2), or hit an unexpected error.",
	})
	PostingDurationSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "ledger_posting_duration_seconds",
		Help:    "Time to handle a single event, from Kafka delivery to commit/failure-record.",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5},
	})
)

func init() {
	prometheus.MustRegister(EventsConsumedTotal, EventsFailedTotal, PostingDurationSeconds)
}
