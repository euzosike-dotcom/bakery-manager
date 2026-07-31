-- Governance & Master Data module (SDD §3.A)

CREATE TABLE plants (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    plant_id        uuid NOT NULL DEFAULT gen_random_uuid(),
    plant_code      text NOT NULL,
    plant_name      text NOT NULL,
    plant_type      text,
    plant_role      text,
    address         text,
    state           text,
    region          text,
    plant_status    text NOT NULL DEFAULT 'ACTIVE',
    capacity_kg_per_day numeric(14,2),
    supports_agent_sales        boolean NOT NULL DEFAULT false,
    supports_production         boolean NOT NULL DEFAULT true,
    supports_interplant_transfer boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, plant_id),
    UNIQUE (tenant_id, plant_code)
);

CREATE TABLE warehouses (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    warehouse_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    warehouse_code  text NOT NULL,
    warehouse_name  text NOT NULL,
    plant_id        uuid NOT NULL,
    warehouse_type  text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, warehouse_id),
    UNIQUE (tenant_id, warehouse_code),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE roles (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    role_id         uuid NOT NULL DEFAULT gen_random_uuid(),
    role_code       text NOT NULL,
    role_name       text NOT NULL,
    role_category   text,
    can_approve     boolean NOT NULL DEFAULT false,
    can_post        boolean NOT NULL DEFAULT false,
    can_override    boolean NOT NULL DEFAULT false,
    is_active       boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, role_id),
    UNIQUE (tenant_id, role_code)
);

CREATE TABLE users (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    user_id             uuid NOT NULL DEFAULT gen_random_uuid(),
    employee_code       text,
    full_name           text NOT NULL,
    email               citext NOT NULL,
    role_id             uuid,
    plant_id            uuid,
    department          text,
    user_status         text NOT NULL DEFAULT 'ACTIVE',
    mfa_enabled         boolean NOT NULL DEFAULT false,
    keycloak_subject_id text,
    last_login          timestamptz,
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE (tenant_id, email),
    FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, role_id),
    FOREIGN KEY (tenant_id, plant_id) REFERENCES plants(tenant_id, plant_id)
);

CREATE TABLE approval_matrix (
    tenant_id               uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    approval_matrix_id      uuid NOT NULL DEFAULT gen_random_uuid(),
    module_name             text NOT NULL,
    transaction_type        text NOT NULL,
    plant_id                uuid,
    threshold_min           numeric(14,2) NOT NULL DEFAULT 0,
    threshold_max           numeric(14,2),
    approval_level_1_role_id uuid,
    approval_level_2_role_id uuid,
    approval_level_3_role_id uuid,
    is_active               boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, approval_matrix_id)
);

CREATE TABLE reason_codes (
    tenant_id       uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    reason_code_id  uuid NOT NULL DEFAULT gen_random_uuid(),
    reason_code     text NOT NULL,
    reason_group    text NOT NULL,
    description     text,
    is_active       boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, reason_code_id),
    UNIQUE (tenant_id, reason_code)
);

-- Immutable, hash-chained audit trail (SDD §4.2)
CREATE TABLE audit_log (
    tenant_id           uuid NOT NULL REFERENCES tenant_registry(tenant_id),
    audit_log_id        uuid NOT NULL DEFAULT gen_random_uuid(),
    event_time          timestamptz NOT NULL DEFAULT now(),
    user_id             uuid,
    module_name         text NOT NULL,
    record_id_ref       text NOT NULL,
    action_type         text NOT NULL,
    old_value_snapshot  jsonb,
    new_value_snapshot  jsonb,
    ip_or_device        text,
    override_flag       boolean NOT NULL DEFAULT false,
    reason_code         text,
    prev_hash           text,
    record_hash         text NOT NULL,
    PRIMARY KEY (tenant_id, audit_log_id)
);

-- Audit log is append-only: no UPDATE, no DELETE, ever.
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
