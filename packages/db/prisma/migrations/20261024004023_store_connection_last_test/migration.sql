-- Settings test result on store_connection.
-- prisma migrate dev --create-only emitted one ALTER TABLE with these two
-- ADD COLUMN clauses and no DROP, RLS, grant, or index statement.
-- Rewritten as two statements. Partial unique indexes stay.
ALTER TABLE "store_connection" ADD COLUMN "last_test_at" TIMESTAMPTZ(6);
ALTER TABLE "store_connection" ADD COLUMN "last_test_result" TEXT;
