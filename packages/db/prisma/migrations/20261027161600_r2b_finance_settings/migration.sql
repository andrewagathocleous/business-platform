-- R2-B: finance settings. Tax-code deadline rules and versions, series versions,
-- bank-account flags, company invoice terms and default series, and the
-- client's acceptance of electronic invoices.
-- prisma migrate dev --create-only emitted a DROP and ADD for is_default; it is
-- a RENAME here instead. The CHECK constraints and the partial unique index are
-- not modelled in schema.prisma.

CREATE TYPE "tax_deadline_rule" AS ENUM ('days_30', 'next_month_15');

ALTER TABLE "client" ADD COLUMN "accepts_e_invoices" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "company" ADD COLUMN "default_credit_note_series_id" UUID,
ADD COLUMN "default_invoice_series_id" UUID,
ADD COLUMN "default_quote_series_id" UUID,
ADD COLUMN "invoice_terms_el" TEXT,
ADD COLUMN "invoice_terms_en" TEXT;

ALTER TABLE "company_bank_account" RENAME COLUMN "is_default" TO "shown_on_invoices";
ALTER TABLE "company_bank_account" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "invoice_series" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "tax_code" ADD COLUMN "deadline_rule" "tax_deadline_rule" NOT NULL DEFAULT 'days_30',
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- A default series always belongs to the same company.
ALTER TABLE "company" ADD CONSTRAINT "company_id_default_invoice_series_id_fkey" FOREIGN KEY ("id", "default_invoice_series_id") REFERENCES "invoice_series"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "company" ADD CONSTRAINT "company_id_default_credit_note_series_id_fkey" FOREIGN KEY ("id", "default_credit_note_series_id") REFERENCES "invoice_series"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "company" ADD CONSTRAINT "company_id_default_quote_series_id_fkey" FOREIGN KEY ("id", "default_quote_series_id") REFERENCES "invoice_series"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- At most one account per company is shown on invoices, and only an active one.
CREATE UNIQUE INDEX "company_bank_account_one_shown_key"
  ON "company_bank_account" ("company_id")
  WHERE "shown_on_invoices";
ALTER TABLE "company_bank_account" ADD CONSTRAINT "company_bank_account_shown_active_check"
  CHECK (NOT "shown_on_invoices" OR "active");

ALTER TABLE "tax_code" ADD CONSTRAINT "tax_code_rate_percent_check"
  CHECK ("rate_percent" >= 0 AND "rate_percent" <= 100);

ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_next_number_check"
  CHECK ("next_number" >= 1);
ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_padding_check"
  CHECK ("padding" BETWEEN 1 AND 12);
