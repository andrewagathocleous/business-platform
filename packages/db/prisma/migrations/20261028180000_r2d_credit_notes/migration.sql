-- R2-D: credit notes against issued invoices, and quotes converted to invoices.
-- Generated with `prisma migrate diff`; the CHECKs, the partial unique index and the triggers
-- below the Prisma part are hand-written.

ALTER TABLE "invoice" ADD COLUMN "credit_reason" TEXT,
ADD COLUMN "credited_invoice_id" UUID,
ADD COLUMN "source_quote_id" UUID;

ALTER TABLE "invoice_line" ADD COLUMN "credited_line_id" UUID;

CREATE UNIQUE INDEX "invoice_line_company_id_id_key" ON "invoice_line"("company_id", "id");

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_credited_invoice_id_fkey" FOREIGN KEY ("company_id", "credited_invoice_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_source_quote_id_fkey" FOREIGN KEY ("company_id", "source_quote_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_company_id_credited_line_id_fkey" FOREIGN KEY ("company_id", "credited_line_id") REFERENCES "invoice_line"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A credit note always names the invoice it credits and why; nothing else has either.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_credit_note_check" CHECK (
  (("document_type" = 'credit_note') = ("credited_invoice_id" IS NOT NULL))
  AND ("document_type" <> 'credit_note' OR coalesce("credit_reason", '') ~ '[^[:space:]]')
  AND ("credit_reason" IS NULL OR "document_type" = 'credit_note')
);

-- Only an invoice comes from a quote, and a quote converts once.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_source_quote_check"
  CHECK ("source_quote_id" IS NULL OR "document_type" = 'invoice');
CREATE UNIQUE INDEX "invoice_company_source_quote_key"
  ON "invoice" ("company_id", "source_quote_id")
  WHERE "source_quote_id" IS NOT NULL;

-- A credit note credits an issued invoice; a converted invoice comes from a quote. Neither
-- link, nor a document's type, ever changes (so a converted quote stays a quote). The
-- referenced rows are visible: same company, under the caller's RLS.
CREATE OR REPLACE FUNCTION invoice_credit_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.credited_invoice_id IS DISTINCT FROM OLD.credited_invoice_id
       OR NEW.source_quote_id IS DISTINCT FROM OLD.source_quote_id
       OR NEW.document_type IS DISTINCT FROM OLD.document_type THEN
      RAISE EXCEPTION 'a document''s type, credited invoice and source quote never change'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.credited_invoice_id IS NOT NULL THEN
    PERFORM 1 FROM invoice
    WHERE company_id = NEW.company_id
      AND id = NEW.credited_invoice_id
      AND document_type = 'invoice'
      AND status = 'issued';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a credit note credits an issued invoice'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.source_quote_id IS NOT NULL THEN
    PERFORM 1 FROM invoice
    WHERE company_id = NEW.company_id AND id = NEW.source_quote_id AND document_type = 'quote';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an invoice is converted from a quote'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_credit_guard
  BEFORE INSERT OR UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION invoice_credit_guard();

-- Every line of a credit note credits a line of the invoice the credit note credits, at that
-- line's kind, prices, discount, tax code and rate, and keeps that line; no other line
-- credits anything.
CREATE OR REPLACE FUNCTION invoice_line_credit_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_type invoice_document_type;
  parent_credits uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.credited_line_id IS DISTINCT FROM OLD.credited_line_id THEN
    RAISE EXCEPTION 'a credit line keeps the line it credits'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT document_type, credited_invoice_id
  INTO parent_type, parent_credits
  FROM invoice
  WHERE company_id = NEW.company_id AND id = NEW.invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice parent is missing or not visible';
  END IF;
  IF parent_type = 'credit_note' THEN
    PERFORM 1 FROM invoice_line
    WHERE company_id = NEW.company_id
      AND id = NEW.credited_line_id
      AND invoice_id = parent_credits
      AND kind = NEW.kind
      AND unit_price = NEW.unit_price
      AND discount_percent = NEW.discount_percent
      AND tax_code_id = NEW.tax_code_id
      AND tax_rate_percent = NEW.tax_rate_percent;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a credit note line credits a line of the credited invoice, at its prices and rates'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.credited_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a credit note line credits another line'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_line_credit_guard
  BEFORE INSERT OR UPDATE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION invoice_line_credit_guard();
