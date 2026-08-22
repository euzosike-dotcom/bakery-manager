-- Extends approval_matrix amount-based routing (docs/SDD.md §4.2, see
-- 022_accounting_approval_matrix.sql's header comment) to Manufacturing
-- — but in a DIFFERENT SHAPE than Procurement/Accounting/Fleet, because
-- the thing that would need gating (closing a production batch) is
-- offline-capturable and deliberately NOT posting-authority-gated today
-- (README "Known gaps": GRN receipt, batch close, sales order creation,
-- and fuel/trip/attendance capture are the offline-first field-capture
-- actions this platform never blocks on a synchronous online call —
-- gating them would require exactly that, breaking offline capture for
-- the operational staff who perform them). A high-cost batch therefore
-- cannot be gated BEFORE its GL postings happen the way a PO or journal
-- entry can — those postings already happened, unconditionally, the
-- moment the batch closed, exactly as before this migration.
--
-- What this adds instead is RETROSPECTIVE review, not a pre-posting
-- gate: `cost_review_status`, deliberately a SEPARATE column from the
-- existing `batch_status` (migration 008) — `batch_status` already
-- means something else (yield/recipe-version-approval driven,
-- `NEEDS_REVIEW` there means "no ledger postings happened at all"),
-- and conflating a second, unrelated reason into the same column would
-- make both harder to reason about. A batch's `cost_review_status`
-- moving through PENDING_APPROVAL/APPROVED/REJECTED never blocks or
-- undoes anything already posted; REJECTED means "flagged for
-- investigation," and any actual correction is a manual reversing
-- journal entry (accounting-service's existing manual-entry path),
-- exactly like every other correction in this ledger — not new logic
-- this migration needs to add.
--
-- `batch_cost` is a snapshot (`actual_output_qty * recipe_versions
-- .standard_cost` at close time), not a live recomputation — same
-- reproducibility reasoning `recipe_ingredients.unit_cost` already
-- documents (migration 008): a batch's own cost record should never
-- silently change because a recipe's current standard_cost changed
-- later.
ALTER TABLE production_batches ADD COLUMN batch_cost numeric(14,2);
ALTER TABLE production_batches ADD COLUMN cost_review_status text NOT NULL DEFAULT 'NOT_REQUIRED'
    CHECK (cost_review_status IN ('NOT_REQUIRED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'));
-- Single-band by design (see governance_seed.sql's MANUFACTURING/
-- BATCH_COST row) — only `current_approval_stage = 1` is ever reached,
-- kept for shape-consistency with the other three modules'
-- identically-named columns, not because Manufacturing needs
-- multi-tier escalation.
ALTER TABLE production_batches ADD COLUMN current_approval_stage int NOT NULL DEFAULT 1;
ALTER TABLE production_batches ADD COLUMN pending_approver_role_id uuid;

-- manufacturing-service needs to know, at batch-close time, whether the
-- computed batch_cost matches ANY configured approval_matrix band —
-- deliberately NOT via governance-service's checkApprovalAuthority
-- (packages/backend-common's PostingAuthorityClient), because that
-- call's contract is "throws or the caller may proceed" for a SPECIFIC
-- user's authority — batch close is performed by an operator who
-- essentially never holds approval authority, and (separately) most
-- batches fall below every band entirely, which checkApprovalAuthority
-- treats as "denied, fail closed" (see AuthorizationService's
-- NO_APPROVAL_MATRIX_CONFIGURED reason code), not "no review needed."
-- Neither behavior is what an unconditional, never-blocking, offline-
-- capturable action can tolerate. A plain read-only SELECT — the same
-- "read-only copy of another module's table" pattern this platform
-- already uses elsewhere (README "Known gaps") — sidesteps both
-- problems: it is pure data, not an authority decision, and manufacturing-
-- service is fully in control of what "no matching row" means (batch_cost
-- doesn't require review). The real authority decision still only ever
-- happens later, at actual approve/reject time, via the normal
-- checkApprovalAuthority path like every other module.
GRANT SELECT ON approval_matrix TO manufacturing_svc;
