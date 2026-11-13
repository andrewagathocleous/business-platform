-- R2-C1: the foundation for issuing. Frozen copies (snapshots) on invoices, lines and tax
-- summaries; supply date and delivery deadline; the issued PDF; one number per company;
-- the append-only delivery record; and sealed stored files.
-- Generated with `prisma migrate diff`, because `migrate dev` stops for confirmation on the
-- new unique index. Hand-written below the Prisma part: RLS, grants, CHECKs and triggers.

CREATE TYPE "invoice_delivery_method" AS ENUM ('handed_over', 'posted', 'emailed_outside_platform', 'other');

ALTER TABLE "invoice" ADD COLUMN "bank_snapshot" JSONB,
ADD COLUMN "buyer_snapshot" JSONB,
ADD COLUMN "delivery_deadline" DATE,
ADD COLUMN "pdf_file_id" UUID,
ADD COLUMN "render_version" INTEGER,
ADD COLUMN "seller_snapshot" JSONB,
ADD COLUMN "supply_date" DATE,
ADD COLUMN "terms_snapshot" TEXT;

ALTER TABLE "invoice_line" ADD COLUMN "tax_snapshot" JSONB;

ALTER TABLE "invoice_tax_summary" ADD COLUMN "tax_snapshot" JSONB;

ALTER TABLE "stored_file" ADD COLUMN "sealed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "invoice_delivery" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "method" "invoice_delivery_method" NOT NULL,
    "delivered_on" DATE NOT NULL,
    "paper_copy_kept" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_delivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_delivery_company_id_invoice_id_idx" ON "invoice_delivery"("company_id", "invoice_id");

-- Numbers are unique per company across series. NULL (drafts) is not compared.
CREATE UNIQUE INDEX "invoice_company_id_number_key" ON "invoice"("company_id", "number");

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_pdf_file_id_fkey" FOREIGN KEY ("company_id", "pdf_file_id") REFERENCES "stored_file"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Company isolation, as for every other company table (20261018234900_rls).
ALTER TABLE "invoice_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_delivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_delivery"
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

-- A delivery record is evidence: the application adds and reads, never changes or removes.
REVOKE UPDATE, DELETE ON TABLE "invoice_delivery" FROM bp_app;

-- Handing over or posting a paper invoice keeps the company's printed copy (reg. 11Γ(4)).
ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_paper_copy_check"
  CHECK ("method" NOT IN ('handed_over', 'posted') OR "paper_copy_kept");

-- A sealed file never changes and is never deleted, by any role. Sealing is one way.
CREATE OR REPLACE FUNCTION stored_file_sealed_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.sealed THEN
    RAISE EXCEPTION 'a sealed stored file is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stored_file_sealed_guard
  BEFORE UPDATE OR DELETE ON "stored_file"
  FOR EACH ROW EXECUTE FUNCTION stored_file_sealed_guard();

-- Until sealed, a file row can still change. Issuing seals the PDF's row in the same
-- transaction that stores it on the document.
