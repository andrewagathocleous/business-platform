-- Client CSV previews. Actors are global user accounts; no tenant object is referenced.
CREATE TYPE client_import_status AS ENUM ('previewed', 'applied', 'expired');
CREATE TABLE client_import (
  id UUID NOT NULL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES company(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status client_import_status NOT NULL DEFAULT 'previewed',
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 0 AND 5000),
  rows JSONB NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  created_by UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by UUID REFERENCES user_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  applied_at TIMESTAMPTZ(6),
  applied_count INTEGER,
  CONSTRAINT client_import_applied_check CHECK (
    (status = 'applied' AND applied_by IS NOT NULL AND applied_at IS NOT NULL
      AND applied_count IS NOT NULL AND applied_count BETWEEN 0 AND row_count)
    OR (status <> 'applied' AND applied_by IS NULL AND applied_at IS NULL AND applied_count IS NULL)
  )
);
CREATE UNIQUE INDEX client_import_company_id_id_key ON client_import(company_id, id);
ALTER TABLE client_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_import
  USING (company_id = app_current_company()) WITH CHECK (company_id = app_current_company());
GRANT SELECT, INSERT, UPDATE ON client_import TO bp_app;
REVOKE DELETE, TRUNCATE ON client_import FROM bp_app;
