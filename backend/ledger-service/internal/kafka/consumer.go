package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/metrock/ledger-service/internal/ledger"
	segmentkafka "github.com/segmentio/kafka-go"
)

type rawEvent struct {
	EventType string `json:"event_type"`
	TenantID  string `json:"tenant_id"`
	PlantID   string `json:"plant_id"`
	EventID   string `json:"event_id"`
}

// Consumer reads the platform's single event topic (SDD §2.2) and hands each
// message to the posting engine. It commits offsets only after a message has
// been fully handled (or explicitly recorded as a failure), so a crash
// mid-batch re-delivers rather than silently drops an event — the posting
// engine's idempotency on event_id is what makes that safe to do blindly.
type Consumer struct {
	reader *segmentkafka.Reader
	engine *ledger.PostingEngine
}

func NewConsumer(brokers []string, topic, groupID string, engine *ledger.PostingEngine) *Consumer {
	reader := segmentkafka.NewReader(segmentkafka.ReaderConfig{
		Brokers: brokers,
		Topic:   topic,
		GroupID: groupID,
	})
	return &Consumer{reader: reader, engine: engine}
}

func (c *Consumer) Close() error {
	return c.reader.Close()
}

// Run blocks, consuming until ctx is cancelled.
func (c *Consumer) Run(ctx context.Context) error {
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil // clean shutdown
			}
			return fmt.Errorf("fetching message: %w", err)
		}

		if err := c.handle(ctx, msg.Value); err != nil {
			// Log and continue rather than blocking the partition — the
			// posting engine already routes unprocessable events to
			// failed_posting_review for human follow-up (SDD §4.2).
			slog.Error("failed to handle event", "error", err, "offset", msg.Offset)
		}

		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			slog.Error("failed to commit offset", "error", err, "offset", msg.Offset)
		}
	}
}

func (c *Consumer) handle(ctx context.Context, raw []byte) error {
	var header rawEvent
	if err := json.Unmarshal(raw, &header); err != nil {
		return fmt.Errorf("unmarshalling event header: %w", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("unmarshalling event payload: %w", err)
	}

	return c.engine.Handle(ctx, ledger.Event{
		EventID:      header.EventID,
		EventType:    header.EventType,
		TenantID:     header.TenantID,
		PlantID:      header.PlantID,
		SourceModule: sourceModuleFor(header.EventType),
		Payload:      payload,
	})
}

// sourceModuleFor is a small, explicit lookup rather than a convention-based
// guess (e.g. splitting on "."), so adding a new event type to a new module
// is a one-line change reviewers can actually see in a diff.
func sourceModuleFor(eventType string) string {
	switch eventType {
	case "grn.posted.v1":
		return "procurement"
	case "batch.consumption_recorded.v1", "batch.output_recorded.v1",
		"batch.yield_variance_unfavorable.v1", "batch.yield_variance_favorable.v1":
		return "manufacturing"
	case "sales.order_fulfilled.v1", "ncr.verified.v1":
		return "sales"
	case "accounting.bill_paid.v1", "accounting.invoice_payment_received.v1":
		return "accounting"
	case "fleet.fuel_recorded.v1", "fleet.maintenance_completed.v1":
		return "fleet"
	case "payroll.run_posted.v1":
		return "hr"
	default:
		return "unknown"
	}
}
