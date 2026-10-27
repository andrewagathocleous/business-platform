-- One printer identity per company and provider.
-- Checked on the dev database before this migration: no duplicate
-- (company_id, provider, external_printer_id) rows, so no cleanup is required.
-- Does not drop RLS, grants, triggers, or the partial unique indexes.
CREATE UNIQUE INDEX "printer_company_id_provider_external_printer_id_key" ON "printer"("company_id", "provider", "external_printer_id");
