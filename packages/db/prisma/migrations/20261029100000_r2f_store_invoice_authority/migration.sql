-- R2-F: guards only; order-to-invoice conversion comes with R2-02.
-- `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- returned an empty migration. These partial-index and trigger guards are hand-written.

CREATE UNIQUE INDEX "invoice_company_source_order_key"
  ON "invoice" ("company_id", "source_order_id")
  WHERE "source_order_id" IS NOT NULL
    AND "document_type" = 'invoice'
    AND "status" <> 'cancelled';

-- The caller's tenant context applies to the same-company order and invoice lookup.
-- This trigger runs for every role, including the table owner.
CREATE OR REPLACE FUNCTION store_invoice_authority_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.invoice_authority = 'platform'
     AND NEW.invoice_authority IS DISTINCT FROM OLD.invoice_authority
     AND EXISTS (
       SELECT 1 FROM invoice i
       JOIN sales_order o ON o.company_id = i.company_id AND o.id = i.source_order_id
       WHERE o.company_id = OLD.company_id AND o.store_id = OLD.id
         AND i.document_type = 'invoice' AND i.status = 'issued'
     ) THEN
    RAISE EXCEPTION 'authority_locked'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER store_invoice_authority_guard
  BEFORE UPDATE ON "store"
  FOR EACH ROW EXECUTE FUNCTION store_invoice_authority_guard();

-- Keep the store that gives an order-linked document its invoice authority.
-- Every document type and status counts, and the guard applies to every role.
CREATE OR REPLACE FUNCTION sales_order_store_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id
     AND EXISTS (
       SELECT 1 FROM invoice
       WHERE company_id = OLD.company_id AND source_order_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'order_store_locked'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_store_guard
  BEFORE UPDATE ON "sales_order"
  FOR EACH ROW EXECUTE FUNCTION sales_order_store_guard();
