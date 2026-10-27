-- Row-level security, grants, partial unique indexes and immutability triggers.
-- Runs after the Prisma-generated tables. Company-scoped tables are listed explicitly
-- so a missing entry is visible in review; the integration test also fails if a new
-- company_id table is neither enforced nor listed as an exemption in packages/db.

CREATE OR REPLACE FUNCTION app_current_company() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid
$$;

-- NULL scope_id means company scope. A plain UNIQUE would allow duplicate company-wide
-- assignments because PostgreSQL treats NULLs as distinct.
CREATE UNIQUE INDEX membership_role_assignment_key
  ON membership_role (
    membership_id,
    role_id,
    scope_type,
    (COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

ALTER TABLE membership_role
  ADD CONSTRAINT membership_role_scope_check
  CHECK (
    (scope_type = 'company' AND scope_id IS NULL)
    OR (scope_type <> 'company' AND scope_id IS NOT NULL)
  );

CREATE UNIQUE INDEX automation_switch_company_key
  ON automation_switch ((COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid)), key);

CREATE UNIQUE INDEX product_company_sku_key
  ON product (company_id, sku)
  WHERE sku IS NOT NULL;

CREATE UNIQUE INDEX invoice_company_series_number_key
  ON invoice (company_id, series_id, number_seq)
  WHERE number_seq IS NOT NULL;

-- source_version is recorded on the job but is not part of this key.
-- An unrelated order change must not allow a second first print.
CREATE UNIQUE INDEX print_job_one_first_print_key
  ON print_job (company_id, source_type, source_id, document_type)
  WHERE is_reprint = false
    AND status NOT IN ('failed', 'cancelled', 'not_printed');

DO $$
DECLARE
  table_name text;
  rls_tables text[] := ARRAY[
    'audit_event',
    'brand',
    'client',
    'client_address',
    'client_contact',
    'company_bank_account',
    'gift_message_template',
    'integration_credential',
    'integration_inbox',
    'invoice',
    'invoice_line',
    'invoice_series',
    'invoice_tax_summary',
    'location',
    'order_note',
    'print_job',
    'printer',
    'printer_mapping',
    'product',
    'sales_order',
    'sales_order_line',
    'store',
    'store_connection',
    'stored_file',
    'tax_code'
  ];
BEGIN
  FOREACH table_name IN ARRAY rls_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name <> 'audit_event' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (company_id = app_current_company()) WITH CHECK (company_id = app_current_company())',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

CREATE POLICY audit_event_select ON audit_event
  FOR SELECT
  USING (
    company_id = app_current_company()
    OR (
      company_id IS NULL
      AND current_setting('app.platform_scope', true) = 'on'
    )
  );

CREATE POLICY audit_event_insert ON audit_event
  FOR INSERT
  WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO bp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bp_app;
REVOKE UPDATE, DELETE ON TABLE audit_event FROM bp_app;

CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END;
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW
  EXECUTE FUNCTION audit_event_immutable();

-- Phase 3 will name the receivables columns that stay editable after issuance.
-- Until those columns exist, an issued invoice and its lines and tax summary are fully immutable.
-- Child INSERT is blocked when the target invoice is issued.
-- Child UPDATE is blocked when the old or the new parent is issued, so a line cannot be moved onto or off an issued invoice.
-- The parent lookup locks the invoice row first. A concurrent draft→issued update holds that row
-- lock, so the child statement waits and then sees the committed status. A move locks both
-- parents in id order. NOT FOUND means the parent is missing or hidden by RLS.
CREATE OR REPLACE FUNCTION invoice_lock_parent(parent_id uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status invoice_status;
BEGIN
  SELECT status
  INTO parent_status
  FROM invoice
  WHERE id = parent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice parent is missing or not visible';
  END IF;

  IF parent_status = 'issued' THEN
    RAISE EXCEPTION 'issued invoice is immutable';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION invoice_issued_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'invoice' THEN
    IF TG_OP <> 'INSERT' AND OLD.status = 'issued' THEN
      RAISE EXCEPTION 'issued invoice is immutable';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM invoice_lock_parent(NEW.invoice_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM invoice_lock_parent(OLD.invoice_id);
  ELSIF OLD.invoice_id = NEW.invoice_id THEN
    PERFORM invoice_lock_parent(OLD.invoice_id);
  ELSIF OLD.invoice_id < NEW.invoice_id THEN
    PERFORM invoice_lock_parent(OLD.invoice_id);
    PERFORM invoice_lock_parent(NEW.invoice_id);
  ELSE
    PERFORM invoice_lock_parent(NEW.invoice_id);
    PERFORM invoice_lock_parent(OLD.invoice_id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_issued_immutable
  BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW
  EXECUTE FUNCTION invoice_issued_immutable();

CREATE TRIGGER invoice_line_issued_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW
  EXECUTE FUNCTION invoice_issued_immutable();

CREATE TRIGGER invoice_tax_summary_issued_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_tax_summary
  FOR EACH ROW
  EXECUTE FUNCTION invoice_issued_immutable();
