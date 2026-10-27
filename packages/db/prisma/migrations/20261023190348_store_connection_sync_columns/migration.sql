-- PrestaShop poll columns on store_connection.
-- prisma migrate dev --create-only emitted one ALTER TABLE with these four
-- ADD COLUMN clauses and no DROP, RLS, grant, or index statement.
-- Rewritten as four statements. Partial unique indexes stay.
ALTER TABLE "store_connection" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "store_connection" ADD COLUMN "last_error_class" TEXT;
ALTER TABLE "store_connection" ADD COLUMN "last_error_at" TIMESTAMPTZ(6);
ALTER TABLE "store_connection" ADD COLUMN "sync_locked_until" TIMESTAMPTZ(6);
