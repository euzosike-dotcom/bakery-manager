-- Development seed data for the Governance & Master Data vertical slice.
-- Reuses the roles already seeded in dev_seed.sql (Slice #1) rather than
-- inventing new ones — see that file's ID reference comment for
-- STORES_CLERK / PROCUREMENT_MGR / FINANCE_CONTROLLER role_ids.
--
-- Run as the postgres superuser role (bypasses RLS regardless of FORCE).

-- Two-tier approval routing for Procurement Purchase Orders: below
-- 500,000 a Procurement Manager can approve alone; at or above it,
-- Finance Controller sign-off is required. Demonstrates the
-- `approval_matrix` threshold-routing shape (docs/SDD.md §4.2) — enforced
-- by governance-service's AuthorizationService.checkApprovalAuthority and
-- wired into procurement-service's PO approve/reject endpoints (see
-- docs/RUNBOOK.md's "Approval-matrix enforcement" section); this master
-- data is what that check actually resolves against, not decorative.
INSERT INTO approval_matrix (tenant_id, module_name, transaction_type, threshold_min, threshold_max, approval_level_1_role_id)
VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'PROCUREMENT', 'PURCHASE_ORDER', 0, 500000, '1a946225-e283-4bbe-9c05-939dff09a1cf'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'PROCUREMENT', 'PURCHASE_ORDER', 500000, NULL, '5ee22c8f-d7fa-4f40-9814-744412c5fcde');

INSERT INTO reason_codes (tenant_id, reason_code, reason_group, description)
VALUES
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'UNAUTHORIZED_POSTING_ATTEMPT', 'SECURITY',
     'A user without posting authority (roles.can_post = false) attempted a posting action directly — logged automatically, not user-supplied.'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'GRN_OVER_RECEIPT_OVERRIDE', 'PROCUREMENT',
     'Manual override of an over-receipt block on a goods receipt line.'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'MANUAL_ADJUSTMENT', 'FINANCE',
     'General-purpose reason for a manual correction with no more specific code.'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'INSUFFICIENT_APPROVAL_TIER', 'SECURITY',
     'A user with real approval authority attempted to approve a transaction above their approval_matrix threshold tier (e.g. a Procurement Manager approving a PO that requires Finance Controller sign-off) — logged automatically, not user-supplied.'),
    ('b17d9226-2a43-43eb-8c5e-a923637b23c5', 'NO_APPROVAL_MATRIX_CONFIGURED', 'SECURITY',
     'An approval was attempted for a module/transaction_type/amount with no matching approval_matrix band — fails closed (denied) rather than silently allowing, since this is a configuration gap, not a legitimate no-approval-needed case.');
