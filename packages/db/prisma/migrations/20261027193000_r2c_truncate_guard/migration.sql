-- R2-C1: TRUNCATE skips row triggers, so it would get past stored_file_sealed_guard and
-- invoice_issued_immutable. These tables hold issued documents, their PDFs and delivery
-- evidence, so no role truncates them, directly or through CASCADE. A restore loads an
-- empty database with pg_restore and never truncates.

CREATE OR REPLACE FUNCTION refuse_truncate() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is never truncated: it holds issued documents or their evidence', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER stored_file_no_truncate
  BEFORE TRUNCATE ON "stored_file"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER invoice_no_truncate
  BEFORE TRUNCATE ON "invoice"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER invoice_line_no_truncate
  BEFORE TRUNCATE ON "invoice_line"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER invoice_tax_summary_no_truncate
  BEFORE TRUNCATE ON "invoice_tax_summary"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER invoice_delivery_no_truncate
  BEFORE TRUNCATE ON "invoice_delivery"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
