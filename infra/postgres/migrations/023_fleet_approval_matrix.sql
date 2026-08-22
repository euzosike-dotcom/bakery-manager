-- Extends approval_matrix amount-based routing (docs/SDD.md §4.2, see
-- 022_accounting_approval_matrix.sql's header comment for the fuller
-- reasoning) to Fleet maintenance-request completion — the cost is only
-- known at completion time (parts_cost/labour_cost are submitted
-- together with the completion call, migration 017), so `complete()`
-- becomes a two-step submit-then-approve flow: submitting moves
-- `OPEN` -> `PENDING_APPROVAL` with the now-known cost recorded but no
-- GL posting yet; a separate approve call is what actually posts
-- `fleet.maintenance_completed.v1` and finalizes to `COMPLETED`.
-- `request_status` itself tracks this (no fulfillment/approval split the
-- way a PO has — nothing else about a maintenance request has an
-- independent lifecycle), same reasoning as journal_entries.status.
ALTER TABLE maintenance_requests DROP CONSTRAINT maintenance_requests_request_status_check;
ALTER TABLE maintenance_requests ADD CONSTRAINT maintenance_requests_request_status_check
    CHECK (request_status IN ('OPEN', 'PENDING_APPROVAL', 'COMPLETED', 'REJECTED'));

ALTER TABLE maintenance_requests ADD COLUMN current_approval_stage int NOT NULL DEFAULT 1;
ALTER TABLE maintenance_requests ADD COLUMN pending_approver_role_id uuid;

-- Existing COMPLETED rows predate this workflow entirely (completed and
-- posted in one atomic step, no approval ever sought) — left as
-- COMPLETED, which the CHECK constraint above still allows; not
-- backfilled into PENDING_APPROVAL, which would misrepresent history.
