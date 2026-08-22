-- Closes the "finance connector's dead-letter path is read-only" gap
-- (README "Known gaps") — failed_posting_review rows (025_finance_
-- connector.sql, opened after 3 exhausted retries) could be queried via
-- SQL but nothing could act on one from the API. finance_connector_svc
-- already has SELECT + INSERT on this table; UPDATE is new, needed to
-- mark a review RESOLVED once a human retries or dismisses it.
GRANT UPDATE ON failed_posting_review TO finance_connector_svc;
