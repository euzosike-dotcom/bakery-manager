package ledger

import "encoding/json"

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Payload always originates from a successfully-unmarshalled Kafka
		// message (see internal/kafka), so re-marshalling it cannot fail in
		// practice; a panic here would indicate a corrupted in-memory value.
		panic(err)
	}
	return b
}
