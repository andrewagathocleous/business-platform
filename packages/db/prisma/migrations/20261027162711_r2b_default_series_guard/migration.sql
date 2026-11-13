-- R2-B: Prisma cannot model a foreign key that reuses company.id, and drops keys it
-- does not model. So the default series are checked by triggers instead.

ALTER TABLE "company" DROP CONSTRAINT "company_id_default_credit_note_series_id_fkey";
ALTER TABLE "company" DROP CONSTRAINT "company_id_default_invoice_series_id_fkey";
ALTER TABLE "company" DROP CONSTRAINT "company_id_default_quote_series_id_fkey";

-- A default series is this company's series, of the matching document type.
-- Under RLS, bp_app sees only the series of the company in app.company_id, so a
-- series of another company is never found and the write fails.
CREATE OR REPLACE FUNCTION company_default_series_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT defaults.series_id, defaults.document_type
    FROM (VALUES
      (NEW.default_invoice_series_id, 'invoice'::invoice_document_type),
      (NEW.default_credit_note_series_id, 'credit_note'::invoice_document_type),
      (NEW.default_quote_series_id, 'quote'::invoice_document_type)
    ) AS defaults (series_id, document_type)
    WHERE defaults.series_id IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM invoice_series
      WHERE id = item.series_id
        AND company_id = NEW.id
        AND document_type = item.document_type
    ) THEN
      RAISE EXCEPTION 'a default series must be this company''s series of the same document type'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_default_series_guard
  BEFORE INSERT OR UPDATE OF default_invoice_series_id, default_credit_note_series_id, default_quote_series_id
  ON company
  FOR EACH ROW EXECUTE FUNCTION company_default_series_guard();

-- A series keeps its company and document type, and a default series is never deleted.
CREATE OR REPLACE FUNCTION invoice_series_default_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.company_id IS DISTINCT FROM NEW.company_id
      OR OLD.document_type IS DISTINCT FROM NEW.document_type THEN
      RAISE EXCEPTION 'a series keeps its company and document type'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM company
    WHERE OLD.id IN (default_invoice_series_id, default_credit_note_series_id, default_quote_series_id)
  ) THEN
    RAISE EXCEPTION 'a default series cannot be deleted'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER invoice_series_default_guard
  BEFORE UPDATE OF company_id, document_type OR DELETE
  ON invoice_series
  FOR EACH ROW EXECUTE FUNCTION invoice_series_default_guard();
