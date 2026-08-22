-- Extends approval_matrix amount-based routing (docs/SDD.md §4.2) beyond
-- Procurement POs (migration 004) to manual journal entries — the one
-- financial posting in this platform not mediated by an async domain
-- event (see journals.service.ts's class doc comment), so it is the
-- cleanest analogue to a PO: a single, discrete, before-it-posts amount
-- proposed by one person, decided by another. Unlike a PO, a journal
-- entry row IS the ledger itself — reports.service.ts sums journal_lines
-- directly — so the entry cannot exist as `POSTED` while still awaiting
-- approval the way a PO can sit `po_status = OPEN` while
-- `approval_status = PENDING` (a PO's fulfillment and approval are
-- independent concerns; a journal entry's are not). `status` itself is
-- therefore what tracks approval state here, extended with
-- `PENDING_APPROVAL` (the new default) and `REJECTED`, rather than a
-- second, redundant column duplicating what `status` already means for
-- this table.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_status_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_status_check
    CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED', 'REVERSED'));
ALTER TABLE journal_entries ALTER COLUMN status SET DEFAULT 'PENDING_APPROVAL';

ALTER TABLE journal_entries ADD COLUMN current_approval_stage int NOT NULL DEFAULT 1;
ALTER TABLE journal_entries ADD COLUMN pending_approver_role_id uuid;

-- Existing rows were all created back when every manual entry posted
-- immediately and unconditionally — backfilling them into the new
-- pending-approval lifecycle would misrepresent history (they were never
-- actually pending anything). Left as POSTED, which the CHECK
-- constraint above still allows.

-- accounting_svc's grant (migration 015) was SELECT, INSERT only —
-- correct at the time, since a journal entry was never updated after
-- creation (created once, immediately POSTED, done). approve/reject
-- now update status/current_approval_stage/pending_approver_role_id,
-- so the role needs UPDATE too. Found the hard way: a live approve call
-- against this migration returned a real Postgres "permission denied
-- for table journal_entries" (42501), not caught by any typecheck or
-- unit test, since Phase 1-2's mocked tests stub Prisma entirely — only
-- a real database enforces real grants. journal_lines doesn't need
-- UPDATE — lines are immutable once written, only the parent entry's
-- own status/approval fields ever change.
GRANT UPDATE ON journal_entries TO accounting_svc;
