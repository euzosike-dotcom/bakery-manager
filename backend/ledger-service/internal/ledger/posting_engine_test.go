package ledger

import "testing"

// PostingEngine.Handle itself needs a real *pgxpool.Pool (a concrete
// struct, not an interface, so it cannot be mocked the way the Node
// services' PrismaService.forTenant is) — exercising it end-to-end belongs
// to Phase 3 (integration tests against real Postgres), not this pass.
// amountFromPayload and nullableUUID are pure and carry real risk on their
// own: a silently-wrong amount extraction would mean a wrong journal_lines
// debit/credit value with no compiler or runtime error to catch it.

func TestAmountFromPayload(t *testing.T) {
	cases := []struct {
		name       string
		payload    map[string]any
		expression string
		wantAmount float64
		wantOK     bool
	}{
		{
			name:       "extracts a float64 field named by the expression",
			payload:    map[string]any{"accepted_value": 300.0},
			expression: "accepted_value",
			wantAmount: 300.0,
			wantOK:     true,
		},
		{
			name:       "returns false when the field is missing entirely",
			payload:    map[string]any{"other_field": 100.0},
			expression: "accepted_value",
			wantAmount: 0,
			wantOK:     false,
		},
		{
			// Kafka JSON payloads decode numbers as float64 in Go's
			// encoding/json by default, but this guards the case where the
			// field decoded to some other type (e.g. a string) — the
			// switch in amountFromPayload only accepts float64.
			name:       "returns false when the field is present but not a float64",
			payload:    map[string]any{"accepted_value": "not-a-number"},
			expression: "accepted_value",
			wantAmount: 0,
			wantOK:     false,
		},
		{
			name:       "returns false on a nil payload map",
			payload:    nil,
			expression: "accepted_value",
			wantAmount: 0,
			wantOK:     false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotAmount, gotOK := amountFromPayload(tc.payload, tc.expression)
			if gotOK != tc.wantOK {
				t.Fatalf("ok = %v, want %v", gotOK, tc.wantOK)
			}
			if gotAmount != tc.wantAmount {
				t.Fatalf("amount = %v, want %v", gotAmount, tc.wantAmount)
			}
		})
	}
}

func TestNullableUUID(t *testing.T) {
	if got := nullableUUID(""); got != nil {
		t.Fatalf("nullableUUID(\"\") = %v, want nil", got)
	}
	if got := nullableUUID("plant-1"); got != "plant-1" {
		t.Fatalf("nullableUUID(\"plant-1\") = %v, want \"plant-1\"", got)
	}
}
