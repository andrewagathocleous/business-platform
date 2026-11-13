-- R2-C3c: a caller's request key makes a print request safe to send again after a lost answer.
-- It is kept apart from idempotency_key, which stays unique per job for the print provider.

ALTER TABLE "print_job" ADD COLUMN "request_key" UUID,
ADD COLUMN "request_hash" TEXT;

-- One job per key in a company. Rows without a key (orders, older jobs) are not compared.
CREATE UNIQUE INDEX "print_job_company_request_key"
  ON "print_job" ("company_id", "request_key")
  WHERE "request_key" IS NOT NULL;

-- A key always comes with the fingerprint of the request it belongs to.
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_request_key_hash_check"
  CHECK (("request_key" IS NULL) = ("request_hash" IS NULL));
