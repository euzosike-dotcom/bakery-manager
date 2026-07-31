package ledger

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNoPostingRule means the tenant has not configured a posting_rules row
// for this event_type. This is treated as an operational gap, not a crash:
// the event is logged to failed_posting_review for a human to configure the
// missing rule, and the consumer moves on rather than blocking the topic.
var ErrNoPostingRule = errors.New("no active posting rule for event type")

type PostingRule struct {
	DebitAccountCode  string
	CreditAccountCode string
	AmountExpression  string
}

type Event struct {
	EventID      string // maps 1:1 to journal_entries.source_event_id (idempotency)
	EventType    string
	TenantID     string
	PlantID      string
	SourceModule string
	Payload      map[string]any
}

type PostingEngine struct {
	db *pgxpool.Pool
}

func NewPostingEngine(db *pgxpool.Pool) *PostingEngine {
	return &PostingEngine{db: db}
}

// Handle turns one domain event into a double-entry journal_entry +
// journal_lines pair, per the tenant's configured posting_rules (docs/SDD.md
// §3 preamble). It is idempotent on event.EventID: a re-delivered Kafka
// message (at-least-once delivery is the default) is a safe no-op because
// journal_entries has a UNIQUE(tenant_id, source_event_id) constraint and
// this function relies on ON CONFLICT DO NOTHING to detect that.
func (e *PostingEngine) Handle(ctx context.Context, event Event) error {
	rule, err := e.loadPostingRule(ctx, event.TenantID, event.EventType)
	if err != nil {
		if errors.Is(err, ErrNoPostingRule) {
			return e.recordFailure(ctx, event, "no active posting rule configured for this event_type")
		}
		return fmt.Errorf("loading posting rule: %w", err)
	}

	amount, ok := amountFromPayload(event.Payload, rule.AmountExpression)
	if !ok || amount <= 0 {
		return e.recordFailure(ctx, event, fmt.Sprintf("amount_expression %q missing or non-positive in payload", rule.AmountExpression))
	}

	tx, err := e.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op if committed

	journalEntryID := uuid.NewString()
	var insertedID string
	err = tx.QueryRow(ctx, `
		INSERT INTO journal_entries (tenant_id, journal_entry_id, source_event_id, source_module, status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'POSTED')
		ON CONFLICT (tenant_id, source_event_id) DO NOTHING
		RETURNING journal_entry_id
	`, event.TenantID, journalEntryID, event.EventID, event.SourceModule).Scan(&insertedID)

	if errors.Is(err, pgx.ErrNoRows) {
		slog.Info("event already posted, skipping (idempotent)", "event_id", event.EventID, "event_type", event.EventType)
		return nil // already posted — safe no-op, not an error
	}
	if err != nil {
		return fmt.Errorf("inserting journal_entries: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO journal_lines (tenant_id, journal_line_id, journal_entry_id, account_code, debit_amount, credit_amount, cost_center_plant_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 0, $6::uuid)
	`, event.TenantID, uuid.NewString(), insertedID, rule.DebitAccountCode, amount, nullableUUID(event.PlantID)); err != nil {
		return fmt.Errorf("inserting debit line: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO journal_lines (tenant_id, journal_line_id, journal_entry_id, account_code, debit_amount, credit_amount, cost_center_plant_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 0, $5, $6::uuid)
	`, event.TenantID, uuid.NewString(), insertedID, rule.CreditAccountCode, amount, nullableUUID(event.PlantID)); err != nil {
		return fmt.Errorf("inserting credit line: %w", err)
	}

	if err := e.enqueueForFinanceConnector(ctx, tx, event, insertedID); err != nil {
		return fmt.Errorf("enqueueing integration_queue row: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing tx: %w", err)
	}

	slog.Info("posted journal entry",
		"tenant_id", event.TenantID, "event_type", event.EventType,
		"journal_entry_id", insertedID, "amount", amount,
		"debit", rule.DebitAccountCode, "credit", rule.CreditAccountCode)
	return nil
}

func (e *PostingEngine) loadPostingRule(ctx context.Context, tenantID, eventType string) (PostingRule, error) {
	var rule PostingRule
	err := e.db.QueryRow(ctx, `
		SELECT debit_account_code, credit_account_code, amount_expression
		FROM posting_rules
		WHERE tenant_id = $1::uuid AND event_type = $2 AND is_active = true
		LIMIT 1
	`, tenantID, eventType).Scan(&rule.DebitAccountCode, &rule.CreditAccountCode, &rule.AmountExpression)
	if errors.Is(err, pgx.ErrNoRows) {
		return PostingRule{}, ErrNoPostingRule
	}
	if err != nil {
		return PostingRule{}, err
	}
	return rule, nil
}

// enqueueForFinanceConnector writes an outbound row for the tenant's
// configured external finance system (docs/SDD.md §5 traceability: Zoho
// Books becomes an optional downstream connector, not the source of truth).
// If the tenant has no connector configured (finance_connector_type =
// 'NONE'), the Unified Ledger itself remains the sole system of record and
// no row is queued.
func (e *PostingEngine) enqueueForFinanceConnector(ctx context.Context, tx pgx.Tx, event Event, journalEntryID string) error {
	var connectorType string
	err := tx.QueryRow(ctx, `SELECT finance_connector_type FROM tenant_registry WHERE tenant_id = $1::uuid`, event.TenantID).Scan(&connectorType)
	if err != nil {
		return fmt.Errorf("looking up tenant finance connector: %w", err)
	}
	if connectorType == "NONE" {
		return nil
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO integration_queue (tenant_id, queue_id, external_system, source_module, source_record_id, transaction_type, payload_json, queue_status)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, 'PENDING')
	`, event.TenantID, uuid.NewString(), connectorType, event.SourceModule, journalEntryID, event.EventType, mustJSON(event.Payload))
	return err
}

func (e *PostingEngine) recordFailure(ctx context.Context, event Event, reason string) error {
	slog.Warn("event could not be posted, recording for review",
		"tenant_id", event.TenantID, "event_type", event.EventType, "event_id", event.EventID, "reason", reason)

	queueID := uuid.NewString()
	_, err := e.db.Exec(ctx, `
		INSERT INTO integration_queue (tenant_id, queue_id, external_system, source_module, source_record_id, transaction_type, payload_json, queue_status, last_error_message)
		VALUES ($1::uuid, $2::uuid, 'NONE', $3, $4, $5, $6::jsonb, 'FAILED', $7)
	`, event.TenantID, queueID, event.SourceModule, event.EventID, event.EventType, mustJSON(event.Payload), reason)
	if err != nil {
		return fmt.Errorf("recording integration_queue failure: %w", err)
	}

	_, err = e.db.Exec(ctx, `
		INSERT INTO failed_posting_review (tenant_id, review_id, queue_id, source_record_id, error_message, review_status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'OPEN')
	`, event.TenantID, uuid.NewString(), queueID, event.EventID, reason)
	if err != nil {
		return fmt.Errorf("recording failed_posting_review: %w", err)
	}
	return nil
}

func amountFromPayload(payload map[string]any, expression string) (float64, bool) {
	// Deliberately simple for this vertical slice: amount_expression is just
	// a top-level payload field name (e.g. "accepted_value"). A richer
	// expression language (arithmetic across multiple fields, conditionals)
	// is a natural extension once a second module needs it — not required
	// to prove the pattern end-to-end.
	raw, ok := payload[expression]
	if !ok {
		return 0, false
	}
	switch v := raw.(type) {
	case float64:
		return v, true
	default:
		return 0, false
	}
}

func nullableUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}
