-- R2-C2: an issued document is complete, and it is issued only from a draft, with its own
-- sealed PDF, lines and tax summary. invoice_issued_immutable already stops any change after.
-- "Not blank" means the text has a character that is not whitespace (btrim strips spaces only).

-- Everything the issued document shows, or is found by, is present. Quotes are never issued.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issued_complete_check" CHECK (
  "status" <> 'issued' OR (
    "document_type" <> 'quote'
    AND "series_id" IS NOT NULL
    AND "number" IS NOT NULL
    AND "number_seq" IS NOT NULL
    AND "issue_date" IS NOT NULL
    AND "due_date" IS NOT NULL
    AND "supply_date" IS NOT NULL
    AND "supply_date" <= "issue_date"
    AND "delivery_deadline" IS NOT NULL
    AND "render_version" IS NOT NULL
    AND "pdf_file_id" IS NOT NULL
    AND "issued_at" IS NOT NULL
    AND "issued_by" IS NOT NULL
    -- Seller: name, VAT number and an address with a street and a city (reg. 12(1)(δ)).
    AND jsonb_typeof("seller_snapshot") = 'object'
    AND coalesce("seller_snapshot" ->> 'legalName', '') ~ '[^[:space:]]'
    AND coalesce("seller_snapshot" ->> 'vatNumber', '') ~ '[^[:space:]]'
    AND jsonb_typeof("seller_snapshot" -> 'address') = 'object'
    AND coalesce("seller_snapshot" -> 'address' ->> 'line1', '') ~ '[^[:space:]]'
    AND coalesce("seller_snapshot" -> 'address' ->> 'city', '') ~ '[^[:space:]]'
    -- Buyer: name and an address with a street and a city (reg. 12(1)(ε)).
    AND jsonb_typeof("buyer_snapshot") = 'object'
    AND coalesce("buyer_snapshot" ->> 'displayName', '') ~ '[^[:space:]]'
    AND jsonb_typeof("buyer_snapshot" -> 'address') = 'object'
    AND coalesce("buyer_snapshot" -> 'address' ->> 'line1', '') ~ '[^[:space:]]'
    AND coalesce("buyer_snapshot" -> 'address' ->> 'city', '') ~ '[^[:space:]]'
    -- Bank details are optional; when present they name an IBAN.
    AND (
      "bank_snapshot" IS NULL
      OR (
        jsonb_typeof("bank_snapshot") = 'object'
        AND coalesce("bank_snapshot" ->> 'iban', '') ~ '[^[:space:]]'
      )
    )
  )
);

-- A document becomes issued only by leaving draft, with a sealed invoice PDF made for it and
-- complete lines and tax summary. Lines and summary rows change only under the invoice row
-- lock (invoice_lock_parent), which the issuing UPDATE holds. Rows are visible here: same
-- company, under the caller's RLS.
CREATE OR REPLACE FUNCTION invoice_issue_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'issued' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'a document is issued from a draft, never inserted as issued'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'issued' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft can be issued'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM 1
  FROM stored_file
  WHERE company_id = NEW.company_id
    AND id = NEW.pdf_file_id
    AND sealed
    AND kind = 'invoice_pdf'
    AND source_type = 'invoice'
    AND source_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an issued document needs its own sealed PDF'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoice_line WHERE company_id = NEW.company_id AND invoice_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM invoice_line
    WHERE company_id = NEW.company_id
      AND invoice_id = NEW.id
      AND (jsonb_typeof(tax_snapshot) IS DISTINCT FROM 'object' OR description !~ '[^[:space:]]')
  ) THEN
    RAISE EXCEPTION 'an issued document needs lines, each with a description and its tax snapshot'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoice_tax_summary WHERE company_id = NEW.company_id AND invoice_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM invoice_tax_summary
    WHERE company_id = NEW.company_id
      AND invoice_id = NEW.id
      AND jsonb_typeof(tax_snapshot) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'an issued document needs its tax summary, each row with its tax snapshot'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_issue_guard
  BEFORE INSERT OR UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION invoice_issue_guard();
