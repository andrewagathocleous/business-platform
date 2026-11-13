-- R2-E1: payments, allocations, refunds and company-scoped idempotency records.
-- Generated with `prisma migrate diff`; RLS, grants, CHECKs and guards below the Prisma
-- part are hand-written. Current usage is guarded here; as-of dates are domain arithmetic.

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('bank_transfer', 'card', 'cash', 'store', 'other');

-- CreateEnum
CREATE TYPE "payment_record_status" AS ENUM ('recorded', 'voided');

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "received_on" DATE NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" "payment_record_status" NOT NULL DEFAULT 'recorded',
    "voided_on" DATE,
    "void_reason" TEXT,
    "created_by" UUID NOT NULL,
    "voided_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "payment_id" UUID,
    "credit_note_id" UUID,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "effective_on" DATE NOT NULL,
    "reversed_on" DATE,
    "reversal_reason" TEXT,
    "created_by" UUID NOT NULL,
    "reversed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "payment_id" UUID,
    "credit_note_id" UUID,
    "amount" DECIMAL(19,2) NOT NULL,
    "refunded_on" DATE NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" "payment_record_status" NOT NULL DEFAULT 'recorded',
    "voided_on" DATE,
    "void_reason" TEXT,
    "created_by" UUID NOT NULL,
    "voided_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_company_id_client_id_idx" ON "payment"("company_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_company_id_id_key" ON "payment"("company_id", "id");

-- CreateIndex
CREATE INDEX "allocation_company_id_invoice_id_idx" ON "allocation"("company_id", "invoice_id");

-- CreateIndex
CREATE INDEX "allocation_company_id_payment_id_idx" ON "allocation"("company_id", "payment_id");

-- CreateIndex
CREATE INDEX "allocation_company_id_credit_note_id_idx" ON "allocation"("company_id", "credit_note_id");

-- CreateIndex
CREATE INDEX "refund_company_id_payment_id_idx" ON "refund"("company_id", "payment_id");

-- CreateIndex
CREATE INDEX "refund_company_id_credit_note_id_idx" ON "refund"("company_id", "credit_note_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_company_id_operation_key_key" ON "idempotency_record"("company_id", "operation", "key");

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_company_id_client_id_fkey" FOREIGN KEY ("company_id", "client_id") REFERENCES "client"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "payment"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_company_id_credit_note_id_fkey" FOREIGN KEY ("company_id", "credit_note_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_reversed_by_fkey" FOREIGN KEY ("reversed_by") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "payment"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_company_id_credit_note_id_fkey" FOREIGN KEY ("company_id", "credit_note_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every financial row and retry record is isolated to the current company, even for its owner.
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment
  USING (company_id = app_current_company()) WITH CHECK (company_id = app_current_company());
ALTER TABLE allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON allocation
  USING (company_id = app_current_company()) WITH CHECK (company_id = app_current_company());
ALTER TABLE refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refund
  USING (company_id = app_current_company()) WITH CHECK (company_id = app_current_company());
ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_record
  USING (company_id = app_current_company()) WITH CHECK (company_id = app_current_company());

-- Financial history is reversed or voided, never deleted. Retry results are append-only.
REVOKE DELETE ON TABLE payment, allocation, refund FROM bp_app;
REVOKE UPDATE, DELETE ON TABLE idempotency_record FROM bp_app;

-- Positive amounts, currency codes and exactly one source, regardless of the writer.
ALTER TABLE payment ADD CONSTRAINT payment_amount_check CHECK (amount > 0 AND amount <> 'NaN');
ALTER TABLE payment ADD CONSTRAINT payment_currency_check CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE allocation ADD CONSTRAINT allocation_amount_check CHECK (amount > 0 AND amount <> 'NaN');
ALTER TABLE refund ADD CONSTRAINT refund_amount_check CHECK (amount > 0 AND amount <> 'NaN');
ALTER TABLE allocation ADD CONSTRAINT allocation_source_check
  CHECK ((payment_id IS NULL) <> (credit_note_id IS NULL));
ALTER TABLE refund ADD CONSTRAINT refund_source_check
  CHECK ((payment_id IS NULL) <> (credit_note_id IS NULL));

-- A void records a reason and cannot precede the money record it voids.
ALTER TABLE payment ADD CONSTRAINT payment_void_check CHECK (
  (status = 'voided') = (voided_on IS NOT NULL)
  AND (status <> 'recorded' OR (voided_on IS NULL AND void_reason IS NULL AND voided_by IS NULL))
  AND (status <> 'voided' OR coalesce(void_reason, '') ~ '[^[:space:]]')
  AND (voided_on IS NULL OR voided_on >= received_on)
);
ALTER TABLE refund ADD CONSTRAINT refund_void_check CHECK (
  (status = 'voided') = (voided_on IS NOT NULL)
  AND (status <> 'recorded' OR (voided_on IS NULL AND void_reason IS NULL AND voided_by IS NULL))
  AND (status <> 'voided' OR coalesce(void_reason, '') ~ '[^[:space:]]')
  AND (voided_on IS NULL OR voided_on >= refunded_on)
);

-- Reversal dates and reasons come together; the optional actor is set only on reversal.
-- A reversal never predates its allocation.
ALTER TABLE allocation ADD CONSTRAINT allocation_reversal_check CHECK (
  (reversed_on IS NULL) = (reversal_reason IS NULL)
  AND (reversed_on IS NOT NULL OR reversed_by IS NULL)
  AND (reversal_reason IS NULL OR reversal_reason ~ '[^[:space:]]')
  AND (reversed_on IS NULL OR reversed_on >= effective_on)
);

-- Bound retry keys and reject blank operation names.
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_key_check
  CHECK (char_length(key) BETWEEN 1 AND 200);
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_operation_check
  CHECK (operation ~ '[^[:space:]]');

-- TRUNCATE skips row guards. No role can erase financial history that way either.
CREATE TRIGGER payment_no_truncate BEFORE TRUNCATE ON payment
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
CREATE TRIGGER allocation_no_truncate BEFORE TRUNCATE ON allocation
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
CREATE TRIGGER refund_no_truncate BEFORE TRUNCATE ON refund
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

-- A payment keeps its financial particulars, and voiding first settles its active uses.
CREATE OR REPLACE FUNCTION payment_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF ROW(NEW.id, NEW.company_id, NEW.client_id, NEW.received_on, NEW.amount,
         NEW.currency, NEW.method, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.company_id, OLD.client_id, OLD.received_on, OLD.amount,
         OLD.currency, OLD.method, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a payment keeps its financial particulars'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'voided' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a voided payment is never recorded again'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'voided'
     AND ROW(NEW.voided_on, NEW.void_reason, NEW.voided_by)
         IS DISTINCT FROM ROW(OLD.voided_on, OLD.void_reason, OLD.voided_by) THEN
    RAISE EXCEPTION 'a voided payment keeps its void date, reason and actor'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'recorded' AND NEW.status = 'voided' THEN
    IF EXISTS (SELECT 1 FROM allocation
               WHERE company_id = OLD.company_id AND payment_id = OLD.id
                 AND reversed_on IS NULL) THEN
      RAISE EXCEPTION 'a payment with an active allocation cannot be voided'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM refund
               WHERE company_id = OLD.company_id AND payment_id = OLD.id
                 AND status = 'recorded') THEN
      RAISE EXCEPTION 'a payment with an active refund cannot be voided'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_guard BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION payment_guard();

-- An allocation is reversed once. Inserts lock payment first, then source and target
-- documents together by id, and check current source usage and target settlement.
CREATE OR REPLACE FUNCTION allocation_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_payment payment%ROWTYPE;
  source_credit invoice%ROWTYPE;
  target invoice%ROWTYPE;
  source_amount numeric;
  source_date date;
  source_client uuid;
  source_currency text;
  allocated numeric;
  refunded numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an allocation is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['reversed_on', 'reversal_reason', 'reversed_by'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['reversed_on', 'reversal_reason', 'reversed_by']) THEN
      RAISE EXCEPTION 'an allocation is immutable except for its reversal'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.reversed_on IS NOT NULL OR OLD.reversal_reason IS NOT NULL
       OR OLD.reversed_by IS NOT NULL OR NEW.reversed_on IS NULL THEN
      RAISE EXCEPTION 'an allocation is reversed only once and never un-reversed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.payment_id IS NOT NULL THEN
    SELECT * INTO source_payment FROM payment
    WHERE company_id = NEW.company_id AND id = NEW.payment_id FOR UPDATE;
    IF NOT FOUND OR source_payment.status <> 'recorded' THEN
      RAISE EXCEPTION 'an allocation source must be a recorded payment'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    source_amount := source_payment.amount;
    source_date := source_payment.received_on;
    source_client := source_payment.client_id;
    source_currency := source_payment.currency;
  END IF;
  PERFORM 1 FROM invoice
  WHERE company_id = NEW.company_id AND id IN (NEW.credit_note_id, NEW.invoice_id)
  ORDER BY id FOR UPDATE;
  SELECT * INTO target FROM invoice
  WHERE company_id = NEW.company_id AND id = NEW.invoice_id;
  IF NOT FOUND OR target.document_type <> 'invoice' OR target.status <> 'issued' THEN
    RAISE EXCEPTION 'an allocation target must be an issued invoice'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.payment_id IS NULL THEN
    SELECT * INTO source_credit FROM invoice
    WHERE company_id = NEW.company_id AND id = NEW.credit_note_id;
    IF NOT FOUND OR source_credit.document_type <> 'credit_note' OR source_credit.status <> 'issued' THEN
      RAISE EXCEPTION 'an allocation source must be an issued credit note'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    source_amount := source_credit.total;
    source_date := source_credit.issue_date;
    source_client := source_credit.client_id;
    source_currency := source_credit.currency;
  END IF;
  IF source_amount = 'NaN' OR target.total = 'NaN' THEN
    RAISE EXCEPTION 'an allocation source amount and target total must not be NaN'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF source_client <> target.client_id THEN
    RAISE EXCEPTION 'an allocation source and target must have the same client'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF source_currency <> target.currency THEN
    RAISE EXCEPTION 'an allocation source and target must have the same currency'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.effective_on < source_date OR NEW.effective_on < target.issue_date THEN
    RAISE EXCEPTION 'an allocation effective date cannot precede its source or invoice date'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO allocated FROM allocation
  WHERE company_id = NEW.company_id AND reversed_on IS NULL
    AND ((NEW.payment_id IS NOT NULL AND payment_id = NEW.payment_id)
      OR (NEW.credit_note_id IS NOT NULL AND credit_note_id = NEW.credit_note_id));
  SELECT coalesce(sum(amount), 0) INTO refunded FROM refund
  WHERE company_id = NEW.company_id AND status = 'recorded'
    AND ((NEW.payment_id IS NOT NULL AND payment_id = NEW.payment_id)
      OR (NEW.credit_note_id IS NOT NULL AND credit_note_id = NEW.credit_note_id));
  IF allocated + refunded + NEW.amount > source_amount THEN
    RAISE EXCEPTION 'active allocations and refunds exceed the source amount'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO allocated FROM allocation
  WHERE company_id = NEW.company_id AND invoice_id = NEW.invoice_id AND reversed_on IS NULL;
  IF allocated + NEW.amount > target.total THEN
    RAISE EXCEPTION 'active allocations exceed the invoice total'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON allocation
  FOR EACH ROW EXECUTE FUNCTION allocation_guard();

-- A refund is voided once and never otherwise edited. Inserts share the source lock
-- with allocations and payment voids, so concurrent uses cannot spend the same credit.
CREATE OR REPLACE FUNCTION refund_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_payment payment%ROWTYPE;
  source_credit invoice%ROWTYPE;
  source_amount numeric;
  source_date date;
  allocated numeric;
  refunded numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a refund is never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'voided_on', 'void_reason', 'voided_by', 'version'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'voided_on', 'void_reason', 'voided_by', 'version']) THEN
      RAISE EXCEPTION 'a refund is immutable except for its void'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status <> 'recorded' OR NEW.status <> 'voided' THEN
      RAISE EXCEPTION 'a refund is only voided once and never recorded again'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.payment_id IS NOT NULL THEN
    SELECT * INTO source_payment FROM payment
    WHERE company_id = NEW.company_id AND id = NEW.payment_id FOR UPDATE;
    IF NOT FOUND OR source_payment.status <> 'recorded' THEN
      RAISE EXCEPTION 'a refund source must be a recorded payment'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    source_amount := source_payment.amount;
    source_date := source_payment.received_on;
  ELSE
    PERFORM 1 FROM invoice
    WHERE company_id = NEW.company_id AND id IN (NEW.credit_note_id)
    ORDER BY id FOR UPDATE;
    SELECT * INTO source_credit FROM invoice
    WHERE company_id = NEW.company_id AND id = NEW.credit_note_id;
    IF NOT FOUND OR source_credit.document_type <> 'credit_note' OR source_credit.status <> 'issued' THEN
      RAISE EXCEPTION 'a refund source must be an issued credit note'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    source_amount := source_credit.total;
    source_date := source_credit.issue_date;
  END IF;
  IF source_amount = 'NaN' THEN
    RAISE EXCEPTION 'a refund source amount must not be NaN'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.refunded_on < source_date THEN
    RAISE EXCEPTION 'a refund date cannot precede its source date'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO allocated FROM allocation
  WHERE company_id = NEW.company_id AND reversed_on IS NULL
    AND ((NEW.payment_id IS NOT NULL AND payment_id = NEW.payment_id)
      OR (NEW.credit_note_id IS NOT NULL AND credit_note_id = NEW.credit_note_id));
  SELECT coalesce(sum(amount), 0) INTO refunded FROM refund
  WHERE company_id = NEW.company_id AND status = 'recorded'
    AND ((NEW.payment_id IS NOT NULL AND payment_id = NEW.payment_id)
      OR (NEW.credit_note_id IS NOT NULL AND credit_note_id = NEW.credit_note_id));
  IF allocated + refunded + NEW.amount > source_amount THEN
    RAISE EXCEPTION 'active allocations and refunds exceed the source amount'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refund_guard BEFORE INSERT OR UPDATE OR DELETE ON refund
  FOR EACH ROW EXECUTE FUNCTION refund_guard();
