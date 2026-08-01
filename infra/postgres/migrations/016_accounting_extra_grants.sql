-- 015_accounting_rls_and_role.sql already ran (accounting_svc exists) before
-- it became clear accounting-service's grn.posted.v1 consumer needs to
-- resolve supplier_id and payment_terms for a vendor bill — the event
-- payload only carries po_line_id/plant_id (packages/contracts/events/
-- grn.posted.v1.schema.json), not supplier_id, so it must join
-- purchase_order_lines -> purchase_orders itself. Added as its own
-- migration rather than editing 015 in place, since that one has already
-- been applied.
GRANT SELECT ON purchase_orders, purchase_order_lines TO accounting_svc;
