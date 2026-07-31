package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool opens a connection pool to Postgres.
//
// This service connects as a trusted internal role (the same superuser role
// used for migrations, in local dev) rather than a request-scoped RLS
// session — unlike the procurement-service, which always runs queries
// through PrismaService.forTenant() to pin `app.tenant_id` per transaction
// (see docs/SDD.md §1.2, "three layers of isolation"), the ledger service is
// a backend batch consumer that must be able to process events for any
// tenant as they arrive on the shared Kafka topic.
//
// This means Row-Level Security's redundant backstop does NOT apply to this
// process today. That's an accepted tradeoff for the vertical slice, but it
// raises the bar on discipline: every single query in this service MUST
// filter explicitly by tenant_id — there is no second layer catching a
// mistake here. Production hardening should introduce a dedicated
// `ledger_service` Postgres role with RLS enabled (not bypassed) so this
// guarantee is enforced by the database too, not only by code review.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("pinging postgres: %w", err)
	}
	return pool, nil
}
